import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError, notFound } from '../../lib/errors.js';
import { IdParam, pageMeta } from '../../lib/http.js';
import { requireAdmin } from '../admin-auth/require-admin.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { enqueueEmail } from '../email/outbox.js';
import { businessReviewEmail } from '../email/templates.js';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  accountType: z.enum(['personal', 'business']).optional(),
  businessStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
});

// Never send password hashes to the admin UI.
const CUSTOMER_COLUMNS = [
  'id',
  'email',
  'full_name',
  'phone',
  'account_type',
  'status',
  'business_status',
  'company_name',
  'tax_code',
  'invoice_address',
  'business_reviewed_at',
  'business_rejection_reason',
  'created_at',
] as const;

export function adminCustomerRoutes(deps: { db: Db }) {
  const { db } = deps;

  return async function register(app: FastifyInstance) {
    app.addHook('preHandler', requireAdmin(db));

    app.get('/customers', async (request) => {
      const query = ListQuery.parse(request.query);
      let base = db.selectFrom('customers');
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        base = base.where((eb) =>
          eb.or([eb('email', 'ilike', pattern), eb('full_name', 'ilike', pattern), eb('phone', 'like', pattern), eb('tax_code', 'like', pattern), eb('company_name', 'ilike', pattern)]),
        );
      }
      if (query.accountType) base = base.where('account_type', '=', query.accountType);
      if (query.businessStatus) base = base.where('business_status', '=', query.businessStatus);

      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select(CUSTOMER_COLUMNS)
        .orderBy('created_at', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return { data: rows, meta: pageMeta(query.page, query.pageSize, totalRow.total) };
    });

    app.get('/customers/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const customer = await db.selectFrom('customers').select(CUSTOMER_COLUMNS).where('id', '=', id).executeTakeFirst();
      if (!customer) throw notFound('Không tìm thấy khách hàng.');
      const recentOrders = await db
        .selectFrom('orders')
        .select(['id', 'code', 'total', 'order_status', 'payment_status', 'fulfillment_status', 'created_at'])
        .where('customer_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      return { data: { ...customer, recentOrders } };
    });

    // D9: approve / reject a business account after checking the tax code.
    app.post('/customers/:id/business-review', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = z
        .discriminatedUnion('decision', [
          z.object({ decision: z.literal('approve') }),
          z.object({ decision: z.literal('reject'), reason: z.string().trim().min(1, 'Vui lòng nhập lý do từ chối.').max(500) }),
        ])
        .parse(request.body);
      const approved = body.decision === 'approve';
      const reason = body.decision === 'reject' ? body.reason : null;

      const updated = await db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('customers')
          .set({
            business_status: approved ? 'approved' : 'rejected',
            business_reviewed_at: sql`now()`,
            business_reviewed_by: request.admin!.id,
            business_rejection_reason: reason,
            updated_at: sql`now()`,
          })
          .where('id', '=', id)
          .where('account_type', '=', 'business')
          .returning(['id', 'email'])
          .executeTakeFirst();
        if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản doanh nghiệp.');

        await writeAuditLog(trx, {
          actor_type: 'admin',
          actor_id: request.admin!.id,
          action: approved ? 'customer.business_approved' : 'customer.business_rejected',
          entity_type: 'customer',
          entity_id: id,
          ip_address: request.ip,
          metadata: reason ? { reason } : {},
        });
        await enqueueEmail(trx, businessReviewEmail(row.email, approved, reason));
        return row;
      });
      return { data: { id: updated.id, businessStatus: approved ? 'approved' : 'rejected' } };
    });

    app.post('/customers/:id/status', async (request) => {
      const { id } = IdParam.parse(request.params);
      const { status } = z.object({ status: z.enum(['active', 'disabled']) }).parse(request.body);
      await db.transaction().execute(async (trx) => {
        const row = await trx.updateTable('customers').set({ status, updated_at: sql`now()` }).where('id', '=', id).returning('id').executeTakeFirst();
        if (!row) throw notFound('Không tìm thấy khách hàng.');
        if (status === 'disabled') {
          await trx.updateTable('customer_sessions').set({ revoked_at: sql`now()` }).where('customer_id', '=', id).where('revoked_at', 'is', null).execute();
        }
        await writeAuditLog(trx, { actor_type: 'admin', actor_id: request.admin!.id, action: `customer.${status}`, entity_type: 'customer', entity_id: id });
      });
      return { data: { id, status } };
    });
  };
}
