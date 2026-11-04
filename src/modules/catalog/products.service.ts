import { sql } from 'kysely';
import type { z } from 'zod';
import type { Db, DbOrTrx } from '../../db/client.js';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import { writeAuditLog } from '../audit/audit.service.js';
import type { ProductCreateBody, ProductUpdateBody, VariantCreateBody, VariantUpdateBody } from './catalog.schemas.js';

type ProductCreateInput = z.infer<typeof ProductCreateBody>;
type ProductUpdateInput = z.infer<typeof ProductUpdateBody>;
type VariantCreateInput = z.infer<typeof VariantCreateBody>;
type VariantUpdateInput = z.infer<typeof VariantUpdateBody>;

/** Turns unique-constraint errors into messages the admin can act on. */
function friendlyUniqueError(error: unknown): never {
  if (isUniqueViolation(error, 'products_slug_key')) throw conflict('Slug sản phẩm đã tồn tại. Hãy đổi slug khác.');
  if (isUniqueViolation(error, 'product_variants_sku_key')) throw conflict('SKU đã tồn tại.');
  if (isUniqueViolation(error, 'product_variants_product_options_key')) {
    throw conflict('Sản phẩm đã có phiên bản với cùng thuộc tính.');
  }
  throw error;
}

async function insertVariant(trx: DbOrTrx, productId: string, variant: VariantCreateInput, adminId: string) {
  const created = await trx
    .insertInto('product_variants')
    .values({
      product_id: productId,
      sku: variant.sku,
      name: variant.name,
      options: JSON.stringify(variant.options),
      retail_price: variant.retailPrice,
      business_price: variant.businessPrice ?? null,
      stock: variant.initialStock,
      max_extra_beads: variant.maxExtraBeads,
      extra_bead_price: variant.extraBeadPrice ?? null,
      business_extra_bead_price: variant.businessExtraBeadPrice ?? null,
      status: variant.status,
      sort_order: variant.sortOrder,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (variant.initialStock > 0) {
    await trx
      .insertInto('inventory_movements')
      .values({
        variant_id: created.id,
        change: variant.initialStock,
        stock_after: variant.initialStock,
        reason: 'initial',
        admin_user_id: adminId,
        note: 'Tồn kho ban đầu',
      })
      .execute();
  }
  return created.id;
}

async function replaceImagesTagsCollections(
  trx: DbOrTrx,
  productId: string,
  input: Pick<ProductUpdateInput, 'images' | 'tagIds' | 'collectionIds'>,
) {
  if (input.images) {
    await trx.deleteFrom('product_images').where('product_id', '=', productId).execute();
    if (input.images.length > 0) {
      await trx
        .insertInto('product_images')
        .values(input.images.map((image, index) => ({ product_id: productId, url: image.url, alt: image.alt, sort_order: index })))
        .execute();
    }
  }
  if (input.tagIds) {
    await trx.deleteFrom('product_tags').where('product_id', '=', productId).execute();
    const tagIds = [...new Set(input.tagIds)];
    if (tagIds.length > 0) {
      await trx.insertInto('product_tags').values(tagIds.map((tagId) => ({ product_id: productId, tag_id: tagId }))).execute();
    }
  }
  if (input.collectionIds) {
    await trx.deleteFrom('product_collections').where('product_id', '=', productId).execute();
    const collectionIds = [...new Set(input.collectionIds)];
    if (collectionIds.length > 0) {
      await trx
        .insertInto('product_collections')
        .values(collectionIds.map((collectionId, index) => ({ product_id: productId, collection_id: collectionId, sort_order: index })))
        .execute();
    }
  }
}

/** A product can only be "active" when customers can actually buy something from it. */
async function assertCanBeActive(trx: DbOrTrx, productId: string) {
  const activeVariant = await trx
    .selectFrom('product_variants')
    .select('id')
    .where('product_id', '=', productId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!activeVariant) throw badRequest('Sản phẩm cần ít nhất một phiên bản đang bán trước khi hiển thị.');
}

export async function createProduct(db: Db, input: ProductCreateInput, adminId: string): Promise<string> {
  try {
    return await db.transaction().execute(async (trx) => {
      const product = await trx
        .insertInto('products')
        .values({
          category_id: input.categoryId,
          name: input.name,
          slug: input.slug ?? slugify(input.name),
          short_description: input.shortDescription,
          description: input.description,
          material: input.material,
          specs: JSON.stringify(input.specs),
          usage_guide: input.usageGuide,
          status: input.status,
          seo_title: input.seoTitle,
          seo_description: input.seoDescription,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await replaceImagesTagsCollections(trx, product.id, input);
      for (const variant of input.variants) await insertVariant(trx, product.id, variant, adminId);
      if (input.status === 'active') await assertCanBeActive(trx, product.id);

      await writeAuditLog(trx, { actor_type: 'admin', actor_id: adminId, action: 'product.created', entity_type: 'product', entity_id: product.id });
      return product.id;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    friendlyUniqueError(error);
  }
}

export async function updateProduct(db: Db, productId: string, input: ProductUpdateInput, adminId: string): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('products').select('id').where('id', '=', productId).forUpdate().executeTakeFirst();
      if (!existing) throw notFound('Không tìm thấy sản phẩm.');

      await trx
        .updateTable('products')
        .set({
          ...(input.categoryId !== undefined && { category_id: input.categoryId }),
          ...(input.name !== undefined && { name: input.name }),
          ...(input.slug !== undefined && { slug: input.slug }),
          ...(input.shortDescription !== undefined && { short_description: input.shortDescription }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.material !== undefined && { material: input.material }),
          ...(input.specs !== undefined && { specs: JSON.stringify(input.specs) }),
          ...(input.usageGuide !== undefined && { usage_guide: input.usageGuide }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.seoTitle !== undefined && { seo_title: input.seoTitle }),
          ...(input.seoDescription !== undefined && { seo_description: input.seoDescription }),
          updated_at: sql`now()`,
        })
        .where('id', '=', productId)
        .execute();

      await replaceImagesTagsCollections(trx, productId, input);
      if (input.status === 'active') await assertCanBeActive(trx, productId);

      await writeAuditLog(trx, {
        actor_type: 'admin',
        actor_id: adminId,
        action: 'product.updated',
        entity_type: 'product',
        entity_id: productId,
        metadata: { fields: Object.keys(input) },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    friendlyUniqueError(error);
  }
}

/** Only products that were never ordered can be deleted. Others must be hidden (status = hidden). */
export async function deleteProduct(db: Db, productId: string, adminId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const ordered = await trx.selectFrom('order_items').select('id').where('product_id', '=', productId).executeTakeFirst();
    if (ordered) throw conflict('Sản phẩm đã có trong đơn hàng nên không thể xóa. Hãy chuyển sang trạng thái ẩn.');

    const variantIds = trx.selectFrom('product_variants').select('id').where('product_id', '=', productId);
    await trx.deleteFrom('inventory_movements').where('variant_id', 'in', variantIds).execute();
    await trx.deleteFrom('product_variants').where('product_id', '=', productId).execute();
    const deleted = await trx.deleteFrom('products').where('id', '=', productId).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw notFound('Không tìm thấy sản phẩm.');

    await writeAuditLog(trx, { actor_type: 'admin', actor_id: adminId, action: 'product.deleted', entity_type: 'product', entity_id: productId });
  });
}

export async function createVariant(db: Db, productId: string, input: VariantCreateInput, adminId: string): Promise<string> {
  try {
    return await db.transaction().execute(async (trx) => {
      const product = await trx.selectFrom('products').select('id').where('id', '=', productId).executeTakeFirst();
      if (!product) throw notFound('Không tìm thấy sản phẩm.');
      const id = await insertVariant(trx, productId, input, adminId);
      await writeAuditLog(trx, { actor_type: 'admin', actor_id: adminId, action: 'variant.created', entity_type: 'product_variant', entity_id: id });
      return id;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    friendlyUniqueError(error);
  }
}

export async function updateVariant(db: Db, variantId: string, input: VariantUpdateInput, adminId: string): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('product_variants').selectAll().where('id', '=', variantId).forUpdate().executeTakeFirst();
      if (!current) throw notFound('Không tìm thấy phiên bản.');

      // Re-check the extra-bead rule against the merged values (the body may change only one of them).
      const maxExtraBeads = input.maxExtraBeads ?? current.max_extra_beads;
      const extraBeadPrice = input.extraBeadPrice !== undefined ? input.extraBeadPrice : current.extra_bead_price;
      if (maxExtraBeads > 0 && !extraBeadPrice) throw badRequest('Cần nhập giá mỗi hạt khi cho phép thêm hạt.');

      await trx
        .updateTable('product_variants')
        .set({
          ...(input.sku !== undefined && { sku: input.sku }),
          ...(input.name !== undefined && { name: input.name }),
          ...(input.options !== undefined && { options: JSON.stringify(input.options) }),
          ...(input.retailPrice !== undefined && { retail_price: input.retailPrice }),
          ...(input.businessPrice !== undefined && { business_price: input.businessPrice }),
          ...(input.maxExtraBeads !== undefined && { max_extra_beads: input.maxExtraBeads }),
          ...(input.extraBeadPrice !== undefined && { extra_bead_price: input.extraBeadPrice }),
          ...(input.businessExtraBeadPrice !== undefined && { business_extra_bead_price: input.businessExtraBeadPrice }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.sortOrder !== undefined && { sort_order: input.sortOrder }),
          updated_at: sql`now()`,
        })
        .where('id', '=', variantId)
        .execute();

      await writeAuditLog(trx, {
        actor_type: 'admin',
        actor_id: adminId,
        action: 'variant.updated',
        entity_type: 'product_variant',
        entity_id: variantId,
        // Keep old prices in the log so price changes can be traced.
        metadata: { fields: Object.keys(input), before: { retailPrice: current.retail_price, businessPrice: current.business_price } },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    friendlyUniqueError(error);
  }
}

export async function deleteVariant(db: Db, variantId: string, adminId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const ordered = await trx.selectFrom('order_items').select('id').where('variant_id', '=', variantId).executeTakeFirst();
    if (ordered) throw conflict('Phiên bản đã có trong đơn hàng nên không thể xóa. Hãy chuyển sang trạng thái ẩn.');

    await trx.deleteFrom('inventory_movements').where('variant_id', '=', variantId).execute();
    const deleted = await trx.deleteFrom('product_variants').where('id', '=', variantId).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw notFound('Không tìm thấy phiên bản.');
    await writeAuditLog(trx, { actor_type: 'admin', actor_id: adminId, action: 'variant.deleted', entity_type: 'product_variant', entity_id: variantId });
  });
}

/** Manual stock change (stock count, damaged goods…). Never lets stock go below 0. */
export async function adjustStock(db: Db, variantId: string, change: number, note: string, adminId: string): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('product_variants')
      .set({ stock: sql`stock + ${change}`, updated_at: sql`now()` })
      .where('id', '=', variantId)
      .where(sql<boolean>`stock + ${change} >= 0`)
      .returning('stock')
      .executeTakeFirst();

    if (!updated) {
      const exists = await trx.selectFrom('product_variants').select('stock').where('id', '=', variantId).executeTakeFirst();
      if (!exists) throw notFound('Không tìm thấy phiên bản.');
      throw badRequest(`Tồn kho hiện tại là ${exists.stock}, không thể giảm ${Math.abs(change)}.`);
    }

    await trx
      .insertInto('inventory_movements')
      .values({ variant_id: variantId, change, stock_after: updated.stock, reason: 'admin_adjustment', admin_user_id: adminId, note })
      .execute();
    return updated.stock;
  });
}
