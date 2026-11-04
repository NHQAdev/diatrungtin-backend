import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminCookie,
  call,
  type CatalogFixture,
  contact,
  createCatalog,
  newKey,
  registerApprovedBusiness,
  registerCustomer,
  setShipping,
  shippingAddress,
} from './fixtures.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
let admin: string;
let catalog: CatalogFixture;

type Item = { variantId: string; quantity: number; extraBeads?: number };

const stockOf = async (variantId: string) =>
  (await db.selectFrom('product_variants').select('stock').where('id', '=', variantId).executeTakeFirstOrThrow()).stock;

async function quote(items: Item[], cookie?: string) {
  return call(app, { method: 'POST', url: '/api/checkout/quote', payload: { items }, cookie });
}

/** Places an order the way the frontend does: quote first, then send the quoted total. */
async function placeOrder(items: Item[], options: { key?: string; cookie?: string; expectedTotal?: number; extra?: Record<string, unknown> } = {}) {
  const expectedTotal = options.expectedTotal ?? (await quote(items, options.cookie)).json().data.total;
  return call(app, {
    method: 'POST',
    url: '/api/orders',
    cookie: options.cookie,
    headers: { 'idempotency-key': options.key ?? newKey() },
    payload: { items, contact, shippingAddress, expectedTotal, ...options.extra },
  });
}

async function adminAction(orderId: string, action: string, extra: Record<string, unknown> = {}) {
  return call(app, { method: 'POST', url: `/api/admin/orders/${orderId}/actions`, cookie: admin, payload: { action, ...extra } });
}

const orderIdByCode = async (code: string) =>
  (await db.selectFrom('orders').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;

beforeEach(async () => {
  await resetData(db);
  admin = await adminCookie(app, db);
  catalog = await createCatalog(app, admin);
  await setShipping(app, admin, 30_000, 1_000_000);
});
afterAll(async () => {
  await ctx.close();
});

describe('quote', () => {
  it('refuses checkout until a shipping fee is configured', async () => {
    await setShipping(app, admin, null);
    const response = await quote([{ variantId: catalog.variantB, quantity: 1 }]);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORE_NOT_CONFIGURED');
  });

  it('prices lines on the server, including extra beads and shipping', async () => {
    const data = (await quote([{ variantId: catalog.variantA, quantity: 1, extraBeads: 2 }])).json().data;
    expect(data.lines[0]).toMatchObject({ unitPrice: 500_000, extraBeads: 2, extraBeadUnitPrice: 20_000, quantity: 1, lineTotal: 540_000 });
    expect(data).toMatchObject({ priceTier: 'retail', subtotal: 540_000, shippingFee: 30_000, total: 570_000, problems: [] });
  });

  it('applies free shipping from the threshold', async () => {
    const data = (await quote([{ variantId: catalog.variantA, quantity: 2 }])).json().data;
    expect(data).toMatchObject({ subtotal: 1_000_000, shippingFee: 0, total: 1_000_000 });
  });

  it('reports stock problems instead of failing, and refuses too many extra beads', async () => {
    const data = (await quote([{ variantId: catalog.variantB, quantity: 3 }])).json().data;
    expect(data.problems).toEqual([{ variantId: catalog.variantB, reason: 'insufficient_stock', availableQuantity: 1 }]);
    const tooMany = await quote([{ variantId: catalog.variantA, quantity: 1, extraBeads: 4 }]);
    expect(tooMany.statusCode).toBe(400);
    const notAllowed = await quote([{ variantId: catalog.variantB, quantity: 1, extraBeads: 1 }]);
    expect(notAllowed.statusCode).toBe(400);
  });
});

describe('placing an order', () => {
  it('creates the order, takes stock, snapshots lines and queues the email', async () => {
    const response = await placeOrder([{ variantId: catalog.variantA, quantity: 1, extraBeads: 2 }]);
    expect(response.statusCode).toBe(201);
    const body = response.json().data;
    expect(body.code).toMatch(/^DTT-\d{6}-[A-Z0-9]{6}$/);
    expect(body).toMatchObject({ total: 570_000, orderStatus: 'pending', replayed: false });
    expect(typeof body.accessToken).toBe('string');

    expect(await stockOf(catalog.variantA)).toBe(1);
    const order = await db.selectFrom('orders').selectAll().where('code', '=', body.code).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ customer_id: null, price_tier: 'retail', subtotal: 540_000, shipping_fee: 30_000, total: 570_000, payment_status: 'unpaid', fulfillment_status: 'unfulfilled', email: 'b@example.com' });
    const items = await db.selectFrom('order_items').selectAll().where('order_id', '=', order.id).execute();
    expect(items[0]).toMatchObject({ sku: 'VT-108-8MM', product_name: 'Vòng tay trầm 108 hạt', variant_name: 'Hạt 8 mm', unit_price: 500_000, extra_beads: 2, extra_bead_unit_price: 20_000, line_total: 540_000 });
    const movement = await db.selectFrom('inventory_movements').selectAll().where('order_id', '=', order.id).executeTakeFirstOrThrow();
    expect(movement).toMatchObject({ change: -1, stock_after: 1, reason: 'order_placed' });
    const email = await db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    expect(email.to_email).toBe('b@example.com');
    expect(email.body_text).toMatch(body.code);
  });

  it('requires an Idempotency-Key header', async () => {
    const response = await call(app, { method: 'POST', url: '/api/orders', payload: { items: [{ variantId: catalog.variantB, quantity: 1 }], contact, shippingAddress, expectedTotal: 330_000 } });
    expect(response.statusCode).toBe(400);
  });

  it('requires phone and email for guest checkout (D5)', async () => {
    const response = await call(app, {
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': newKey() },
      payload: { items: [{ variantId: catalog.variantB, quantity: 1 }], contact: { fullName: 'A' }, shippingAddress, expectedTotal: 330_000 },
    });
    expect(response.statusCode).toBe(400);
    const fields = response.json().error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('contact.phone');
    expect(fields).toContain('contact.email');
  });

  it('ignores any price sent by the client', async () => {
    const response = await call(app, {
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': newKey() },
      payload: { items: [{ variantId: catalog.variantB, quantity: 1, unitPrice: 1 }], contact, shippingAddress, expectedTotal: 330_000, total: 1 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.total).toBe(330_000);
  });

  it('refuses when the total differs from what the customer saw, and changes nothing', async () => {
    const response = await placeOrder([{ variantId: catalog.variantB, quantity: 1 }], { expectedTotal: 300_000 });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'PRICE_CHANGED', details: { total: 330_000 } });
    expect(await stockOf(catalog.variantB)).toBe(1);
    expect(await db.selectFrom('orders').selectAll().execute()).toHaveLength(0);
  });

  it('detects a price change made by the admin after the customer got a quote', async () => {
    const items = [{ variantId: catalog.variantB, quantity: 1 }];
    const seen = (await quote(items)).json().data.total;
    await call(app, { method: 'PATCH', url: `/api/admin/variants/${catalog.variantB}`, cookie: admin, payload: { retailPrice: 350_000 } });
    const key = newKey();
    const response = await placeOrder(items, { key, expectedTotal: seen });
    expect(response.json().error.code).toBe('PRICE_CHANGED');
    expect(response.json().error.details.total).toBe(380_000);
    // The failed attempt stored nothing, so after reviewing, the same key works with the new total.
    expect((await placeOrder(items, { key, expectedTotal: 380_000 })).statusCode).toBe(201);
  });

  it('refuses out-of-stock and hidden variants with details', async () => {
    const out = await placeOrder([{ variantId: catalog.variantB, quantity: 2 }], { expectedTotal: 630_000 });
    expect(out.statusCode).toBe(409);
    expect(out.json().error.code).toBe('OUT_OF_STOCK');

    await call(app, { method: 'PATCH', url: `/api/admin/variants/${catalog.variantB}`, cookie: admin, payload: { status: 'hidden' } });
    const hidden = await placeOrder([{ variantId: catalog.variantB, quantity: 1 }], { expectedTotal: 330_000 });
    expect(hidden.json().error).toMatchObject({ code: 'OUT_OF_STOCK', details: [{ variantId: catalog.variantB, reason: 'unavailable' }] });
  });

  it('keeps the order snapshot when the product changes later', async () => {
    const code = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code;
    await call(app, { method: 'PATCH', url: `/api/admin/products/${catalog.productId}`, cookie: admin, payload: { name: 'Tên mới' } });
    await call(app, { method: 'PATCH', url: `/api/admin/variants/${catalog.variantB}`, cookie: admin, payload: { retailPrice: 999_000 } });
    const detail = (await call(app, { url: `/api/admin/orders/${await orderIdByCode(code)}`, cookie: admin })).json().data;
    expect(detail.items[0]).toMatchObject({ product_name: 'Vòng tay trầm 108 hạt', unit_price: 300_000 });
    expect(detail.access_token_hash).toBeUndefined();
  });

  it('cannot delete a product or variant that has been ordered', async () => {
    await placeOrder([{ variantId: catalog.variantB, quantity: 1 }]);
    expect((await call(app, { method: 'DELETE', url: `/api/admin/variants/${catalog.variantB}`, cookie: admin })).statusCode).toBe(409);
    expect((await call(app, { method: 'DELETE', url: `/api/admin/products/${catalog.productId}`, cookie: admin })).statusCode).toBe(409);
  });
});

describe('idempotency and concurrency', () => {
  it('a retried request with the same key returns the same order (no second order, stock taken once)', async () => {
    const key = newKey();
    const items = [{ variantId: catalog.variantA, quantity: 1 }];
    const first = await placeOrder(items, { key });
    const second = await placeOrder(items, { key });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ code: first.json().data.code, replayed: true, accessToken: null });
    expect(await db.selectFrom('orders').selectAll().execute()).toHaveLength(1);
    expect(await stockOf(catalog.variantA)).toBe(1);
  });

  it('the same key with a different body is refused without leaking the first order', async () => {
    const key = newKey();
    await placeOrder([{ variantId: catalog.variantA, quantity: 1 }], { key });
    const other = await placeOrder([{ variantId: catalog.variantB, quantity: 1 }], { key });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(other.body).not.toMatch('DTT-');
  });

  it('three simultaneous requests with the same key create exactly one order', async () => {
    const key = newKey();
    const items = [{ variantId: catalog.variantA, quantity: 1 }];
    const expectedTotal = (await quote(items)).json().data.total;
    const responses = await Promise.all([1, 2, 3].map(() => placeOrder(items, { key, expectedTotal })));
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 201]);
    expect(new Set(responses.map((r) => r.json().data.code)).size).toBe(1);
    expect(await db.selectFrom('orders').selectAll().execute()).toHaveLength(1);
    expect(await stockOf(catalog.variantA)).toBe(1);
  });

  it('five customers racing for the last item: exactly one wins, stock never goes negative', async () => {
    const items = [{ variantId: catalog.variantB, quantity: 1 }];
    const expectedTotal = (await quote(items)).json().data.total;
    const responses = await Promise.all([1, 2, 3, 4, 5].map(() => placeOrder(items, { expectedTotal })));
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(responses.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'OUT_OF_STOCK')).toBe(true);
    expect(await stockOf(catalog.variantB)).toBe(0);
    expect(await db.selectFrom('orders').selectAll().execute()).toHaveLength(1);
  });

  it('orders touching the same two variants in opposite order do not deadlock', async () => {
    await call(app, { method: 'POST', url: `/api/admin/variants/${catalog.variantB}/stock-adjustments`, cookie: admin, payload: { change: 9, note: 'test' } });
    const one = [{ variantId: catalog.variantA, quantity: 1 }, { variantId: catalog.variantB, quantity: 1 }];
    const two = [{ variantId: catalog.variantB, quantity: 1 }, { variantId: catalog.variantA, quantity: 1 }];
    const t1 = (await quote(one)).json().data.total;
    const responses = await Promise.all([placeOrder(one, { expectedTotal: t1 }), placeOrder(two, { expectedTotal: t1 })]);
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(await stockOf(catalog.variantA)).toBe(0);
    expect(await stockOf(catalog.variantB)).toBe(8);
  });
});

describe('business customers', () => {
  it('pay business prices and can request a VAT invoice from their account data', async () => {
    const { cookie } = await registerApprovedBusiness(app, admin);
    const items = [{ variantId: catalog.variantA, quantity: 1, extraBeads: 1 }];
    const response = await placeOrder(items, { cookie, extra: { requestInvoice: true } });
    expect(response.statusCode).toBe(201);
    const order = await db.selectFrom('orders').selectAll().where('code', '=', response.json().data.code).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ price_tier: 'business', subtotal: 415_000, invoice_requested: true, invoice_tax_code: '0312345678', invoice_company_name: 'Công ty TNHH Mẫu' });
  });

  it('guests and personal accounts cannot request an invoice', async () => {
    const guest = await placeOrder([{ variantId: catalog.variantA, quantity: 1 }], { extra: { requestInvoice: true } });
    expect(guest.statusCode).toBe(400);
  });
});

describe('customer access to orders', () => {
  it('guest lookup by code + phone shows a reduced view; wrong phone finds nothing', async () => {
    const code = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code;
    const ok = await call(app, { method: 'POST', url: '/api/orders/lookup', payload: { code: code.toLowerCase(), phone: '0987 654 321' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.shipping).toEqual({ province: 'TP. Hồ Chí Minh' });
    expect(ok.body).not.toMatch('b@example.com');
    const wrong = await call(app, { method: 'POST', url: '/api/orders/lookup', payload: { code, phone: '0900000000' } });
    expect(wrong.statusCode).toBe(404);
  });

  it('the secret link gives the full view; a wrong token gives 404', async () => {
    const created = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data;
    const ok = await call(app, { method: 'POST', url: '/api/orders/access', payload: { code: created.code, token: created.accessToken } });
    expect(ok.json().data).toMatchObject({ canCancel: true, shipping: { addressLine: '12 Lê Lợi', email: 'b@example.com' } });
    const bad = await call(app, { method: 'POST', url: '/api/orders/access', payload: { code: created.code, token: 'x'.repeat(43) } });
    expect(bad.statusCode).toBe(404);
  });

  it('a customer only sees their own orders', async () => {
    const alice = await registerCustomer(app);
    const bob = await registerCustomer(app);
    const code = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }], { cookie: alice.cookie })).json().data.code;
    expect((await call(app, { url: `/api/account/orders/${code}`, cookie: alice.cookie })).statusCode).toBe(200);
    expect((await call(app, { url: `/api/account/orders/${code}`, cookie: bob.cookie })).statusCode).toBe(404);
    expect((await call(app, { method: 'POST', url: `/api/account/orders/${code}/cancel`, cookie: bob.cookie, payload: {} })).statusCode).toBe(404);
    expect((await call(app, { url: '/api/account/orders', cookie: bob.cookie })).json().meta.total).toBe(0);
    expect((await call(app, { url: '/api/account/orders', cookie: alice.cookie })).json().meta.total).toBe(1);
  });
});

describe('cancelling and restocking', () => {
  it('a guest cancel restores stock exactly once, even when repeated', async () => {
    const created = (await placeOrder([{ variantId: catalog.variantA, quantity: 2 }])).json().data;
    expect(await stockOf(catalog.variantA)).toBe(0);
    const payload = { code: created.code, token: created.accessToken };
    const results = await Promise.all([1, 2, 3].map(() => call(app, { method: 'POST', url: '/api/orders/cancel', payload })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await stockOf(catalog.variantA)).toBe(2);
    const restocks = await db.selectFrom('inventory_movements').selectAll().where('reason', '=', 'order_cancelled').execute();
    expect(restocks).toHaveLength(1);
  });

  it('a customer cannot cancel after the shop confirmed', async () => {
    const created = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data;
    await adminAction(await orderIdByCode(created.code), 'confirm');
    const response = await call(app, { method: 'POST', url: '/api/orders/cancel', payload: { code: created.code, token: created.accessToken } });
    expect(response.statusCode).toBe(409);
    expect(await stockOf(catalog.variantB)).toBe(0);
  });

  it('two admins cancelling at the same time restock once', async () => {
    const code = (await placeOrder([{ variantId: catalog.variantA, quantity: 1 }])).json().data.code;
    const id = await orderIdByCode(code);
    const results = await Promise.all([adminAction(id, 'cancel', { reason: 'Khách đổi ý' }), adminAction(id, 'cancel', { reason: 'Khách đổi ý' })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await stockOf(catalog.variantA)).toBe(2);
  });
});

describe('admin order workflow', () => {
  it('follows the COD flow; delivered is not paid; invalid steps are refused', async () => {
    const id = await orderIdByCode((await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code);

    const early = await adminAction(id, 'deliver');
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', details: { availableActions: ['confirm', 'cancel'] } });

    expect((await adminAction(id, 'confirm')).statusCode).toBe(200);
    expect((await adminAction(id, 'start_packing')).statusCode).toBe(200);
    expect((await adminAction(id, 'ship')).statusCode).toBe(400); // carrier + tracking required
    expect((await adminAction(id, 'ship', { carrier: 'GHN', trackingNumber: 'GHN123' })).statusCode).toBe(200);
    expect((await adminAction(id, 'cancel', { reason: 'x' })).statusCode).toBe(409); // already shipped

    const delivered = (await adminAction(id, 'deliver')).json().data;
    expect(delivered).toMatchObject({ fulfillmentStatus: 'delivered', paymentStatus: 'unpaid' });
    expect((await adminAction(id, 'complete')).statusCode).toBe(409); // COD not collected yet
    expect((await adminAction(id, 'mark_paid')).json().data.paymentStatus).toBe('paid');
    const done = (await adminAction(id, 'complete')).json().data;
    expect(done).toMatchObject({ orderStatus: 'completed', availableActions: [] });

    const detail = (await call(app, { url: `/api/admin/orders/${id}`, cookie: admin })).json().data;
    expect(detail.events.map((e: { action: string }) => e.action)).toEqual(['order_placed', 'confirm', 'start_packing', 'ship', 'deliver', 'mark_paid', 'complete']);
    expect(detail).toMatchObject({ carrier: 'GHN', tracking_number: 'GHN123' });

    const subjects = (await db.selectFrom('email_outbox').select('body_text').execute()).map((e) => e.body_text).join('\n');
    expect(subjects).toMatch('GHN123');
  });

  it('a returned parcel restocks, and a refund is only possible after payment', async () => {
    const id = await orderIdByCode((await placeOrder([{ variantId: catalog.variantA, quantity: 1 }])).json().data.code);
    await adminAction(id, 'confirm');
    await adminAction(id, 'start_packing');
    await adminAction(id, 'ship', { carrier: 'GHTK', trackingNumber: 'T1' });
    expect((await adminAction(id, 'mark_returned')).statusCode).toBe(400); // reason required
    const returned = (await adminAction(id, 'mark_returned', { reason: 'Không liên lạc được' })).json().data;
    expect(returned).toMatchObject({ orderStatus: 'cancelled', fulfillmentStatus: 'returned' });
    expect(await stockOf(catalog.variantA)).toBe(2);
    expect((await adminAction(id, 'mark_refunded')).statusCode).toBe(409); // never paid
  });

  it('lists and filters orders, and the dashboard counts them', async () => {
    await placeOrder([{ variantId: catalog.variantA, quantity: 1 }]);
    const second = (await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code;
    await adminAction(await orderIdByCode(second), 'confirm');

    const pending = (await call(app, { url: '/api/admin/orders?orderStatus=pending', cookie: admin })).json();
    expect(pending.meta.total).toBe(1);
    const search = (await call(app, { url: `/api/admin/orders?q=${second}`, cookie: admin })).json();
    expect(search.data[0].code).toBe(second);
    const byName = (await call(app, { url: `/api/admin/orders?q=${encodeURIComponent('tran thi')}`, cookie: admin })).json();
    expect(byName.meta.total).toBe(2);

    const dashboard = (await call(app, { url: '/api/admin/dashboard', cookie: admin })).json().data;
    expect(dashboard.orders).toMatchObject({ pending: 1, toShip: 1, today: 2 });
    expect(dashboard.lowStockVariants.map((v: { sku: string }) => v.sku).sort()).toEqual(['VT-108-10MM', 'VT-108-8MM']);
  });
});

describe('admin edits contact and shipping details', () => {
  it('updates the address with a reason and records old → new values in the history', async () => {
    const id = await orderIdByCode((await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code);
    const noReason = await call(app, { method: 'PATCH', url: `/api/admin/orders/${id}/details`, cookie: admin, payload: { phone: '0911111111' } });
    expect(noReason.statusCode).toBe(400);

    const response = await call(app, {
      method: 'PATCH',
      url: `/api/admin/orders/${id}/details`,
      cookie: admin,
      payload: { phone: '0911 111 111', shippingAddressLine: '99 Nguyễn Huệ', reason: 'Khách gọi đổi địa chỉ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ phone: '0911111111', shipping_address_line: '99 Nguyễn Huệ', total: 330_000 });
    expect(response.json().data.access_token_hash).toBeUndefined();

    const event = await db.selectFrom('order_events').selectAll().where('order_id', '=', id).where('action', '=', 'details_updated').executeTakeFirstOrThrow();
    expect(event.note).toMatch('Khách gọi đổi địa chỉ');
    expect(event.note).toMatch('"12 Lê Lợi" → "99 Nguyễn Huệ"');
    expect(event.note).toMatch('"0987654321" → "0911111111"');
  });

  it('records nothing when no value actually changes', async () => {
    const id = await orderIdByCode((await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code);
    await call(app, { method: 'PATCH', url: `/api/admin/orders/${id}/details`, cookie: admin, payload: { phone: '0987654321', reason: 'Kiểm tra' } });
    expect(await db.selectFrom('order_events').selectAll().where('action', '=', 'details_updated').execute()).toHaveLength(0);
  });

  it('refuses edits once the parcel has shipped', async () => {
    const id = await orderIdByCode((await placeOrder([{ variantId: catalog.variantB, quantity: 1 }])).json().data.code);
    await adminAction(id, 'confirm');
    await adminAction(id, 'start_packing');
    expect((await call(app, { method: 'PATCH', url: `/api/admin/orders/${id}/details`, cookie: admin, payload: { shippingWard: 'Phường Mới', reason: 'Đổi' } })).statusCode).toBe(200);
    await adminAction(id, 'ship', { carrier: 'GHN', trackingNumber: 'X1' });
    const late = await call(app, { method: 'PATCH', url: `/api/admin/orders/${id}/details`, cookie: admin, payload: { shippingWard: 'Phường Khác', reason: 'Đổi' } });
    expect(late.statusCode).toBe(409);
  });
});

