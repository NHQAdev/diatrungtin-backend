import { randomInt, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Db, DbOrTrx } from '../../db/client.js';
import { AppError, conflict, isUniqueViolation } from '../../lib/errors.js';
import { hashToken } from '../../lib/tokens.js';
import { enqueueEmail } from '../email/outbox.js';
import { emailVerificationEmail } from '../email/templates.js';

// D10: after registering, the customer confirms their email with a 6-digit code sent by email.
export const VERIFICATION = {
  codeLength: 6,
  codeTtlMinutes: 10,
  maxAttempts: 5, // wrong codes allowed per code; then a new code is needed
  resendCooldownSeconds: 60,
  maxSendsPerHour: 5,
};

export interface VerificationStatus {
  emailVerified: boolean;
  email: string;
  /** When the current code stops working (null when there is no usable code). */
  expiresAt: Date | null;
  /** Earliest time "Gửi lại mã" is accepted. */
  resendAvailableAt: Date;
}

const hashCode = (customerId: string, code: string) => hashToken(`${customerId}:${code}`);

function newCode(): string {
  return String(randomInt(0, 10 ** VERIFICATION.codeLength)).padStart(VERIFICATION.codeLength, '0');
}

function rateLimited(message: string, retryAfterSeconds: number) {
  return new AppError(429, 'RATE_LIMITED', message, { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });
}

async function lastSentAt(db: DbOrTrx, customerId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('email_verification_codes')
    .select('created_at')
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? new Date(row.created_at) : null;
}

/**
 * Create a new code for the customer's current email and queue the email. Any older code stops
 * working. `enforceLimits` is false only right after registration (the first code).
 */
export async function issueVerificationCode(db: Db, customer: { id: string; email: string; fullName: string }, options: { enforceLimits: boolean }) {
  return db.transaction().execute(async (trx) => {
    // Serialise sends for one customer, so two quick clicks cannot both pass the cooldown check.
    await trx.selectFrom('customers').select('id').where('id', '=', customer.id).forUpdate().executeTakeFirst();

    if (options.enforceLimits) {
      const last = await lastSentAt(trx, customer.id);
      if (last) {
        const waitSeconds = VERIFICATION.resendCooldownSeconds - (Date.now() - last.getTime()) / 1000;
        if (waitSeconds > 0) throw rateLimited(`Vui lòng đợi ${Math.ceil(waitSeconds)} giây rồi gửi lại mã.`, waitSeconds);
      }
      const { count } = await trx
        .selectFrom('email_verification_codes')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('customer_id', '=', customer.id)
        .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
        .executeTakeFirstOrThrow();
      if (Number(count) >= VERIFICATION.maxSendsPerHour) {
        throw rateLimited('Bạn đã yêu cầu gửi mã quá nhiều lần. Vui lòng thử lại sau 1 giờ.', 3600);
      }
    }

    // Older codes stop working as soon as a new one is sent.
    await trx
      .updateTable('email_verification_codes')
      .set({ expires_at: sql`now()` })
      .where('customer_id', '=', customer.id)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .execute();

    const code = newCode();
    const expiresAt = new Date(Date.now() + VERIFICATION.codeTtlMinutes * 60 * 1000);
    await trx
      .insertInto('email_verification_codes')
      .values({ customer_id: customer.id, email: customer.email, code_hash: hashCode(customer.id, code), expires_at: expiresAt })
      .execute();
    await enqueueEmail(trx, emailVerificationEmail(customer.email, customer.fullName, code, VERIFICATION.codeTtlMinutes));

    return { expiresAt, resendAvailableAt: new Date(Date.now() + VERIFICATION.resendCooldownSeconds * 1000) };
  });
}

export async function getVerificationStatus(db: Db, customer: { id: string; email: string; emailVerified: boolean }): Promise<VerificationStatus> {
  const code = await db
    .selectFrom('email_verification_codes')
    .select(['created_at', 'expires_at', 'attempts', 'consumed_at', 'email'])
    .where('customer_id', '=', customer.id)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const usable =
    code && !code.consumed_at && code.email === customer.email && code.attempts < VERIFICATION.maxAttempts && new Date(code.expires_at) > new Date();
  const resendAvailableAt = code ? new Date(new Date(code.created_at).getTime() + VERIFICATION.resendCooldownSeconds * 1000) : new Date();
  return { emailVerified: customer.emailVerified, email: customer.email, expiresAt: usable ? new Date(code.expires_at) : null, resendAvailableAt };
}

/**
 * Check a code. Wrong attempts are saved before the error is thrown (they must not be rolled back),
 * so the result is decided inside the transaction and the error is raised after it commits.
 */
export async function verifyEmailCode(db: Db, customer: { id: string; email: string }, code: string): Promise<void> {
  const outcome = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('customers')
      .select(['email', 'email_verified_at'])
      .where('id', '=', customer.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.email_verified_at) return { ok: true as const };

    const current = await trx
      .selectFrom('email_verification_codes')
      .select(['id', 'code_hash', 'attempts'])
      .where('customer_id', '=', customer.id)
      .where('email', '=', row.email)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!current || current.attempts >= VERIFICATION.maxAttempts) return { ok: false as const, reason: 'expired' as const };

    const expected = Buffer.from(current.code_hash);
    const given = hashCode(customer.id, code);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const attempts = current.attempts + 1;
      await trx.updateTable('email_verification_codes').set({ attempts }).where('id', '=', current.id).execute();
      return { ok: false as const, reason: 'wrong' as const, left: VERIFICATION.maxAttempts - attempts };
    }

    await trx.updateTable('email_verification_codes').set({ consumed_at: sql`now()` }).where('id', '=', current.id).execute();
    await trx.updateTable('customers').set({ email_verified_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', customer.id).execute();
    return { ok: true as const };
  });

  if (outcome.ok) return;
  if (outcome.reason === 'expired' || outcome.left <= 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Mã xác minh đã hết hạn hoặc đã nhập sai quá nhiều lần. Vui lòng bấm "Gửi lại mã".', { field: 'code', reason: 'expired' });
  }
  throw new AppError(400, 'VALIDATION_ERROR', `Mã xác minh không đúng. Bạn còn ${outcome.left} lần thử.`, [{ field: 'code', message: `Mã xác minh không đúng. Bạn còn ${outcome.left} lần thử.` }]);
}

/** Fix a mistyped address before it is verified. A verified email cannot be changed here. */
export async function changeUnverifiedEmail(db: Db, customer: { id: string; fullName: string }, newEmail: string) {
  const row = await db.selectFrom('customers').select(['email', 'email_verified_at']).where('id', '=', customer.id).executeTakeFirstOrThrow();
  if (row.email_verified_at) throw conflict('Email đã được xác minh nên không đổi được ở bước này.');
  // The hourly cap still applies, but not the 60-second cooldown: the old address may simply be wrong.
  const { count } = await db
    .selectFrom('email_verification_codes')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('customer_id', '=', customer.id)
    .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (Number(count) >= VERIFICATION.maxSendsPerHour) {
    throw rateLimited('Bạn đã yêu cầu gửi mã quá nhiều lần. Vui lòng thử lại sau 1 giờ.', 3600);
  }
  if (row.email !== newEmail) {
    try {
      await db.updateTable('customers').set({ email: newEmail, updated_at: sql`now()` }).where('id', '=', customer.id).execute();
    } catch (error) {
      if (isUniqueViolation(error, 'customers_email_key')) throw conflict('Email này đã được đăng ký cho một tài khoản khác.');
      throw error;
    }
  }
  return issueVerificationCode(db, { id: customer.id, email: newEmail, fullName: customer.fullName }, { enforceLimits: false });
}
