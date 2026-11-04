import { sql } from 'kysely';
import type { Db } from '../../db/client.js';
import type { AdminUser } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { getDummyHash, verifyPassword } from '../../lib/password.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { writeAuditLog } from '../audit/audit.service.js';

export interface AdminProfile {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthenticatedAdmin extends AdminProfile {
  sessionId: string;
}

const INVALID_CREDENTIALS = 'Email hoặc mật khẩu không đúng.';
// Avoid a write on every request: refresh last_seen_at at most this often.
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAdminProfile(user: Pick<AdminUser, 'id' | 'email' | 'display_name'>): AdminProfile {
  return { id: user.id, email: user.email, displayName: user.display_name };
}

export async function loginAdmin(
  db: Db,
  input: { email: string; password: string; ipAddress: string | null; userAgent: string | null; ttlHours: number },
): Promise<{ token: string; expiresAt: Date; admin: AdminProfile }> {
  const email = normalizeEmail(input.email);
  const user = await db.selectFrom('admin_users').selectAll().where('email', '=', email).executeTakeFirst();

  // Always run one password hash so response time does not reveal whether the email exists.
  const passwordOk = await verifyPassword(input.password, user?.password_hash ?? (await getDummyHash()));

  if (!user || !passwordOk || user.status !== 'active') {
    await writeAuditLog(db, {
      actor_type: 'anonymous',
      actor_id: null,
      action: 'admin.login_failed',
      entity_type: 'admin_user',
      entity_id: user?.id ?? null,
      ip_address: input.ipAddress,
      metadata: { email, reason: !user ? 'unknown_email' : !passwordOk ? 'bad_password' : 'disabled' },
    });
    throw new AppError(401, 'UNAUTHENTICATED', INVALID_CREDENTIALS);
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('admin_sessions')
      .values({
        admin_user_id: user.id,
        token_hash: hashToken(token),
        ip_address: input.ipAddress,
        user_agent: input.userAgent?.slice(0, 500) ?? null,
        expires_at: expiresAt,
      })
      .execute();
    await trx.updateTable('admin_users').set({ last_login_at: sql`now()` }).where('id', '=', user.id).execute();
    await writeAuditLog(trx, {
      actor_type: 'admin',
      actor_id: user.id,
      action: 'admin.login',
      entity_type: 'admin_user',
      entity_id: user.id,
      ip_address: input.ipAddress,
    });
  });

  return { token, expiresAt, admin: toAdminProfile(user) };
}

/** Resolve a session token to an active admin, or null when invalid, expired, revoked or disabled. */
export async function findAdminBySessionToken(db: Db, token: string): Promise<AuthenticatedAdmin | null> {
  const row = await db
    .selectFrom('admin_sessions as s')
    .innerJoin('admin_users as u', 'u.id', 's.admin_user_id')
    .select(['s.id as session_id', 's.last_seen_at', 'u.id', 'u.email', 'u.display_name'])
    .where('s.token_hash', '=', hashToken(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('u.status', '=', 'active')
    .executeTakeFirst();

  if (!row) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() > LAST_SEEN_REFRESH_MS) {
    await db.updateTable('admin_sessions').set({ last_seen_at: sql`now()` }).where('id', '=', row.session_id).execute();
  }

  return { sessionId: row.session_id, ...toAdminProfile(row) };
}

/** Revoking is idempotent: calling it twice, or with an unknown token, is not an error. */
export async function logoutAdmin(db: Db, token: string, ipAddress: string | null): Promise<void> {
  const revoked = await db
    .updateTable('admin_sessions')
    .set({ revoked_at: sql`now()` })
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .returning(['id', 'admin_user_id'])
    .executeTakeFirst();

  if (revoked) {
    await writeAuditLog(db, {
      actor_type: 'admin',
      actor_id: revoked.admin_user_id,
      action: 'admin.logout',
      entity_type: 'admin_session',
      entity_id: revoked.id,
      ip_address: ipAddress,
    });
  }
}
