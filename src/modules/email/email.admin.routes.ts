import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { pageMeta } from '../../lib/http.js';
import { requireAdmin } from '../admin-auth/require-admin.js';
import { writeAuditLog } from '../audit/audit.service.js';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'sent', 'failed']).optional(),
});

/** Lets the admin see which emails could not be sent and try again (e.g. after fixing SMTP settings). */
export function emailAdminRoutes(deps: { db: Db }) {
  const { db } = deps;
  return async function register(app: FastifyInstance) {
    app.addHook('preHandler', requireAdmin(db));

    app.get('/emails', async (request) => {
      const query = ListQuery.parse(request.query);
      let base = db.selectFrom('email_outbox');
      if (query.status) base = base.where('status', '=', query.status);
      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      // The body is NOT returned: password-reset emails contain a secret link that the admin must not see.
      const rows = await base
        .select(['id', 'to_email', 'subject', 'status', 'attempts', 'last_error', 'created_at', 'sent_at', 'send_after'])
        .orderBy('id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return { data: rows, meta: pageMeta(query.page, query.pageSize, totalRow.total) };
    });

    app.post('/emails/:id/retry', async (request) => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const row = await db
        .updateTable('email_outbox')
        .set({ status: 'pending', attempts: 0, last_error: null, send_after: sql`now()` })
        .where('id', '=', id)
        .where('status', '=', 'failed')
        .returning(['id', 'status'])
        .executeTakeFirst();
      if (!row) throw new AppError(409, 'CONFLICT', 'Chỉ gửi lại được email đang ở trạng thái lỗi.');
      await writeAuditLog(db, { actor_type: 'admin', actor_id: request.admin!.id, action: 'email.retry', entity_type: 'email_outbox', entity_id: String(id) });
      return { data: row };
    });
  };
}

