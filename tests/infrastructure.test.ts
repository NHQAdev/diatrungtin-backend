import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrator.js';
import { sendPendingEmails } from '../src/modules/email/email-worker.js';
import { enqueueEmail } from '../src/modules/email/outbox.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { db } = ctx;
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
