import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { PaginationQuery, pageMeta, SlugParam } from '../../lib/http.js';
import { getOptionalCustomer, priceTierFor } from '../customer-auth/customer-session.js';
import { availableQuantity, extraBeadPriceFor, unitPriceFor } from './pricing.js';

const slugList = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []));

const ProductListQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().optional(),
  collection: z.string().trim().optional(),
  audience: slugList, // e.g. ?audience=tre-em
  need: slugList, // e.g. ?need=qua-tang,deo-hang-ngay
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'name_asc']).default('newest'),
});

/** Escape % and _ so user input is matched literally inside ILIKE. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function catalogPublicRoutes(deps: { db: Db }) {
  const { db } = deps;

  return async function register(app: FastifyInstance) {
    app.get('/categories', async () => {
      const rows = await db
        .selectFrom('categories')
        .select(['id', 'parent_id', 'name', 'slug', 'description', 'sort_order'])
        .where('is_visible', '=', true)
        .orderBy('sort_order')
        .orderBy('name')
        .execute();

      // Build a tree: top-level categories with their children.
      const tree = rows
        .filter((row) => row.parent_id === null)
        .map((parent) => ({
          id: parent.id,
          name: parent.name,
          slug: parent.slug,
          description: parent.description,
          children: rows
            .filter((child) => child.parent_id === parent.id)
            .map((child) => ({ id: child.id, name: child.name, slug: child.slug, description: child.description })),
        }));
      return { data: tree };
    });

    app.get('/collections', async () => {
      const rows = await db
        .selectFrom('collections')
        .select(['id', 'name', 'slug', 'description', 'image_url as imageUrl'])
        .where('is_visible', '=', true)
        .orderBy('sort_order')
        .orderBy('name')
        .execute();
      return { data: rows };
    });

    app.get('/tags', async (request) => {
      const { type } = z.object({ type: z.enum(['audience', 'need']).optional() }).parse(request.query);
      let query = db.selectFrom('tags').select(['id', 'type', 'name', 'slug']).orderBy('type').orderBy('sort_order').orderBy('name');
      if (type) query = query.where('type', '=', type);
      return { data: await query.execute() };
    });

    app.get('/products', async (request) => {
      const query = ProductListQuery.parse(request.query);
      const tier = priceTierFor(await getOptionalCustomer(db, request));

      // Lowest price among the product's active variants, for the viewer's price tier.
      const variantPrice = tier === 'business' ? sql`coalesce(v.business_price, v.retail_price)` : sql`v.retail_price`;
      const priceFrom = sql<number>`(select min(${variantPrice}) from product_variants v where v.product_id = p.id and v.status = 'active')`;
      const hasStock = sql<boolean>`exists (select 1 from product_variants v where v.product_id = p.id and v.status = 'active' and v.stock > 0)`;
      const mainImage = sql<string | null>`(select i.url from product_images i where i.product_id = p.id order by i.sort_order, i.id limit 1)`;

      let base = db
        .selectFrom('products as p')
        .innerJoin('categories as c', 'c.id', 'p.category_id')
        .where('p.status', '=', 'active')
        .where('c.is_visible', '=', true)
        // A product with no active variant cannot be bought: do not list it.
        .where(sql<boolean>`exists (select 1 from product_variants v where v.product_id = p.id and v.status = 'active')`);

      if (query.q) base = base.where('p.name', 'ilike', likePattern(query.q));
      if (query.category) {
        const slug = query.category;
        // Match the category itself and its direct children (e.g. "Nhang" includes "Nhang cây", "Nhang nụ").
        base = base.where((eb) =>
          eb.or([
            eb('c.slug', '=', slug),
            eb('c.parent_id', 'in', eb.selectFrom('categories').select('id').where('slug', '=', slug)),
          ]),
        );
      }
      if (query.collection) {
        base = base.where(sql<boolean>`exists (
          select 1 from product_collections pc join collections col on col.id = pc.collection_id
          where pc.product_id = p.id and col.slug = ${query.collection} and col.is_visible)`);
      }
      for (const [type, slugs] of [['audience', query.audience], ['need', query.need]] as const) {
        if (slugs.length > 0) {
          base = base.where(sql<boolean>`exists (
            select 1 from product_tags pt join tags t on t.id = pt.tag_id
            where pt.product_id = p.id and t.type = ${type} and t.slug in (${sql.join(slugs)}))`);
        }
      }
      if (query.minPrice !== undefined) base = base.where(sql<boolean>`${priceFrom} >= ${query.minPrice}`);
      if (query.maxPrice !== undefined) base = base.where(sql<boolean>`${priceFrom} <= ${query.maxPrice}`);
      if (query.inStock === 'true') base = base.where(hasStock);

      const totalRow = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();

      let listQuery = base.select([
        'p.id',
        'p.name',
        'p.slug',
        'p.short_description as shortDescription',
        'c.name as categoryName',
        'c.slug as categorySlug',
        priceFrom.as('priceFrom'),
        hasStock.as('inStock'),
        mainImage.as('imageUrl'),
      ]);
      if (query.sort === 'price_asc') listQuery = listQuery.orderBy(priceFrom, 'asc');
      else if (query.sort === 'price_desc') listQuery = listQuery.orderBy(priceFrom, 'desc');
      else if (query.sort === 'name_asc') listQuery = listQuery.orderBy('p.name', 'asc');
      else listQuery = listQuery.orderBy('p.created_at', 'desc');

      const rows = await listQuery
        .orderBy('p.id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();

      return { data: rows, meta: { ...pageMeta(query.page, query.pageSize, totalRow.total), priceTier: tier } };
    });

    app.get('/products/:slug', async (request) => {
      const { slug } = SlugParam.parse(request.params);
      const tier = priceTierFor(await getOptionalCustomer(db, request));

      const product = await db
        .selectFrom('products as p')
        .innerJoin('categories as c', 'c.id', 'p.category_id')
        .select([
          'p.id',
          'p.name',
          'p.slug',
          'p.short_description',
          'p.description',
          'p.material',
          'p.specs',
          'p.usage_guide',
          'p.seo_title',
          'p.seo_description',
          'c.id as category_id',
          'c.name as category_name',
          'c.slug as category_slug',
          'c.parent_id as category_parent_id',
        ])
        .where('p.slug', '=', slug)
        .where('p.status', '=', 'active')
        .where('c.is_visible', '=', true)
        .executeTakeFirst();
      if (!product) throw notFound('Không tìm thấy sản phẩm.');

      const [images, variants, tags, collections, parentCategory] = await Promise.all([
        db.selectFrom('product_images').select(['id', 'url', 'alt']).where('product_id', '=', product.id).orderBy('sort_order').orderBy('id').execute(),
        db.selectFrom('product_variants').selectAll().where('product_id', '=', product.id).where('status', '=', 'active').orderBy('sort_order').orderBy('retail_price').execute(),
        db
          .selectFrom('product_tags as pt')
          .innerJoin('tags as t', 't.id', 'pt.tag_id')
          .select(['t.type', 't.name', 't.slug'])
          .where('pt.product_id', '=', product.id)
          .execute(),
        db
          .selectFrom('product_collections as pc')
          .innerJoin('collections as col', 'col.id', 'pc.collection_id')
          .select(['col.name', 'col.slug'])
          .where('pc.product_id', '=', product.id)
          .where('col.is_visible', '=', true)
          .execute(),
        product.category_parent_id
          ? db.selectFrom('categories').select(['name', 'slug']).where('id', '=', product.category_parent_id).executeTakeFirst()
          : Promise.resolve(undefined),
      ]);
      if (variants.length === 0) throw notFound('Không tìm thấy sản phẩm.');

      return {
        data: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          shortDescription: product.short_description,
          description: product.description,
          material: product.material,
          specs: product.specs,
          usageGuide: product.usage_guide,
          seo: { title: product.seo_title ?? product.name, description: product.seo_description ?? product.short_description },
          // Breadcrumb: parent category (if any) → category → product.
          breadcrumb: [
            ...(parentCategory ? [{ name: parentCategory.name, slug: parentCategory.slug }] : []),
            { name: product.category_name, slug: product.category_slug },
          ],
          images,
          tags,
          collections,
          priceTier: tier,
          variants: variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            name: v.name,
            options: v.options,
            price: unitPriceFor(v, tier),
            retailPrice: v.retail_price,
            inStock: v.stock > 0,
            availableQuantity: availableQuantity(v.stock),
            maxExtraBeads: v.max_extra_beads,
            extraBeadPrice: v.max_extra_beads > 0 ? extraBeadPriceFor(v, tier) : null,
          })),
        },
      };
    });
  };
}
