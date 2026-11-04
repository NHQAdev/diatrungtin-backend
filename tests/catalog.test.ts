import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCookie, call, type CatalogFixture, createCatalog, registerCustomer } from './fixtures.js';
import { createTestContext, resetData } from './helpers.js';

const ctx = await createTestContext();
const { app, db } = ctx;
let admin: string;
let catalog: CatalogFixture;

beforeEach(async () => {
  await resetData(db);
  admin = await adminCookie(app, db);
  catalog = await createCatalog(app, admin);
});
afterAll(async () => {
  await ctx.close();
});

describe('admin access control', () => {
  it('refuses every admin endpoint without an admin session', async () => {
    for (const url of ['/api/admin/products', '/api/admin/categories', '/api/admin/customers', '/api/admin/orders', '/api/admin/store-settings', '/api/admin/dashboard']) {
      const response = await call(app, { url });
      expect(response.statusCode).toBe(401);
    }
    const write = await call(app, { method: 'POST', url: '/api/admin/categories', payload: { name: 'X' } });
    expect(write.statusCode).toBe(401);
  });

  it('does not accept a customer session as an admin session', async () => {
    const { cookie } = await registerCustomer(app);
    expect((await call(app, { url: '/api/admin/products', cookie })).statusCode).toBe(401);
  });
});

describe('public catalog', () => {
  it('lists active products with the lowest retail price and stock flag', async () => {
    const response = await call(app, { url: '/api/products' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toMatchObject({ total: 1, priceTier: 'retail' });
    expect(body.data[0]).toMatchObject({ slug: catalog.slug, priceFrom: 300_000, inStock: true, imageUrl: 'https://example.com/a.jpg' });
  });

  it('filters by parent category, tag, keyword and price', async () => {
    const count = async (query: string) => (await call(app, { url: `/api/products?${query}` })).json().meta.total;
    expect(await count('category=trang-suc-tram-huong')).toBe(1); // parent includes child category
    expect(await count('category=vong-tay')).toBe(1);
    expect(await count('audience=nguoi-lon')).toBe(1);
    expect(await count('audience=tre-em')).toBe(0);
    expect(await count('q=108')).toBe(1);
    expect(await count('q=nhang')).toBe(0);
    expect(await count('minPrice=400000')).toBe(0); // priceFrom is 300.000
    expect(await count('maxPrice=300000')).toBe(1);
    // LIKE wildcards in the keyword are treated literally.
    expect(await count('q=%25')).toBe(0);
  });

  it('searches without accents and ignores letter case', async () => {
    const count = async (q: string) => (await call(app, { url: `/api/products?q=${encodeURIComponent(q)}` })).json().meta.total;
    expect(await count('vong tay')).toBe(1);
    expect(await count('VÒNG TAY')).toBe(1);
    expect(await count('trầm 108')).toBe(1);
    expect(await count('tram 108 hat')).toBe(1);
    expect(await count('Vòng tay'.normalize('NFD'))).toBe(1);
    expect(await count('vong co')).toBe(0);
    // The search text follows renames automatically.
    await call(app, { method: 'PATCH', url: `/api/admin/products/${catalog.productId}`, cookie: admin, payload: { name: 'Chuỗi hạt đặc biệt' } });
    expect(await count('chuoi hat dac biet')).toBe(1);
    expect(await count('vong tay')).toBe(0);
    // Admin search: by name without accents, or by SKU.
    expect((await call(app, { url: '/api/admin/products?q=chuoi%20hat', cookie: admin })).json().meta.total).toBe(1);
    expect((await call(app, { url: '/api/admin/products?q=vt-108-10', cookie: admin })).json().meta.total).toBe(1);
  });

  it('shows variant details without exposing the exact warehouse stock', async () => {
    const response = await call(app, { url: `/api/products/${catalog.slug}` });
    expect(response.statusCode).toBe(200);
    const product = response.json().data;
    expect(product.breadcrumb.map((b: { slug: string }) => b.slug)).toEqual(['trang-suc-tram-huong', 'vong-tay']);
    const a = product.variants.find((v: { id: string }) => v.id === catalog.variantA);
    expect(a).toMatchObject({ sku: 'VT-108-8MM', price: 500_000, retailPrice: 500_000, inStock: true, availableQuantity: 2, maxExtraBeads: 3, extraBeadPrice: 20_000 });
    expect(a.stock).toBeUndefined();
    expect(a.businessPrice).toBeUndefined();
  });

  it('hides draft/hidden products and hidden variants', async () => {
    await call(app, { method: 'PATCH', url: `/api/admin/variants/${catalog.variantB}`, cookie: admin, payload: { status: 'hidden' } });
    const detail = (await call(app, { url: `/api/products/${catalog.slug}` })).json().data;
    expect(detail.variants).toHaveLength(1);

    await call(app, { method: 'PATCH', url: `/api/admin/products/${catalog.productId}`, cookie: admin, payload: { status: 'hidden' } });
    expect((await call(app, { url: `/api/products/${catalog.slug}` })).statusCode).toBe(404);
    expect((await call(app, { url: '/api/products' })).json().meta.total).toBe(0);
  });

  it('returns the category tree', async () => {
    const tree = (await call(app, { url: '/api/categories' })).json().data;
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c: { slug: string }) => c.slug)).toEqual(['vong-tay']);
  });
});

describe('admin product rules', () => {
  it('requires a bead price when extra beads are allowed', async () => {
    const response = await call(app, {
      method: 'POST',
      url: `/api/admin/products/${catalog.productId}/variants`,
      cookie: admin,
      payload: { sku: 'VT-12', name: '12 mm', options: { bead_size_mm: 12 }, retailPrice: 900_000, maxExtraBeads: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details[0].field).toBe('extraBeadPrice');
  });

  it('rejects a duplicate SKU and duplicate options with 409', async () => {
    const dupSku = await call(app, {
      method: 'POST',
      url: `/api/admin/products/${catalog.productId}/variants`,
      cookie: admin,
      payload: { sku: 'VT-108-8MM', name: 'Khác', options: { bead_size_mm: 12 }, retailPrice: 1 },
    });
    expect(dupSku.statusCode).toBe(409);
    expect(dupSku.json().error.message).toMatch('SKU');

    const dupOptions = await call(app, {
      method: 'POST',
      url: `/api/admin/products/${catalog.productId}/variants`,
      cookie: admin,
      payload: { sku: 'VT-NEW', name: 'Trùng', options: { bead_size_mm: 8 }, retailPrice: 1 },
    });
    expect(dupOptions.statusCode).toBe(409);
  });

  it('refuses money that is not a positive whole number', async () => {
    for (const retailPrice of [0, -5, 1000.5, '1000']) {
      const response = await call(app, {
        method: 'PATCH',
        url: `/api/admin/variants/${catalog.variantA}`,
        cookie: admin,
        payload: { retailPrice },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('cannot publish a product without any active variant', async () => {
    const response = await call(app, {
      method: 'POST',
      url: '/api/admin/products',
      cookie: admin,
      payload: { categoryId: catalog.categoryId, name: 'Sản phẩm trống', status: 'active' },
    });
    expect(response.statusCode).toBe(400);
    expect((await db.selectFrom('products').select('id').where('name', '=', 'Sản phẩm trống').execute()).length).toBe(0);
  });

  it('adjusts stock with a reason, logs it, and never goes below zero', async () => {
    const tooMuch = await call(app, { method: 'POST', url: `/api/admin/variants/${catalog.variantB}/stock-adjustments`, cookie: admin, payload: { change: -2, note: 'Kiểm kho' } });
    expect(tooMuch.statusCode).toBe(400);

    const noReason = await call(app, { method: 'POST', url: `/api/admin/variants/${catalog.variantB}/stock-adjustments`, cookie: admin, payload: { change: 3, note: '' } });
    expect(noReason.statusCode).toBe(400);

    const ok = await call(app, { method: 'POST', url: `/api/admin/variants/${catalog.variantB}/stock-adjustments`, cookie: admin, payload: { change: 4, note: 'Nhập hàng' } });
    expect(ok.json().data.stock).toBe(5);

    const movements = (await call(app, { url: `/api/admin/variants/${catalog.variantB}/stock-movements`, cookie: admin })).json().data;
    expect(movements.map((m: { reason: string; change: number; stock_after: number }) => [m.reason, m.change, m.stock_after])).toEqual([
      ['admin_adjustment', 4, 5],
      ['initial', 1, 1],
    ]);
  });

  it('does not delete a category that still has products', async () => {
    const response = await call(app, { method: 'DELETE', url: `/api/admin/categories/${catalog.categoryId}`, cookie: admin });
    expect(response.statusCode).toBe(409);
  });

  it('generates Vietnamese-friendly slugs', async () => {
    const response = await call(app, { method: 'POST', url: '/api/admin/categories', cookie: admin, payload: { name: 'Nhang nụ Đặc biệt' } });
    expect(response.json().data.slug).toBe('nhang-nu-dac-biet');
  });
});
