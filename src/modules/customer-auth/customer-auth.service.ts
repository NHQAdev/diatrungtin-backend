import { sql } from 'kysely';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { AppError, conflict, isUniqueViolation, unauthenticated } from '../../lib/errors.js';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { enqueueEmail } from '../email/outbox.js';
import { passwordResetEmail } from '../email/templates.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface RegisterInput {
  accountType: 'personal' | 'business';
  email: string;
  password: string;
  fullName: string;
  phone: string;
  companyName?: string;
  taxCode?: string;
  invoiceAddress?: string;
}

export interface SessionInfo {
  ipAddress: string | null;
  userAgent: string | null;
  ttlDays: number;
}

async function createSession(db: Db, customerId: string, info: SessionInfo) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + info.ttlDays * 24 * 60 * 60 * 1000);
  await db
    .insertInto('customer_sessions')
    .values({
      customer_id: customerId,
      token_hash: hashToken(token),
      ip_address: info.ipAddress,
      user_agent: info.userAgent?.slice(0, 500) ?? null,
      expires_at: expiresAt,
    })
    .execute();
  return { token, expiresAt };
}

export async function registerCustomer(db: Db, input: RegisterInput, info: SessionInfo) {
  const isBusiness = input.accountType === 'business';
  try {
    const customer = await db
      .insertInto('customers')
      .values({
        email: input.email,
        password_hash: await hashPassword(input.password),
        full_name: input.fullName,
        phone: input.phone,
        account_type: input.accountType,
        // D9: business accounts wait for an admin to check the tax code before business prices apply.
        business_status: isBusiness ? 'pending' : null,
        company_name: isBusiness ? input.companyName : null,
        tax_code: isBusiness ? input.taxCode : null,
        invoice_address: isBusiness ? input.invoiceAddress : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const session = await createSession(db, customer.id, info);
    return { customerId: customer.id, ...session };
  } catch (error) {
    if (isUniqueViolation(error, 'customers_email_key')) {
      throw conflict('Email này đã được đăng ký. Hãy đăng nhập hoặc dùng chức năng quên mật khẩu.');
    }
    throw error;
  }
}

export async function loginCustomer(db: Db, email: string, password: string, info: SessionInfo) {
  const customer = await db.selectFrom('customers').select(['id', 'password_hash', 'status']).where('email', '=', email).executeTakeFirst();
  // Always hash once, so the response time does not tell whether the email exists.
  const ok = await verifyPassword(password, customer?.password_hash ?? (await getDummyHash()));
  if (!customer || !ok) throw new AppError(401, 'UNAUTHENTICATED', 'Email hoặc mật khẩu không đúng.');
  if (customer.status !== 'active') throw new AppError(403, 'FORBIDDEN', 'Tài khoản đã bị khóa. Vui lòng liên hệ cửa hàng.');
  return createSession(db, customer.id, info);
}

export async function logoutCustomer(db: Db, token: string): Promise<void> {
  await db
    .updateTable('customer_sessions')
    .set({ revoked_at: sql`now()` })
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .execute();
}

/** Always succeeds from the caller's point of view, so it cannot be used to find out which emails exist. */
export async function requestPasswordReset(db: Db, env: Env, email: string): Promise<void> {
  const customer = await db.selectFrom('customers').select(['id', 'email']).where('email', '=', email).where('status', '=', 'active').executeTakeFirst();
  if (!customer) return;

  const token = generateToken();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('password_reset_tokens')
      .values({ customer_id: customer.id, token_hash: hashToken(token), expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS) })
      .execute();
    const url = `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/dat-lai-mat-khau?token=${encodeURIComponent(token)}`;
    await enqueueEmail(trx, passwordResetEmail(customer.email, url));
  });
}

export async function resetPassword(db: Db, token: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db.transaction().execute(async (trx) => {
    // "used_at is null" in the UPDATE makes each token usable exactly once, even with two clicks at the same time.
    const used = await trx
      .updateTable('password_reset_tokens')
      .set({ used_at: sql`now()` })
      .where('token_hash', '=', hashToken(token))
      .where('used_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning('customer_id')
      .executeTakeFirst();
    if (!used) throw new AppError(400, 'BAD_REQUEST', 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');

    await trx.updateTable('customers').set({ password_hash: passwordHash, updated_at: sql`now()` }).where('id', '=', used.customer_id).execute();
    // Log out everywhere: whoever knew the old password loses access.
    await trx.updateTable('customer_sessions').set({ revoked_at: sql`now()` }).where('customer_id', '=', used.customer_id).where('revoked_at', 'is', null).execute();
  });
}

export async function changePassword(db: Db, customerId: string, currentSessionId: string, current: string, next: string): Promise<void> {
  const customer = await db.selectFrom('customers').select('password_hash').where('id', '=', customerId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(current, customer.password_hash))) throw unauthenticated('Mật khẩu hiện tại không đúng.');

  const passwordHash = await hashPassword(next);
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('customers').set({ password_hash: passwordHash, updated_at: sql`now()` }).where('id', '=', customerId).execute();
    // Keep the current session, log out all others.
    await trx
      .updateTable('customer_sessions')
      .set({ revoked_at: sql`now()` })
      .where('customer_id', '=', customerId)
      .where('id', '<>', currentSessionId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}
