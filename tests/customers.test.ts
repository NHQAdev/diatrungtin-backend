import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCookie, call, type CatalogFixture, createCatalog, registerApprovedBusiness, registerCustomer } from './fixtures.js';
import { createTestContext, resetData, sessionCookieFrom } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
let admin: string;
let catalog: CatalogFixture;

const businessBody = { accountType: 'business', companyName: 'Công ty TNHH Mẫu', taxCode: '0312345678', invoiceAddress: '1 Đường A, Quận 1' };

async function priceSeenBy(cookie: string | undefined) {
  const product = (await call(app, { url: `/api/products/${catalog.slug}`, cookie })).json().data;
  const a = product.variants.find((v: { id: string }) => v.id === catalog.variantA);
  return { tier: product.priceTier, price: a.price, extraBeadPrice: a.extraBeadPrice };
}

beforeEach(async () => {
  await resetData(db);
  admin = await adminCookie(app, db);
  catalog = await createCatalog(app, admin);
});
afterAll(async () => {
  await ctx.close();
});

describe('registration and login', () => {
  it('registers a personal account and logs it in', async () => {
    const { cookie, customer } = await registerCustomer(app, { email: '  An@Example.com ', phone: '+84 912 345 678' });
    expect(customer).toMatchObject({ email: 'an@example.com', phone: '0912345678', accountType: 'personal', businessStatus: null, priceTier: 'retail' });
    expect(cookie).toMatch(/^dtt_session=/);
    const me = await call(app, { url: '/api/auth/me', cookie });
    expect(me.json().data.customer.email).toBe('an@example.com');
  });

  it('refuses a second account with the same email', async () => {
    await registerCustomer(app, { email: 'same@example.com' });
    const again = await call(app, { method: 'POST', url: '/api/auth/register', payload: { accountType: 'personal', email: 'SAME@example.com', password: 'mat khau 123', fullName: 'B', phone: '0912345678' } });
    expect(again.statusCode).toBe(409);
  });

  it('validates phone, tax code and required business fields', async () => {
    const badPhone = await call(app, { method: 'POST', url: '/api/auth/register', payload: { accountType: 'personal', email: 'x@example.com', password: 'mat khau 123', fullName: 'X', phone: '12345' } });
    expect(badPhone.statusCode).toBe(400);
    const badTax = await call(app, { method: 'POST', url: '/api/auth/register', payload: { ...businessBody, taxCode: '123', email: 'y@example.com', password: 'mat khau 123', fullName: 'Y', phone: '0912345678' } });
    expect(badTax.statusCode).toBe(400);
    const missingCompany = await call(app, { method: 'POST', url: '/api/auth/register', payload: { accountType: 'business', taxCode: '0312345678', invoiceAddress: 'A', email: 'z@example.com', password: 'mat khau 123', fullName: 'Z', phone: '0912345678' } });
    expect(missingCompany.statusCode).toBe(400);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    await registerCustomer(app, { email: 'c@example.com' });
    const wrong = await call(app, { method: 'POST', url: '/api/auth/login', payload: { email: 'c@example.com', password: 'sai mat khau' } });
    const unknown = await call(app, { method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'sai mat khau' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('logs out and blocks a disabled account immediately', async () => {
    const { cookie, customer } = await registerCustomer(app);
    await call(app, { method: 'POST', url: `/api/admin/customers/${customer.id}/status`, cookie: admin, payload: { status: 'disabled' } });
    expect((await call(app, { url: '/api/auth/me', cookie })).statusCode).toBe(401);
  });

  it('never sends password hashes to the admin', async () => {
    await registerCustomer(app);
    const list = await call(app, { url: '/api/admin/customers', cookie: admin });
    expect(list.body).not.toMatch('password');
    expect(list.body).not.toMatch('scrypt$');
  });
});

describe('business pricing (D8, D9)', () => {
  it('guests and personal customers see retail prices', async () => {
    expect(await priceSeenBy(undefined)).toEqual({ tier: 'retail', price: 500_000, extraBeadPrice: 20_000 });
    const { cookie } = await registerCustomer(app);
    expect(await priceSeenBy(cookie)).toEqual({ tier: 'retail', price: 500_000, extraBeadPrice: 20_000 });
  });

  it('a business account waiting for review still sees retail prices', async () => {
    const { cookie, customer } = await registerCustomer(app, businessBody);
    expect(customer.businessStatus).toBe('pending');
    expect(await priceSeenBy(cookie)).toEqual({ tier: 'retail', price: 500_000, extraBeadPrice: 20_000 });
  });

  it('after approval the business price applies, and an email is queued', async () => {
    const { cookie } = await registerApprovedBusiness(app, admin);
    expect(await priceSeenBy(cookie)).toEqual({ tier: 'business', price: 400_000, extraBeadPrice: 15_000 });
    // Variant B has no business price: falls back to retail.
    const list = (await call(app, { url: '/api/products', cookie })).json();
    expect(list.meta.priceTier).toBe('business');
    expect(list.data[0].priceFrom).toBe(300_000);

    const emails = await db.selectFrom('email_outbox').select(['subject']).execute();
    expect(emails.map((e) => e.subject)).toContain('Tài khoản doanh nghiệp đã được duyệt');
  });

  it('rejection needs a reason and keeps retail prices', async () => {
    const { cookie, customer } = await registerCustomer(app, businessBody);
    const noReason = await call(app, { method: 'POST', url: `/api/admin/customers/${customer.id}/business-review`, cookie: admin, payload: { decision: 'reject' } });
    expect(noReason.statusCode).toBe(400);
    const rejected = await call(app, { method: 'POST', url: `/api/admin/customers/${customer.id}/business-review`, cookie: admin, payload: { decision: 'reject', reason: 'MST không khớp' } });
    expect(rejected.statusCode).toBe(200);
    expect((await priceSeenBy(cookie)).tier).toBe('retail');
  });

  it('cannot approve a personal account as a business', async () => {
    const { customer } = await registerCustomer(app);
    const response = await call(app, { method: 'POST', url: `/api/admin/customers/${customer.id}/business-review`, cookie: admin, payload: { decision: 'approve' } });
    expect(response.statusCode).toBe(404);
  });

  it('changing the tax code sends the account back to review (no business price meanwhile)', async () => {
    const { cookie } = await registerApprovedBusiness(app, admin);
    const update = await call(app, { method: 'PUT', url: '/api/account/business', cookie, payload: { companyName: 'Công ty TNHH Mẫu', taxCode: '0399999999', invoiceAddress: '1 Đường A' } });
    expect(update.json().data.customer).toMatchObject({ businessStatus: 'pending', priceTier: 'retail' });
    expect((await priceSeenBy(cookie)).tier).toBe('retail');

    // Only the invoice address changed: stays approved.
    const { cookie: other } = await registerApprovedBusiness(app, admin);
    const addressOnly = await call(app, { method: 'PUT', url: '/api/account/business', cookie: other, payload: { companyName: 'Công ty TNHH Mẫu', taxCode: '0312345678', invoiceAddress: 'Địa chỉ mới' } });
    expect(addressOnly.json().data.customer.businessStatus).toBe('approved');
  });
});

describe('password reset', () => {
  it('answers the same for unknown emails and queues nothing', async () => {
    const response = await call(app, { method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'nobody@example.com' } });
    expect(response.statusCode).toBe(200);
    expect(await db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);
  });

  it('resets with the emailed token exactly once and logs out old sessions', async () => {
    const { cookie } = await registerCustomer(app, { email: 'reset@example.com' });
    await call(app, { method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'reset@example.com' } });
    const email = await db.selectFrom('email_outbox').select('body_text').where('subject', 'like', 'Đặt lại mật khẩu%').executeTakeFirstOrThrow();
    const token = decodeURIComponent(/token=([^\s]+)/.exec(email.body_text)![1]!);

    const first = await call(app, { method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'mat khau moi 456' } });
    expect(first.statusCode).toBe(200);
    const second = await call(app, { method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'mat khau khac 789' } });
    expect(second.statusCode).toBe(400);

    expect((await call(app, { url: '/api/auth/me', cookie })).statusCode).toBe(401);
    const login = await call(app, { method: 'POST', url: '/api/auth/login', payload: { email: 'reset@example.com', password: 'mat khau moi 456' } });
    expect(login.statusCode).toBe(200);
    expect(sessionCookieFrom(login.headers['set-cookie'])).toMatch(/^dtt_session=/);
  });
});
