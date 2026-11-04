import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { emailSchema, optionalText, pageMeta, PaginationQuery, phoneSchema } from '../../lib/http.js';
import { getOptionalCustomer, priceTierFor, requireCustomer } from '../customer-auth/customer-session.js';
import { priceCart, shippingFeeFor } from './cart-pricing.js';
import { cancelByCustomer, createOrder, customerOrderView, findOrderByAccessToken } from './orders.service.js';

const CartItems = z
  .array(
    z.object({
      variantId: z.string().uuid(),
      quantity: z.number().int().min(1, 'Số lượng tối thiểu là 1.').max(999),
      extraBeads: z.number().int().min(0).max(100).default(0),
    }),
  )
  .min(1, 'Giỏ hàng đang trống.')
  .max(50);

const CreateOrderBody = z.object({
  items: CartItems,
  contact: z.object({
    fullName: z.string().trim().min(1, 'Vui lòng nhập họ tên người nhận.').max(200),
    phone: phoneSchema,
    email: emailSchema,
  }),
  shippingAddress: z.object({
    province: z.string().trim().min(1, 'Vui lòng chọn tỉnh/thành phố.').max(100),
    ward: z.string().trim().min(1, 'Vui lòng chọn phường/xã.').max(100),
    addressLine: z.string().trim().min(1, 'Vui lòng nhập địa chỉ (số nhà, đường).').max(300),
  }),
  note: optionalText(1000),
  requestInvoice: z.boolean().default(false),
  expectedTotal: z.number().int().min(0),
});

const orderCode = z.string().trim().toUpperCase().regex(/^DTT-\d{6}-[A-Z0-9]{6}$/, 'Mã đơn không hợp lệ.');

export function orderRoutes(deps: { db: Db; env: Env }) {
  const { db, env } = deps;

  return async function register(app: FastifyInstance) {
    // Price check for the cart / checkout page. Does not reserve stock.
    app.post('/checkout/quote', async (request) => {
      const { items } = z.object({ items: CartItems }).parse(request.body);
      const customer = await getOptionalCustomer(db, request);
      const cart = await priceCart(db, items, priceTierFor(customer), { lockVariants: false });
      const shippingFee = await shippingFeeFor(db, cart.subtotal);
      return { data: { ...cart, shippingFee, total: cart.subtotal + shippingFee } };
    });

    // Place an order (guest or logged in). The frontend generates one Idempotency-Key per checkout
    // attempt (e.g. crypto.randomUUID()) and re-sends the SAME key if it retries.
    app.post('/orders', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
        throw badRequest('Thiếu hoặc sai header Idempotency-Key (16–100 ký tự chữ, số, "-" hoặc "_").');
      }
      const body = CreateOrderBody.parse(request.body);
      const customer = await getOptionalCustomer(db, request);

      const result = await createOrder(db, env, { idempotencyKey, customer, tier: priceTierFor(customer), input: body });
      return reply.status(result.replayed ? 200 : 201).send({
        data: {
          code: result.order.code,
          total: result.order.total,
          orderStatus: result.order.order_status,
          // Only on the first response: lets the order page open without logging in.
          accessToken: result.accessToken,
          replayed: result.replayed,
        },
      });
    });

    // Guest lookup by order code + phone. Returns a reduced view (no full address, no email).
    app.post('/orders/lookup', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
      const body = z.object({ code: orderCode, phone: phoneSchema }).parse(request.body);
      const order = await db.selectFrom('orders').selectAll().where('code', '=', body.code).where('phone', '=', body.phone).executeTakeFirst();
      // Same message whether the code or the phone is wrong.
      if (!order) throw notFound('Không tìm thấy đơn hàng với mã và số điện thoại này.');
      return { data: await customerOrderView(db, order, false) };
    });

    // Full view through the secret link in the confirmation email.
    app.post('/orders/access', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (request) => {
      const body = z.object({ code: orderCode, token: z.string().min(20).max(200) }).parse(request.body);
      const order = await findOrderByAccessToken(db, body.code, body.token);
      return { data: await customerOrderView(db, order, true) };
    });

    app.post('/orders/cancel', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
      const body = z.object({ code: orderCode, token: z.string().min(20).max(200), reason: optionalText(500) }).parse(request.body);
      const order = await findOrderByAccessToken(db, body.code, body.token);
      const updated = await cancelByCustomer(db, order.id, { type: 'guest', id: null }, body.reason);
      return { data: await customerOrderView(db, updated, true) };
    });

    // ---------- Logged-in customer ----------

    app.get('/account/orders', { preHandler: requireCustomer(db) }, async (request) => {
      const { page, pageSize } = PaginationQuery.parse(request.query);
      const base = db.selectFrom('orders').where('customer_id', '=', request.customer!.id);
      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['code', 'created_at as createdAt', 'total', 'order_status as orderStatus', 'payment_status as paymentStatus', 'fulfillment_status as fulfillmentStatus'])
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return { data: rows, meta: pageMeta(page, pageSize, totalRow.total) };
    });

    app.get('/account/orders/:code', { preHandler: requireCustomer(db) }, async (request) => {
      const { code } = z.object({ code: orderCode }).parse(request.params);
      // customer_id in the WHERE: a customer can never open someone else's order.
      const order = await db.selectFrom('orders').selectAll().where('code', '=', code).where('customer_id', '=', request.customer!.id).executeTakeFirst();
      if (!order) throw notFound('Không tìm thấy đơn hàng.');
      return { data: await customerOrderView(db, order, true) };
    });

    app.post('/account/orders/:code/cancel', { preHandler: requireCustomer(db) }, async (request) => {
      const { code } = z.object({ code: orderCode }).parse(request.params);
      const { reason } = z.object({ reason: optionalText(500) }).parse(request.body ?? {});
      const order = await db.selectFrom('orders').select('id').where('code', '=', code).where('customer_id', '=', request.customer!.id).executeTakeFirst();
      if (!order) throw notFound('Không tìm thấy đơn hàng.');
      const updated = await cancelByCustomer(db, order.id, { type: 'customer', id: request.customer!.id }, reason);
      return { data: await customerOrderView(db, updated, true) };
    });
  };
}
