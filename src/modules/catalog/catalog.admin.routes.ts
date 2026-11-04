import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/client.js';
import { conflict, isForeignKeyViolation, isUniqueViolation, notFound } from '../../lib/errors.js';
import { IdParam, PaginationQuery, pageMeta } from '../../lib/http.js';
import { slugify } from '../../lib/slug.js';
import { requireAdmin } from '../admin-auth/require-admin.js';
import {
  AdminProductListQuery,
  CategoryBody,
  CollectionBody,
  ProductCreateBody,
  ProductUpdateBody,
  StockAdjustmentBody,
  TagBody,
  VariantCreateBody,
  VariantUpdateBody,
} from './catalog.schemas.js';
import {
  adjustStock,
  createProduct,
  createVariant,
  deleteProduct,
  deleteVariant,
  updateProduct,
  updateVariant,
} from './products.service.js';

function slugTaken(error: unknown): never {
  if (isUniqueViolation(error)) throw conflict('Slug đã tồn tại. Hãy đổi slug khác.');
  if (isForeignKeyViolation(error)) throw conflict('Dữ liệu liên quan không tồn tại hoặc đang được sử dụng.');
  throw error;
}

export function catalogAdminRoutes(deps: { db: Db }) {
  const { db } = deps;

  return async function register(app: FastifyInstance) {
    app.addHook('preHandler', requireAdmin(db));

    // ---------- Categories ----------

    app.get('/categories', async () => {
      const rows = await db
        .selectFrom('categories as c')
        .selectAll('c')
        .select(sql<number>`(select count(*) from products p where p.category_id = c.id)::int`.as('product_count'))
        .orderBy('c.sort_order')
        .orderBy('c.name')
        .execute();
      return { data: rows };
    });

    app.post('/categories', async (request, reply) => {
      const body = CategoryBody.parse(request.body);
      const row = await db
        .insertInto('categories')
        .values({
          name: body.name,
          slug: body.slug ?? slugify(body.name),
          parent_id: body.parentId ?? null,
          description: body.description,
          sort_order: body.sortOrder,
          is_visible: body.isVisible,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(slugTaken);
      return reply.status(201).send({ data: row });
    });

    app.patch('/categories/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = CategoryBody.partial().parse(request.body);
      if (body.parentId === id) throw conflict('Danh mục không thể là cha của chính nó.');
      const row = await db
        .updateTable('categories')
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.slug !== undefined && { slug: body.slug }),
          ...(body.parentId !== undefined && { parent_id: body.parentId }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
          ...(body.isVisible !== undefined && { is_visible: body.isVisible }),
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
        .catch(slugTaken);
      if (!row) throw notFound('Không tìm thấy danh mục.');
      return { data: row };
    });

    app.delete('/categories/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      // FK "ON DELETE RESTRICT" refuses the delete when products or sub-categories still use it.
      const result = await db
        .deleteFrom('categories')
        .where('id', '=', id)
        .executeTakeFirst()
        .catch((error) => {
          if (isForeignKeyViolation(error)) throw conflict('Danh mục còn sản phẩm hoặc danh mục con, không thể xóa. Hãy ẩn danh mục.');
          throw error;
        });
      if (Number(result.numDeletedRows) === 0) throw notFound('Không tìm thấy danh mục.');
      return reply.status(204).send();
    });

    // ---------- Collections ----------

    app.get('/collections', async () => {
      const rows = await db
        .selectFrom('collections as c')
        .selectAll('c')
        .select(sql<number>`(select count(*) from product_collections pc where pc.collection_id = c.id)::int`.as('product_count'))
        .orderBy('c.sort_order')
        .orderBy('c.name')
        .execute();
      return { data: rows };
    });

    app.post('/collections', async (request, reply) => {
      const body = CollectionBody.parse(request.body);
      const row = await db
        .insertInto('collections')
        .values({
          name: body.name,
          slug: body.slug ?? slugify(body.name),
          description: body.description,
          image_url: body.imageUrl,
          sort_order: body.sortOrder,
          is_visible: body.isVisible,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(slugTaken);
      return reply.status(201).send({ data: row });
    });

    app.patch('/collections/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = CollectionBody.partial().parse(request.body);
      const row = await db
        .updateTable('collections')
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.slug !== undefined && { slug: body.slug }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.imageUrl !== undefined && { image_url: body.imageUrl }),
          ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
          ...(body.isVisible !== undefined && { is_visible: body.isVisible }),
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
        .catch(slugTaken);
      if (!row) throw notFound('Không tìm thấy bộ sưu tập.');
      return { data: row };
    });

    // Deleting a collection only removes the grouping; the products themselves stay.
    app.delete('/collections/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      const result = await db.deleteFrom('collections').where('id', '=', id).executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw notFound('Không tìm thấy bộ sưu tập.');
      return reply.status(204).send();
    });

    // ---------- Tags (audience / need filters) ----------

    app.get('/tags', async () => {
      return { data: await db.selectFrom('tags').selectAll().orderBy('type').orderBy('sort_order').orderBy('name').execute() };
    });

    app.post('/tags', async (request, reply) => {
      const body = TagBody.parse(request.body);
      const row = await db
        .insertInto('tags')
        .values({ type: body.type, name: body.name, slug: body.slug ?? slugify(body.name), sort_order: body.sortOrder })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(slugTaken);
      return reply.status(201).send({ data: row });
    });

    app.patch('/tags/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = TagBody.partial().parse(request.body);
      const row = await db
        .updateTable('tags')
        .set({
          ...(body.type !== undefined && { type: body.type }),
          ...(body.name !== undefined && { name: body.name }),
          ...(body.slug !== undefined && { slug: body.slug }),
          ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
        .catch(slugTaken);
      if (!row) throw notFound('Không tìm thấy thẻ lọc.');
      return { data: row };
    });

    app.delete('/tags/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      const result = await db.deleteFrom('tags').where('id', '=', id).executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw notFound('Không tìm thấy thẻ lọc.');
      return reply.status(204).send();
    });

    // ---------- Products ----------

    app.get('/products', async (request) => {
      const query = AdminProductListQuery.parse(request.query);

      let base = db.selectFrom('products as p').innerJoin('categories as c', 'c.id', 'p.category_id');
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        // Search by product name or by any of its SKUs.
        base = base.where((eb) =>
          eb.or([
            eb('p.name', 'ilike', pattern),
            eb.exists(eb.selectFrom('product_variants as v').select('v.id').whereRef('v.product_id', '=', 'p.id').where('v.sku', 'ilike', pattern)),
          ]),
        );
      }
      if (query.status) base = base.where('p.status', '=', query.status);
      if (query.categoryId) base = base.where('p.category_id', '=', query.categoryId);
      if (query.lowStock !== undefined) {
        base = base.where(sql<boolean>`exists (select 1 from product_variants v where v.product_id = p.id and v.status = 'active' and v.stock <= ${query.lowStock})`);
      }

      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'p.id',
          'p.name',
          'p.slug',
          'p.status',
          'p.updated_at',
          'c.name as category_name',
          sql<number>`(select count(*) from product_variants v where v.product_id = p.id)::int`.as('variant_count'),
          sql<number>`(select coalesce(sum(v.stock), 0) from product_variants v where v.product_id = p.id)::int`.as('total_stock'),
          sql<number | null>`(select min(v.retail_price) from product_variants v where v.product_id = p.id)`.as('min_retail_price'),
          sql<string | null>`(select i.url from product_images i where i.product_id = p.id order by i.sort_order limit 1)`.as('image_url'),
        ])
        .orderBy('p.updated_at', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return { data: rows, meta: pageMeta(query.page, query.pageSize, totalRow.total) };
    });

    app.get('/products/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const product = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
      if (!product) throw notFound('Không tìm thấy sản phẩm.');

      const [images, variants, tags, collections] = await Promise.all([
        db.selectFrom('product_images').selectAll().where('product_id', '=', id).orderBy('sort_order').execute(),
        db.selectFrom('product_variants').selectAll().where('product_id', '=', id).orderBy('sort_order').orderBy('created_at').execute(),
        db.selectFrom('product_tags').select('tag_id').where('product_id', '=', id).execute(),
        db.selectFrom('product_collections').select('collection_id').where('product_id', '=', id).execute(),
      ]);
      return {
        data: {
          ...product,
          images,
          variants,
          tagIds: tags.map((t) => t.tag_id),
          collectionIds: collections.map((c) => c.collection_id),
        },
      };
    });

    app.post('/products', async (request, reply) => {
      const body = ProductCreateBody.parse(request.body);
      const id = await createProduct(db, body, request.admin!.id);
      return reply.status(201).send({ data: { id } });
    });

    app.patch('/products/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = ProductUpdateBody.parse(request.body);
      await updateProduct(db, id, body, request.admin!.id);
      return { data: { id } };
    });

    app.delete('/products/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      await deleteProduct(db, id, request.admin!.id);
      return reply.status(204).send();
    });

    // ---------- Variants & stock ----------

    app.post('/products/:id/variants', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      const body = VariantCreateBody.parse(request.body);
      const variantId = await createVariant(db, id, body, request.admin!.id);
      return reply.status(201).send({ data: { id: variantId } });
    });

    app.patch('/variants/:id', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = VariantUpdateBody.parse(request.body);
      await updateVariant(db, id, body, request.admin!.id);
      return { data: { id } };
    });

    app.delete('/variants/:id', async (request, reply) => {
      const { id } = IdParam.parse(request.params);
      await deleteVariant(db, id, request.admin!.id);
      return reply.status(204).send();
    });

    app.post('/variants/:id/stock-adjustments', async (request) => {
      const { id } = IdParam.parse(request.params);
      const body = StockAdjustmentBody.parse(request.body);
      const stock = await adjustStock(db, id, body.change, body.note, request.admin!.id);
      return { data: { id, stock } };
    });

    app.get('/variants/:id/stock-movements', async (request) => {
      const { id } = IdParam.parse(request.params);
      const { page, pageSize } = PaginationQuery.parse(request.query);
      const base = db.selectFrom('inventory_movements').where('variant_id', '=', id);
      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .selectAll()
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return { data: rows, meta: pageMeta(page, pageSize, totalRow.total) };
    });
  };
}
