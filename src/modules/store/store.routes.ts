import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { IdParam, optionalText, SlugParam, slugSchema } from '../../lib/http.js';
import { requireAdmin } from '../admin-auth/require-admin.js';
import { writeAuditLog } from '../audit/audit.service.js';

const SettingsBody = z.object({
  storeName: z.string().trim().min(1).max(200).optional(),
  hotline: optionalText(50),
  email: optionalText(254),
  address: optionalText(500),
  businessInfo: optionalText(2000),
  facebookUrl: optionalText(500),
  zaloUrl: optionalText(500),
  shippingFee: z.number().int().min(0).nullish(),
  freeShippingThreshold: z.number().int().positive().nullish(),
});

const PageBody = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000).default(''),
  isPublished: z.boolean().default(false),
});

async function readSettings(db: Db) {
  const row = await db.selectFrom('store_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
  return {
    storeName: row.store_name,
    // null = not provided yet; the frontend shows "[Cập nhật]".
    hotline: row.hotline,
    email: row.email,
    address: row.address,
    businessInfo: row.business_info,
    facebookUrl: row.facebook_url,
    zaloUrl: row.zalo_url,
    shippingFee: row.shipping_fee,
    freeShippingThreshold: row.free_shipping_threshold,
    updatedAt: row.updated_at,
  };
}

/** Public: store info for header/footer/checkout, and published content pages (policies…). */
export function storePublicRoutes(deps: { db: Db }) {
  const { db } = deps;
  return async function register(app: FastifyInstance) {
    app.get('/store', async () => ({ data: await readSettings(db) }));

    app.get('/pages', async () => {
      const rows = await db.selectFrom('pages').select(['slug', 'title']).where('is_published', '=', true).orderBy('title').execute();
      return { data: rows };
    });

    app.get('/pages/:slug', async (request) => {
      const { slug } = SlugParam.parse(request.params);
      const page = await db
        .selectFrom('pages')
        .select(['slug', 'title', 'content', 'updated_at as updatedAt'])
        .where('slug', '=', slug)
        .where('is_published', '=', true)
        .executeTakeFirst();
      if (!page) throw notFound('Không tìm thấy trang.');
      return { data: page };
    });
  };
}

export function storeAdminRoutes(deps: { db: Db }) {
  const { db } = deps;
  return async function register(app: FastifyInstance) {
    app.addHook('preHandler', requireAdmin(db));

    app.get('/store-settings', async () => ({ data: await readSettings(db) }));

    app.put('/store-settings', async (request) => {
      const body = SettingsBody.parse(request.body);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('store_settings')
          .set({
            ...(body.storeName !== undefined && { store_name: body.storeName }),
            ...(body.hotline !== undefined && { hotline: body.hotline }),
            ...(body.email !== undefined && { email: body.email }),
            ...(body.address !== undefined && { address: body.address }),
            ...(body.businessInfo !== undefined && { business_info: body.businessInfo }),
            ...(body.facebookUrl !== undefined && { facebook_url: body.facebookUrl }),
            ...(body.zaloUrl !== undefined && { zalo_url: body.zaloUrl }),
            ...(body.shippingFee !== undefined && { shipping_fee: body.shippingFee }),
            ...(body.freeShippingThreshold !== undefined && { free_shipping_threshold: body.freeShippingThreshold }),
            updated_at: sql`now()`,
          })
          .where('id', '=', 1)
          .execute();
        await writeAuditLog(trx, { actor_type: 'admin', actor_id: request.admin!.id, action: 'store.settings_updated', metadata: body });
      });
      return { data: await readSettings(db) };
    });

    app.get('/pages', async () => ({ data: await db.selectFrom('pages').selectAll().orderBy('title').execute() }));

    app.post('/pages', async (request, reply) => {
      const body = PageBody.parse(request.body);
      const row = await db
        .insertInto('pages')
        .values({ slug: body.slug, title: body.title, content: body.content, is_published: body.isPublished })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error) => {
          if (isUniqueViolation(error)) throw conflict('Slug trang đã tồn tại.');
          throw error;
        });
      return reply.status(201).send({ data: row });
    });

    app.patch('/pages/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = PageBody.partial().parse(request.body);
      const row = await db
        .updateTable('pages')
        .set({
          ...(body.slug !== undefined && { slug: body.slug }),
          ...(body.title !== undefined && { title: body.title }),
          ...(body.content !== undefined && { content: body.content }),
          ...(body.isPublished !== undefined && { is_published: body.isPublished }),
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
        .catch((error) => {
          if (isUniqueViolation(error)) throw conflict('Slug trang đã tồn tại.');
          throw error;
        });
      if (!row) throw notFound('Không tìm thấy trang.');
      return { data: row };
    });

    app.delete('/pages/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      const result = await db.deleteFrom('pages').where('id', '=', id).executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw notFound('Không tìm thấy trang.');
      return reply.status(204).send();
    });

    // Small overview for the admin home screen.
    app.get('/dashboard', async () => {
      const [orders, pendingBusiness, lowStock, failedEmails] = await Promise.all([
        db
          .selectFrom('orders')
          .select([
            sql<number>`count(*) filter (where order_status = 'pending')::int`.as('pending'),
            sql<number>`count(*) filter (where order_status = 'confirmed' and fulfillment_status in ('unfulfilled', 'packing'))::int`.as('toShip'),
            sql<number>`count(*) filter (where fulfillment_status = 'delivered' and payment_status = 'unpaid')::int`.as('codToCollect'),
            sql<number>`count(*) filter (where created_at >= date_trunc('day', now()))::int`.as('today'),
          ])
          .executeTakeFirstOrThrow(),
        db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('count')).where('business_status', '=', 'pending').executeTakeFirstOrThrow(),
        db
          .selectFrom('product_variants as v')
          .innerJoin('products as p', 'p.id', 'v.product_id')
          .select(['v.id', 'v.sku', 'v.name', 'v.stock', 'p.name as product_name'])
          .where('v.status', '=', 'active')
          .where('p.status', '=', 'active')
          .where('v.stock', '<=', 3)
          .orderBy('v.stock')
          .limit(20)
          .execute(),
        db.selectFrom('email_outbox').select((eb) => eb.fn.countAll<number>().as('count')).where('status', '=', 'failed').executeTakeFirstOrThrow(),
      ]);
      return {
        data: {
          orders,
          businessAccountsPending: pendingBusiness.count,
          lowStockVariants: lowStock,
          failedEmails: failedEmails.count,
        },
      };
    });
  };
}
