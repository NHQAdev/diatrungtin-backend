import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { call, registerCustomer } from './fixtures.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;

beforeEach(async () => {
  await resetData(db);
});
afterAll(async () => {
  await ctx.close();
});

/** The newest code mailed to this address (read from the email outbox, as a customer would read their inbox). */
async function latestCode(email: string): Promise<string> {
  const mail = await db.selectFrom('email_outbox').select('body_text').where('to_email', '=', email).orderBy('id', 'desc').limit(1).executeTakeFirstOrThrow();
  const match = /mã xác minh email của bạn là: (\d{6})/i.exec(mail.body_text);
  if (!match?.[1]) throw new Error('No code in email');
  return match[1];
}

const makeOld = (customerId: string) =>
  db.updateTable('email_verification_codes').set({ created_at: new Date(Date.now() - 2 * 60 * 1000) }).where('customer_id', '=', customerId).execute();

describe('email verification (D10)', () => {
  it('sends a code on registration and verifies the email with it', async () => {
    const { cookie, customer } = await registerCustomer(app, { email: 'otp@example.com' });
    expect(customer.emailVerified).toBe(false);

    const status = (await call(app, { url: '/api/auth/email-verification', cookie })).json().data;
    expect(status).toMatchObject({ emailVerified: false, email: 'otp@example.com' });
    expect(status.expiresAt).not.toBeNull();

    const code = await latestCode('otp@example.com');
    const ok = await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.customer.emailVerified).toBe(true);

    // Verifying again is harmless; resending is refused.
    expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code } })).statusCode).toBe(200);
    expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/resend', cookie })).statusCode).toBe(409);
  });

  it('counts wrong codes and locks the code after 5 attempts', async () => {
    const { cookie } = await registerCustomer(app, { email: 'wrong@example.com' });
    const code = await latestCode('wrong@example.com');
    const wrongCode = code === '000000' ? '111111' : '000000';

    const first = await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code: wrongCode } });
    expect(first.statusCode).toBe(400);
    expect(first.json().error.message).toContain('còn 4 lần');
    for (let i = 0; i < 4; i++) await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code: wrongCode } });

    // Even the right code no longer works: a new one must be requested.
    const locked = await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code } });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.details.reason).toBe('expired');
  });

  it('rejects malformed and expired codes', async () => {
    const { cookie, customer } = await registerCustomer(app, { email: 'exp@example.com' });
    expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code: '12ab' } })).statusCode).toBe(400);
    const code = await latestCode('exp@example.com');
    await db.updateTable('email_verification_codes').set({ expires_at: new Date(Date.now() - 1000) }).where("customer_id", "=", customer.id as string).execute();
    const res = await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.reason).toBe('expired');
  });

  it('applies a 60-second resend cooldown, and a new code replaces the old one', async () => {
    const { cookie, customer } = await registerCustomer(app, { email: 'resend@example.com' });
    const oldCode = await latestCode('resend@example.com');

    const tooSoon = await call(app, { method: 'POST', url: '/api/auth/email-verification/resend', cookie });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.details.retryAfterSeconds).toBeGreaterThan(0);

    await makeOld(customer.id as string);
    const resent = await call(app, { method: 'POST', url: '/api/auth/email-verification/resend', cookie });
    expect(resent.statusCode).toBe(200);
    const newCode = await latestCode('resend@example.com');

    if (oldCode !== newCode) {
      expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code: oldCode } })).statusCode).toBe(400);
    }
    expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code: newCode } })).statusCode).toBe(200);
  });

  it('caps sends at 5 per hour', async () => {
    const { cookie, customer } = await registerCustomer(app, { email: 'cap@example.com' });
    for (let i = 0; i < 4; i++) {
      await makeOld(customer.id as string);
      expect((await call(app, { method: 'POST', url: '/api/auth/email-verification/resend', cookie })).statusCode).toBe(200);
    }
    await makeOld(customer.id as string);
    // makeOld moves every code to 2 minutes ago, still inside the hour.
    const capped = await call(app, { method: 'POST', url: '/api/auth/email-verification/resend', cookie });
    expect(capped.statusCode).toBe(429);
  });

  it('lets an unverified customer fix a mistyped email, but not take an existing one', async () => {
    await registerCustomer(app, { email: 'taken@example.com' });
    const { cookie } = await registerCustomer(app, { email: 'typo@exmple.com' });

    const taken = await call(app, { method: 'PATCH', url: '/api/auth/email-verification/email', cookie, payload: { email: 'taken@example.com' } });
    expect(taken.statusCode).toBe(409);

    const fixed = await call(app, { method: 'PATCH', url: '/api/auth/email-verification/email', cookie, payload: { email: 'Typo@Example.com' } });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().data.customer.email).toBe('typo@example.com');

    const code = await latestCode('typo@example.com');
    const ok = await call(app, { method: 'POST', url: '/api/auth/email-verification/verify', cookie, payload: { code } });
    expect(ok.json().data.customer.emailVerified).toBe(true);

    const afterVerified = await call(app, { method: 'PATCH', url: '/api/auth/email-verification/email', cookie, payload: { email: 'other@example.com' } });
    expect(afterVerified.statusCode).toBe(409);
  });

  it('requires login and never returns the code in an API response', async () => {
    expect((await call(app, { url: '/api/auth/email-verification' })).statusCode).toBe(401);
    const { cookie } = await registerCustomer(app, { email: 'secret@example.com' });
    const code = await latestCode('secret@example.com');
    const status = await call(app, { url: '/api/auth/email-verification', cookie });
    expect(status.body).not.toContain(code);
    const row = await db.selectFrom('email_verification_codes').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(code);
  });
});
