import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrator.js';
import { sendPendingEmails } from '../src/modules/email/email-worker.js';
import { enqueueEmail } from '../src/modules/email/outbox.js';
import { runCleanup } from '../src/modules/maintenance/cleanup.js';
import { adminCookie, call } from './fixtures.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
const silentLog = { warn: () => undefined, error: () => undefined, info: () => undefined } as unknown as FastifyBaseLogger;

beforeEach(async () => {
  await resetData(db);
});
afterAll(async () => {
  await ctx.close();
});

describe('email outbox worker', () => {
  it('sends pending emails once and marks them sent', async () => {
    await enqueueEmail(db, { to: 'a@example.com', subject: 'S1', body: 'B1' });
    await enqueueEmail(db, { to: 'b@example.com', subject: 'S2', body: 'B2' });
    const sent: string[] = [];
    const count = await sendPendingEmails(db, async (to) => void sent.push(to), silentLog);
    expect(count).toBe(2);
    expect(sent.sort()).toEqual(['a@example.com', 'b@example.com']);
    // Second run: nothing left to send.
    expect(await sendPendingEmails(db, async (to) => void sent.push(to), silentLog)).toBe(0);
    const rows = await db.selectFrom('email_outbox').select(['status', 'attempts']).execute();
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
  });

  it('keeps a failed email for a later retry, then gives up after 5 attempts', async () => {
    await enqueueEmail(db, { to: 'down@example.com', subject: 'S', body: 'B' });
    const failing = async () => {
      throw new Error('SMTP down');
    };
    await sendPendingEmails(db, failing, silentLog);
    let row = await db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'SMTP down' });
    expect(row.send_after.getTime()).toBeGreaterThan(Date.now());

    for (let i = 0; i < 4; i++) {
      await sql`UPDATE email_outbox SET send_after = now() - interval '1 second'`.execute(db);
      await sendPendingEmails(db, failing, silentLog);
    }
    row = await db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', attempts: 5 });
  });
});

describe('migrator', () => {
  it('treats CRLF and LF copies of a migration as the same file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dtt-mig-'));
    await sql`DROP TABLE IF EXISTS crlf_probe`.execute(db);
    await sql`DELETE FROM schema_migrations WHERE version = '9001_crlf_probe.sql'`.execute(db);

    await writeFile(path.join(dir, '9001_crlf_probe.sql'), 'CREATE TABLE crlf_probe (\r\n  id int\r\n);\r\n');
    const first = await runMigrations(process.env.TEST_DATABASE_URL!, dir);
    expect(first.applied).toEqual(['9001_crlf_probe.sql']);

    await writeFile(path.join(dir, '9001_crlf_probe.sql'), 'CREATE TABLE crlf_probe (\n  id int\n);\n');
    const second = await runMigrations(process.env.TEST_DATABASE_URL!, dir);
    expect(second.skipped).toEqual(['9001_crlf_probe.sql']);

    await writeFile(path.join(dir, '9001_crlf_probe.sql'), 'CREATE TABLE crlf_probe (\n  id bigint\n);\n');
    let error: Error | undefined;
    await runMigrations(process.env.TEST_DATABASE_URL!, dir).catch((e: Error) => (error = e));
    expect(error?.message).toMatch('was modified after being applied');

    await sql`DROP TABLE crlf_probe`.execute(db);
    await sql`DELETE FROM schema_migrations WHERE version = '9001_crlf_probe.sql'`.execute(db);
  });
});

describe('admin email monitor', () => {
  it('lists failed emails without their body and can queue them again', async () => {
    const admin = await adminCookie(app, db);
    await enqueueEmail(db, { to: 'x@example.com', subject: 'Đặt lại mật khẩu', body: 'https://shop/dat-lai-mat-khau?token=SECRET' });
    await sql`UPDATE email_outbox SET status = 'failed', attempts = 5, last_error = 'SMTP auth failed'`.execute(db);
    const id = (await db.selectFrom('email_outbox').select('id').executeTakeFirstOrThrow()).id;

    const list = await call(app, { url: '/api/admin/emails?status=failed', cookie: admin });
    expect(list.json().meta.total).toBe(1);
    expect(list.json().data[0]).toMatchObject({ to_email: 'x@example.com', last_error: 'SMTP auth failed', attempts: 5 });
    expect(list.body).not.toMatch('SECRET');

    expect((await call(app, { method: 'POST', url: `/api/admin/emails/${id}/retry`, cookie: admin })).json().data.status).toBe('pending');
    const row = await db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    // Only failed emails can be retried.
    expect((await call(app, { method: 'POST', url: `/api/admin/emails/${id}/retry`, cookie: admin })).statusCode).toBe(409);
    expect((await call(app, { url: '/api/admin/emails' })).statusCode).toBe(401);
  });
});

describe('cleanup job', () => {
  it('removes only old, finished data', async () => {
    const admin = await adminCookie(app, db); // creates an active admin session
    expect(admin).toMatch('dtt_admin_session');
    const adminId = (await db.selectFrom('admin_users').select('id').executeTakeFirstOrThrow()).id;
    const token = (n: number) => Buffer.alloc(32, n);
    await db.insertInto('admin_sessions').values([
      { admin_user_id: adminId, token_hash: token(1), created_at: sql`now() - interval '60 days'`, expires_at: sql`now() - interval '40 days'` },
      { admin_user_id: adminId, token_hash: token(2), created_at: sql`now() - interval '10 days'`, expires_at: sql`now() - interval '5 days'` },
    ]).execute();
    await enqueueEmail(db, { to: 'old@example.com', subject: 'old', body: 'b' });
    await enqueueEmail(db, { to: 'failed@example.com', subject: 'failed', body: 'b' });
    await sql`UPDATE email_outbox SET status = 'sent', sent_at = now() - interval '100 days' WHERE to_email = 'old@example.com'`.execute(db);
    await sql`UPDATE email_outbox SET status = 'failed', created_at = now() - interval '200 days' WHERE to_email = 'failed@example.com'`.execute(db);

    const result = await runCleanup(db);
    expect(result).toMatchObject({ adminSessions: 1, sentEmails: 1 });
    // Kept: the live session, the recently expired one, and the failed email.
    expect(await db.selectFrom('admin_sessions').select('id').execute()).toHaveLength(2);
    expect((await db.selectFrom('email_outbox').select('to_email').execute()).map((r) => r.to_email)).toEqual(['failed@example.com']);
  });
});

