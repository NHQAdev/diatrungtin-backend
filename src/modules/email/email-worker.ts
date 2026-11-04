import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import nodemailer from 'nodemailer';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 15_000;

type SendFn = (to: string, subject: string, text: string) => Promise<void>;

function createSender(env: Env, log: FastifyBaseLogger): SendFn {
  if (!env.SMTP_HOST) {
    // Local development: print the email instead of sending it.
    return async (to, subject, text) => {
      log.info({ to, subject }, `[email:dev] not sent (SMTP_HOST is empty)\n${text}`);
    };
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return async (to, subject, text) => {
    await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text });
  };
}

/** Sends one batch of pending emails. Safe to run on several servers at once (SKIP LOCKED). */
export async function sendPendingEmails(db: Db, send: SendFn, log: FastifyBaseLogger): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const batch = await trx
      .selectFrom('email_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('send_after', '<=', sql<Date>`now()`)
      .orderBy('id')
      .limit(BATCH_SIZE)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const email of batch) {
      try {
        await send(email.to_email, email.subject, email.body_text);
        await trx.updateTable('email_outbox').set({ status: 'sent', sent_at: sql`now()`, attempts: email.attempts + 1 }).where('id', '=', email.id).execute();
      } catch (error) {
        const attempts = email.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        log.warn({ err: error, emailId: email.id, attempts }, 'email send failed');
        await trx
          .updateTable('email_outbox')
          .set({
            attempts,
            last_error: String((error as Error).message).slice(0, 1000),
            status: giveUp ? 'failed' : 'pending',
            // Wait longer after each failure: 1, 4, 9, 16 minutes.
            send_after: sql`now() + make_interval(mins => ${attempts * attempts})`,
          })
          .where('id', '=', email.id)
          .execute();
      }
    }
    return batch.length;
  });
}

/** Starts the background loop. Returns a function that stops it (used on shutdown). */
export function startEmailWorker(db: Db, env: Env, log: FastifyBaseLogger): () => void {
  const send = createSender(env, log);
  let running = false;

  const tick = async () => {
    if (running) return; // previous batch still running
    running = true;
    try {
      while ((await sendPendingEmails(db, send, log)) === BATCH_SIZE) {
        // keep going while there is a full batch waiting
      }
    } catch (error) {
      log.error({ err: error }, 'email worker error');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}
