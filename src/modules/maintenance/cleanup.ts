import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/client.js';

// Removes data that is no longer useful, so tables do not grow forever.
// Orders, order history, stock history, audit logs and FAILED emails are never deleted here.

export const RETENTION = {
  sessionsDays: 30, // after expiry or logout
  resetTokensDays: 7, // after expiry or use
  idempotencyKeysDays: 30, // a retry of the same checkout never comes this late
  sentEmailsDays: 90,
};

export interface CleanupResult {
  adminSessions: number;
  customerSessions: number;
  resetTokens: number;
  verificationCodes: number;
  idempotencyKeys: number;
  sentEmails: number;
}

const daysAgo = (days: number) => sql<Date>`now() - make_interval(days => ${days})`;

export async function runCleanup(db: Db): Promise<CleanupResult> {
  const count = (result: { numDeletedRows: bigint }) => Number(result.numDeletedRows);

  const adminSessions = await db
    .deleteFrom('admin_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', daysAgo(RETENTION.sessionsDays)), eb('revoked_at', '<', daysAgo(RETENTION.sessionsDays))]))
    .executeTakeFirst();
  const customerSessions = await db
    .deleteFrom('customer_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', daysAgo(RETENTION.sessionsDays)), eb('revoked_at', '<', daysAgo(RETENTION.sessionsDays))]))
    .executeTakeFirst();
  const resetTokens = await db
    .deleteFrom('password_reset_tokens')
    .where((eb) => eb.or([eb('expires_at', '<', daysAgo(RETENTION.resetTokensDays)), eb('used_at', '<', daysAgo(RETENTION.resetTokensDays))]))
    .executeTakeFirst();
  const verificationCodes = await db
    .deleteFrom('email_verification_codes')
    .where('expires_at', '<', daysAgo(RETENTION.resetTokensDays))
    .executeTakeFirst();
  const idempotencyKeys = await db.deleteFrom('idempotency_keys').where('created_at', '<', daysAgo(RETENTION.idempotencyKeysDays)).executeTakeFirst();
  const sentEmails = await db
    .deleteFrom('email_outbox')
    .where('status', '=', 'sent')
    .where('sent_at', '<', daysAgo(RETENTION.sentEmailsDays))
    .executeTakeFirst();

  return {
    adminSessions: count(adminSessions),
    customerSessions: count(customerSessions),
    resetTokens: count(resetTokens),
    verificationCodes: count(verificationCodes),
    idempotencyKeys: count(idempotencyKeys),
    sentEmails: count(sentEmails),
  };
}

/** Runs the cleanup at start-up and then every 6 hours. Returns a stop function. */
export function startCleanupJob(db: Db, log: FastifyBaseLogger): () => void {
  const tick = async () => {
    try {
      const result = await runCleanup(db);
      log.info({ cleanup: result }, 'cleanup done');
    } catch (error) {
      log.error({ err: error }, 'cleanup failed');
    }
  };
  const timer = setInterval(() => void tick(), 6 * 60 * 60 * 1000);
  void tick();
  return () => clearInterval(timer);
}
