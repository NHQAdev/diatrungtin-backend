import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens.js';
import { ALLOWED_ORIGIN, createAdmin, createTestContext, resetData, sessionCookieFrom } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
const PASSWORD = 'correct horse battery';

// Login is rate-limited per IP; give each call its own address unless a test pins one.
let addressCounter = 0;
const nextAddress = () => `10.0.${Math.floor(++addressCounter / 250)}.${(addressCounter % 250) + 1}`;

async function login(
  email = 'owner@example.com',
  password = PASSWORD,
  headers: Record<string, string> = {},
  remoteAddress = nextAddress(),
) {
  return app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email, password }, headers, remoteAddress });
}

async function loginCookie(): Promise<string> {
  const response = await login();
  expect(response.statusCode).toBe(200);
  return sessionCookieFrom(response.headers['set-cookie']);
}

beforeAll(async () => {
  await resetData(db);
});
beforeEach(async () => {
  await resetData(db);
  await createAdmin(db);
});
afterAll(async () => {
  await ctx.close();
});

describe('health', () => {
  it('reports liveness and database readiness', async () => {
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe('ok');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const response = await app.inject('/khong-ton-tai');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('admin login', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie scoped to /api/admin', async () => {
    const response = await login('  OWNER@example.com ');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.admin).toMatchObject({ email: 'owner@example.com', displayName: 'Chủ cửa hàng' });
    expect(response.json().data.admin.passwordHash).toBeUndefined();

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/^dtt_admin_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/admin/);
  });

  it('stores only a hash of the session token', async () => {
    const token = (await loginCookie()).split('=')[1]!;
    const sessions = await db.selectFrom('admin_sessions').select('token_hash').execute();
    expect(sessions).toHaveLength(1);
    expect(Buffer.compare(sessions[0]!.token_hash, hashToken(token))).toBe(0);
    expect(sessions[0]!.token_hash.toString('utf8')).not.toContain(token);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login('owner@example.com', 'wrong password!!');
    const unknownEmail = await login('nobody@example.com', PASSWORD);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();

    const failures = await db.selectFrom('audit_logs').select('action').where('action', '=', 'admin.login_failed').execute();
    expect(failures).toHaveLength(2);
  });

  it('rejects malformed input with field-level details', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: 'abc' } });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['email', 'password']);
  });

  it('rejects a disabled account even with the right password', async () => {
    await db.updateTable('admin_users').set({ status: 'disabled' }).execute();
    expect((await login()).statusCode).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await login('owner@example.com', 'wrong password!!', {}, '203.0.113.9')).statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('admin session', () => {
  it('protects /me: 401 without a cookie, 200 with a valid one', async () => {
    const anonymous = await app.inject('/api/admin/auth/me');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('UNAUTHENTICATED');

    const cookie = await loginCookie();
    const me = await app.inject({ url: '/api/admin/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.admin.email).toBe('owner@example.com');
  });

  it('rejects a forged token', async () => {
    const me = await app.inject({ url: '/api/admin/auth/me', headers: { cookie: 'dtt_admin_session=forged' } });
    expect(me.statusCode).toBe(401);
  });

  it('logout revokes the session and is safe to repeat', async () => {
    const cookie = await loginCookie();
    const first = await app.inject({ method: 'POST', url: '/api/admin/auth/logout', headers: { cookie } });
    const second = await app.inject({ method: 'POST', url: '/api/admin/auth/logout', headers: { cookie } });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/admin/auth/me', headers: { cookie } })).statusCode).toBe(401);

    const logouts = await db.selectFrom('audit_logs').select('id').where('action', '=', 'admin.logout').execute();
    expect(logouts).toHaveLength(1);
  });

  it('rejects an expired session', async () => {
    const cookie = await loginCookie();
    await sql`UPDATE admin_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'`.execute(db);
    expect((await app.inject({ url: '/api/admin/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('cuts off existing sessions as soon as the account is disabled', async () => {
    const cookie = await loginCookie();
    await db.updateTable('admin_users').set({ status: 'disabled' }).execute();
    expect((await app.inject({ url: '/api/admin/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('cross-origin protection', () => {
  it('rejects state-changing admin requests from an unknown origin', async () => {
    const response = await login('owner@example.com', PASSWORD, { origin: 'https://evil.example' });
    expect(response.statusCode).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the configured frontend origin', async () => {
    const response = await login('owner@example.com', PASSWORD, { origin: ALLOWED_ORIGIN });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});
