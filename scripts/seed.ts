// Demo data for local development: the category structure, filter tags, and two SAMPLE products
// clearly named "[Mẫu]". Prices and stock of the samples are placeholders, not real shop data.
// Safe to run several times (existing slugs are skipped). Delete the sample products before launch.
//
//   npm run db:seed

import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL, 1);

async function upsertCategory(name: string, slug: string, sortOrder: number, parentSlug?: string) {
  const parentId = parentSlug
    ? (await db.selectFrom('categories').select('id').where('slug', '=', parentSlug).executeTakeFirstOrThrow()).id
    : null;
  await db
    .insertInto('categories')
    .values({ name, slug, sort_order: sortOrder, parent_id: parentId })
    .onConflict((oc) => oc.column('slug').doNothing())
    .execute();
}

try {
  // Product types (BA: "Loại sản phẩm").
  await upsertCategory('Trang sức trầm hương', 'trang-suc', 1);
  await upsertCategory('Vòng tay', 'vong-tay', 1, 'trang-suc');
  await upsertCategory('Vòng cổ', 'vong-co', 2, 'trang-suc');
  await upsertCategory('Nhang trầm', 'nhang-tram', 2);
  await upsertCategory('Nhang cây', 'nhang-cay', 1, 'nhang-tram');
  await upsertCategory('Nhang nụ', 'nhang-nu', 2, 'nhang-tram');
  await upsertCategory('Phụ kiện', 'phu-kien', 3);

  // Curated collections.
  for (const [name, slug, order] of [
    ['Quà tặng', 'qua-tang', 1],
    ['Dành cho trẻ em', 'danh-cho-tre-em', 2],
  ] as const) {
    await db.insertInto('collections').values({ name, slug, sort_order: order }).onConflict((oc) => oc.column('slug').doNothing()).execute();
  }

  // Filter tags (BA: "Đối tượng sử dụng" and "Nhu cầu mua").
  for (const [type, name, slug, order] of [
    ['audience', 'Người lớn', 'nguoi-lon', 1],
    ['audience', 'Trẻ em', 'tre-em', 2],
    ['need', 'Đeo hằng ngày', 'deo-hang-ngay', 1],
    ['need', 'Dùng cho không gian', 'khong-gian', 2],
    ['need', 'Làm quà tặng', 'lam-qua-tang', 3],
  ] as const) {
    await db.insertInto('tags').values({ type, name, slug, sort_order: order }).onConflict((oc) => oc.columns(['type', 'slug']).doNothing()).execute();
  }

  const bracelets = await db.selectFrom('categories').select('id').where('slug', '=', 'vong-tay').executeTakeFirstOrThrow();
  const cones = await db.selectFrom('categories').select('id').where('slug', '=', 'nhang-nu').executeTakeFirstOrThrow();

  const exists = await db.selectFrom('products').select('id').where('slug', '=', 'mau-vong-tay-tram-huong').executeTakeFirst();
  if (!exists) {
    await db.transaction().execute(async (trx) => {
      const bracelet = await trx
        .insertInto('products')
        .values({
          category_id: bracelets.id,
          name: '[Mẫu] Vòng tay trầm hương',
          slug: 'mau-vong-tay-tram-huong',
          short_description: 'Sản phẩm mẫu để thử giao diện. [Cập nhật] mô tả thật.',
          material: '[Cập nhật]',
          specs: JSON.stringify([{ label: 'Chất liệu', value: '[Cập nhật]' }]),
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const [size, price, beadPrice, order] of [
        [8, 500_000, 20_000, 1],
        [10, 700_000, 30_000, 2],
      ] as const) {
        const variant = await trx
          .insertInto('product_variants')
          .values({
            product_id: bracelet.id,
            sku: `MAU-VT-${size}MM`,
            name: `Hạt ${size} mm`,
            options: JSON.stringify({ bead_size_mm: size }),
            retail_price: price,
            business_price: Math.round(price * 0.85),
            stock: 10,
            max_extra_beads: 5,
            extra_bead_price: beadPrice,
            sort_order: order,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('inventory_movements').values({ variant_id: variant.id, change: 10, stock_after: 10, reason: 'initial', note: 'Seed dữ liệu mẫu' }).execute();
      }

      const cone = await trx
        .insertInto('products')
        .values({
          category_id: cones.id,
          name: '[Mẫu] Nhang nụ trầm',
          slug: 'mau-nhang-nu-tram',
          short_description: 'Sản phẩm mẫu để thử giao diện. [Cập nhật] mô tả thật.',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const coneVariant = await trx
        .insertInto('product_variants')
        .values({ product_id: cone.id, sku: 'MAU-NN-HOP', name: 'Hộp [Cập nhật] nụ', options: JSON.stringify({ pack: 'box' }), retail_price: 150_000, stock: 20 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('inventory_movements').values({ variant_id: coneVariant.id, change: 20, stock_after: 20, reason: 'initial', note: 'Seed dữ liệu mẫu' }).execute();

      const needTag = await trx.selectFrom('tags').select('id').where('slug', '=', 'deo-hang-ngay').executeTakeFirstOrThrow();
      const adultTag = await trx.selectFrom('tags').select('id').where('slug', '=', 'nguoi-lon').executeTakeFirstOrThrow();
      await trx.insertInto('product_tags').values([{ product_id: bracelet.id, tag_id: needTag.id }, { product_id: bracelet.id, tag_id: adultTag.id }]).execute();
    });
    console.log('Đã tạo 2 sản phẩm [Mẫu].');
  }

  const settings = await db.selectFrom('store_settings').select('shipping_fee').where('id', '=', 1).executeTakeFirstOrThrow();
  if (settings.shipping_fee === null) {
    console.log('Lưu ý: chưa cấu hình phí giao hàng nên checkout sẽ bị từ chối. Đặt bằng PUT /api/admin/store-settings.');
  }
  console.log('Seed xong.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
