// OPTIONAL demo catalog for local development and design review: the products shown in the Figma
// mockups, with the temporary photos in the frontend's public/images folder.
// Everything here is SAMPLE data: names follow the mockups, prices are the mockups' illustrative
// prices, every short description says "Mẫu minh họa", and every slug starts with "mau-".
// Do NOT run this on production. Remove these products (slug LIKE 'mau-%') before launch.
//
//   npm run db:seed          (run first: categories, collections, tags)
//   npm run db:seed:demo
//
// Safe to run several times: existing demo products (same slug) only get their photos refreshed.
// Image URLs are relative ("/images/…"), served by the frontend dev server. The admin API only
// accepts absolute URLs, so replace these images through the admin before editing such a product.

import type { Kysely } from 'kysely';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import type { Database } from '../src/db/schema.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('Không chạy seed demo trên production.');
  process.exit(1);
}
const db = createDb(env.DATABASE_URL, 1);

interface DemoVariant {
  sku: string;
  name: string;
  options: Record<string, string | number>;
  price: number;
  stock: number;
  maxExtraBeads?: number;
  extraBeadPrice?: number;
}

interface DemoProduct {
  slug: string;
  name: string;
  category: string;
  shortDescription: string;
  description: string;
  material?: string;
  specs: { label: string; value: string }[];
  usageGuide?: string;
  images: { url: string; alt: string }[];
  variants: DemoVariant[];
  collections?: string[];
  tags?: string[];
}

const UPDATE = '[Cập nhật]';

const PRODUCTS: DemoProduct[] = [
  {
    slug: 'mau-vong-tay-hat-tron',
    name: 'Vòng tay hạt tròn',
    category: 'vong-tay',
    shortDescription: 'Hạt 8 mm · Mẫu minh họa',
    description: 'Thiết kế hạt tròn với sắc nâu gỗ, phù hợp phối cùng trang phục hằng ngày. (Mẫu minh họa — mô tả thật ' + UPDATE + ')',
    material: 'Trầm hương (mẫu)',
    specs: [
      { label: 'Kích thước', value: 'Theo phiên bản đã chọn' },
      { label: 'Nguồn gốc', value: UPDATE },
    ],
    usageGuide: UPDATE,
    images: [
      { url: '/images/product-bracelet.webp', alt: 'Vòng tay trầm hương hạt tròn' },
      { url: '/images/bracelet-stone-panorama.webp', alt: 'Vòng tay đặt trên phiến đá' },
      { url: '/images/bracelet-stone-block.webp', alt: 'Vòng tay đặt trên khối đá' },
      { url: '/images/wear-your-way.webp', alt: 'Vòng tay khi đeo' },
    ],
    variants: [
      { sku: 'MAU-VTHT-8MM', name: 'Hạt 8 mm', options: { bead_size_mm: 8 }, price: 890_000, stock: 10, maxExtraBeads: 3, extraBeadPrice: 20_000 },
      { sku: 'MAU-VTHT-10MM', name: 'Hạt 10 mm', options: { bead_size_mm: 10 }, price: 1_090_000, stock: 8, maxExtraBeads: 3, extraBeadPrice: 30_000 },
      { sku: 'MAU-VTHT-12MM', name: 'Hạt 12 mm', options: { bead_size_mm: 12 }, price: 1_290_000, stock: 0, maxExtraBeads: 2, extraBeadPrice: 40_000 },
    ],
    tags: ['nguoi-lon', 'deo-hang-ngay'],
  },
  {
    slug: 'mau-vong-tay-10mm',
    name: 'Vòng tay 10 mm',
    category: 'vong-tay',
    shortDescription: 'Hạt 10 mm · Mẫu minh họa',
    description: 'Mẫu minh họa — mô tả thật ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [{ label: 'Nguồn gốc', value: UPDATE }],
    images: [
      { url: '/images/bracelet-stone-block.webp', alt: 'Vòng tay trầm hương hạt 10 mm' },
      { url: '/images/bracelet-stone-wide.webp', alt: 'Vòng tay đặt trên đá' },
    ],
    variants: [{ sku: 'MAU-VT10-10MM', name: 'Hạt 10 mm', options: { bead_size_mm: 10 }, price: 1_090_000, stock: 6, maxExtraBeads: 3, extraBeadPrice: 30_000 }],
    collections: ['qua-tang'],
    tags: ['nguoi-lon', 'lam-qua-tang'],
  },
  {
    slug: 'mau-vong-co-tram-huong',
    name: 'Vòng cổ trầm hương',
    category: 'vong-co',
    shortDescription: 'Chuỗi hạt · Mẫu minh họa',
    description: 'Mẫu minh họa — mô tả thật ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [{ label: 'Nguồn gốc', value: UPDATE }],
    images: [
      { url: '/images/product-necklace.webp', alt: 'Vòng cổ trầm hương' },
      { url: '/images/wear-your-way.webp', alt: 'Vòng cổ khi đeo' },
    ],
    variants: [{ sku: 'MAU-VC-8MM', name: 'Hạt 8 mm', options: { bead_size_mm: 8 }, price: 1_490_000, stock: 5 }],
    tags: ['nguoi-lon', 'deo-hang-ngay'],
  },
  {
    slug: 'mau-nhang-tram-cay',
    name: 'Nhang trầm cây',
    category: 'nhang-cay',
    shortDescription: 'Hộp 30 cây · Mẫu minh họa',
    description: 'Mẫu minh họa — mô tả thật ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [{ label: 'Nguồn gốc', value: UPDATE }],
    images: [
      { url: '/images/product-incense-stick.webp', alt: 'Nhang trầm cây' },
      { url: '/images/space-incense.webp', alt: 'Nhang trầm trong không gian' },
    ],
    variants: [{ sku: 'MAU-NC-H30', name: 'Hộp 30 cây', options: { pack: 'Hộp 30 cây' }, price: 180_000, stock: 30 }],
    tags: ['khong-gian'],
  },
  {
    slug: 'mau-nhang-tram-nu',
    name: 'Nhang trầm nụ',
    category: 'nhang-nu',
    shortDescription: 'Hộp 20 nụ · Mẫu minh họa',
    description: 'Mẫu minh họa — mô tả thật ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [{ label: 'Nguồn gốc', value: UPDATE }],
    images: [
      { url: '/images/product-incense-cone.webp', alt: 'Nhang trầm nụ' },
      { url: '/images/guide-incense.webp', alt: 'Nhang trầm nụ khi đốt' },
    ],
    variants: [{ sku: 'MAU-NN-H20', name: 'Hộp 20 nụ', options: { pack: 'Hộp 20 nụ' }, price: 220_000, stock: 25 }],
    tags: ['khong-gian'],
  },
  {
    slug: 'mau-vong-tay-tre-em',
    name: 'Vòng tay trẻ em',
    category: 'vong-tay',
    shortDescription: 'Hạt nhỏ · Mẫu minh họa',
    description: 'Mẫu minh họa. Độ tuổi phù hợp và lưu ý an toàn cho trẻ: ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [
      { label: 'Độ tuổi phù hợp', value: UPDATE },
      { label: 'Nguồn gốc', value: UPDATE },
    ],
    images: [{ url: '/images/kids-bracelet.webp', alt: 'Vòng tay trầm hương cho trẻ em' }],
    variants: [{ sku: 'MAU-VTTE-6MM', name: 'Hạt 6 mm', options: { bead_size_mm: 6 }, price: 450_000, stock: 10 }],
    collections: ['danh-cho-tre-em'],
    tags: ['tre-em'],
  },
  {
    slug: 'mau-hop-qua-tram-huong',
    name: 'Hộp quà trầm hương',
    category: 'vong-tay',
    shortDescription: 'Vòng tay kèm hộp quà · Mẫu minh họa',
    description: 'Mẫu minh họa — thành phần hộp quà ' + UPDATE,
    material: 'Trầm hương (mẫu)',
    specs: [{ label: 'Quy cách', value: UPDATE }],
    images: [{ url: '/images/gift-box.webp', alt: 'Hộp quà trầm hương' }],
    variants: [{ sku: 'MAU-HQ-8MM', name: 'Hạt 8 mm', options: { bead_size_mm: 8 }, price: 1_190_000, stock: 5 }],
    collections: ['qua-tang'],
    tags: ['lam-qua-tang'],
  },
];

async function idBySlug(table: 'categories' | 'collections', slug: string, trx: Kysely<Database>) {
  const row = await trx.selectFrom(table).select('id').where('slug', '=', slug).executeTakeFirst();
  if (!row) throw new Error(`Thiếu ${table} "${slug}". Hãy chạy "npm run db:seed" trước.`);
  return row.id;
}

try {
  let created = 0;
  let refreshed = 0;
  for (const item of PRODUCTS) {
    const exists = await db.selectFrom('products').select('id').where('slug', '=', item.slug).executeTakeFirst();
    if (exists) {
      // Demo product already there: only refresh its photos (they may have been replaced).
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('product_images').where('product_id', '=', exists.id).execute();
        await trx
          .insertInto('product_images')
          .values(item.images.map((image, index) => ({ product_id: exists.id, url: image.url, alt: image.alt, sort_order: index })))
          .execute();
      });
      refreshed += 1;
      continue;
    }

    await db.transaction().execute(async (trx) => {
      const product = await trx
        .insertInto('products')
        .values({
          category_id: await idBySlug('categories', item.category, trx),
          name: item.name,
          slug: item.slug,
          short_description: item.shortDescription,
          description: item.description,
          material: item.material ?? null,
          specs: JSON.stringify(item.specs),
          usage_guide: item.usageGuide ?? null,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('product_images')
        .values(item.images.map((image, index) => ({ product_id: product.id, url: image.url, alt: image.alt, sort_order: index })))
        .execute();

      for (const [index, variant] of item.variants.entries()) {
        const row = await trx
          .insertInto('product_variants')
          .values({
            product_id: product.id,
            sku: variant.sku,
            name: variant.name,
            options: JSON.stringify(variant.options),
            retail_price: variant.price,
            business_price: Math.round((variant.price * 0.85) / 1000) * 1000,
            stock: variant.stock,
            max_extra_beads: variant.maxExtraBeads ?? 0,
            extra_bead_price: variant.extraBeadPrice ?? null,
            sort_order: index,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (variant.stock > 0) {
          await trx
            .insertInto('inventory_movements')
            .values({ variant_id: row.id, change: variant.stock, stock_after: variant.stock, reason: 'initial', note: 'Seed demo' })
            .execute();
        }
      }

      for (const [index, slug] of (item.collections ?? []).entries()) {
        await trx
          .insertInto('product_collections')
          .values({ product_id: product.id, collection_id: await idBySlug('collections', slug, trx), sort_order: index })
          .execute();
      }

      for (const slug of item.tags ?? []) {
        const tag = await trx.selectFrom('tags').select('id').where('slug', '=', slug).executeTakeFirstOrThrow();
        await trx.insertInto('product_tags').values({ product_id: product.id, tag_id: tag.id }).execute();
      }
    });
    created += 1;
  }

  // The two bare "[Mẫu]" products from db:seed have no photos and would sit next to the demo
  // products looking broken; hide them (kept in the database, not deleted).
  const hidden = await db
    .updateTable('products')
    .set({ status: 'hidden' })
    .where('slug', 'in', ['mau-vong-tay-tram-huong', 'mau-nhang-nu-tram'])
    .where('status', '=', 'active')
    .executeTakeFirst();

  console.log(`Seed demo xong: tạo ${created}, cập nhật ảnh ${refreshed} sản phẩm mẫu; ẩn ${Number(hidden.numUpdatedRows)} sản phẩm [Mẫu] không có ảnh.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
