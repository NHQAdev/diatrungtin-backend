import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { IdParam, pageMeta } from '../../lib/http.js';
import { requireAdmin } from '../admin-auth/require-admin.js';
import { availableActions } from './order-state.js';
import { applyAdminAction, getOrderItems } from './orders.service.js';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  orderStatus: z.enum(['pending', 'confirmed', 'completed', 'cancelled']).optional(),
  paymentStatus: z.enum(['unpaid', 'paid', 'refunded']).optional(),
  fulfillmentStatus: z.enum(['unfulfilled', 'packing', 'shipped', 'delivered', 'returned']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const ActionBody = z.object({
  action: z.enum(['confirm', 'start_packing', 'ship', 'deliver', 'mark_paid', 'complete', 'cancel', 'mark_returned', 'mark_refunded']),
  carrier: z.string().trim().min(1).max(100).optional(),
  trackingNumber: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  note: z.string().trim().max(1000).optional(),
});

export function adminOrderRoutes(deps: { db: Db }) {
  const { db } = deps;

  return async function register(app: FastifyInstance) {
    app.addHook('preHandler', requireAdmin(db));

    app.get('/orders', async (request) => {
      const query = ListQuery.parse(request.query);
      let base = db.selectFrom('orders');
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) =>
          eb.or([eb('code', 'ilike', pattern), eb('phone', 'like', pattern), eb('email', 'ilike', pattern), eb('customer_name', 'ilike', pattern)]),
        );
      }
      if (query.orderStatus) base = base.where('order_status', '=', query.orderStatus);
      if (query.paymentStatus) base = base.where('payment_status', '=', query.paymentStatus);
      if (query.fulfillmentStatus) base = base.where('fulfillment_status', '=', query.fulfillmentStatus);
      if (query.from) base = base.where('created_at', '>=', query.from);
      if (query.to) base = base.where('created_at', '<', query.to);

      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'id',
          'code',
          'customer_name',
          'phone',
          'total',
          'price_tier',
          'order_status',
          'payment_status',
          'fulfillment_status',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return { data: rows, meta: pageMeta(query.page, query.pageSize, totalRow.total) };
    });

    app.get('/orders/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const order = await db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
      if (!order) throw notFound('Không tìm thấy đơn hàng.');
      const [items, events] = await Promise.all([
        getOrderItems(db, id),
        db.selectFrom('order_events').selectAll().where('order_id', '=', id).orderBy('id').execute(),
      ]);
      const { access_token_hash: _secret, ...safeOrder } = order;
      return { data: { ...safeOrder, items, events, availableActions: availableActions(order) } };
    });

    app.post('/orders/:id/actions', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = ActionBody.parse(request.body);
      const order = await applyAdminAction(db, id, body, request.admin!.id);
      return {
        data: {
          id: order.id,
          orderStatus: order.order_status,
          paymentStatus: order.payment_status,
          fulfillmentStatus: order.fulfillment_status,
          availableActions: availableActions(order),
        },
      };
    });
  };
}
