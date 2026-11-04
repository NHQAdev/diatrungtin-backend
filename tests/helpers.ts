import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type Db } from '../src/db/client.js';
import { hashPassword } from '../src/lib/password.js';

export const ALLOWED_ORIGIN = 'http://localhost:5173';

export async function createTestContext(): Promise<{ app: FastifyInstance; db: Db; close: () => Promise<void> }> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    CORS_ORIGINS: ALLOWED_ORIGIN,
    COOKIE_SECURE: 'false',
  });
  const db = createDb(env.DATABASE_URL, 5);
  const app = await buildApp({ env, db });
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function resetData(db: Db): Promise<void> {
  await sql`TRUNCATE admin_sessions, admin_users, audit_logs RESTART IDENTITY CASCADE`.execute(db);
}

export async function createAdmin(db: Db, email = 'owner@example.com', password = 'correct horse battery') {
  return db
    .insertInto('admin_users')
    .values({ email, display_name: 'Chủ cửa hàng', password_hash: await hashPassword(password) })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/** Extracts "name=value" from a Set-Cookie header for reuse in the next request. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error('No Set-Cookie header');
  return header.split(';')[0]!;
}
