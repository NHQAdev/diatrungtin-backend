import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Db } from '../src/db/client.js';
import { createAdmin, sessionCookieFrom } from './helpers.js';

// Shared building blocks for the integration tests. Everything goes through the real HTTP API.

let addressCounter = 0;
/** Every request gets its own IP so per-IP rate limits never interfere between tests. */
export const nextIp = () => {
  addressCounter++;
  return `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter & 255}`;
};

export interface CallOptions {
  method?: InjectOptions['method'];
  url: string;
  payload?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  ip?: string;
}

export function call(app: FastifyInstance, options: CallOptions) {
  return app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    payload: options.payload as InjectOptions['payload'],
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    remoteAddress: options.ip ?? nextIp(),
  });
}

export async function adminCookie(app: FastifyInstance, db: Db): Promise<string> {
  await createAdmin(db, 'admin@example.com', 'admin password 123');
  const response = await call(app, { method: 'POST', url: '/api/admin/auth/login', payload: { email: 'admin@example.com', password: 'admin password 123' } });
  if (response.statusCode !== 200) throw new Error(`admin login failed: ${response.body}`);
  return sessionCookieFrom(response.headers['set-cookie']);
}

export async function setShipping(app: FastifyInstance, admin: string, shippingFee: number | null, freeShippingThreshold: number | null = null) {
  const response = await call(app, { method: 'PUT', url: '/api/admin/store-settings', cookie: admin, payload: { shippingFee, freeShippingThreshold } });
  if (response.statusCode !== 200) throw new Error(`store settings failed: ${response.body}`);
}

export interface CatalogFixture {
  productId: string;
  slug: string;
  parentCategoryId: string;
  categoryId: string;
  tagId: string;
  /** 8 mm: retail 500.000, business 400.000, stock 2, up to 3 extra beads at 20.000 (business 15.000) */
  variantA: string;
  /** 10 mm: retail 300.000, no business price, stock 1, no extra beads */
  variantB: string;
}

export async function createCatalog(app: FastifyInstance, admin: string): Promise<CatalogFixture> {
  const post = async (url: string, payload: unknown) => {
    const response = await call(app, { method: 'POST', url, cookie: admin, payload });
    if (response.statusCode !== 201) throw new Error(`${url} failed: ${response.body}`);
    return response.json().data;
  };
  const parent = await post('/api/admin/categories', { name: 'Trang sức trầm hương' });
  const category = await post('/api/admin/categories', { name: 'Vòng tay', parentId: parent.id });
  const tag = await post('/api/admin/tags', { type: 'audience', name: 'Người lớn' });
  const product = await post('/api/admin/products', {
    categoryId: category.id,
    name: 'Vòng tay trầm 108 hạt',
    status: 'active',
    images: [{ url: 'https://example.com/a.jpg', alt: 'Vòng tay' }],
    tagIds: [tag.id],
    variants: [
      { sku: 'vt-108-8mm', name: 'Hạt 8 mm', options: { bead_size_mm: 8 }, retailPrice: 500_000, businessPrice: 400_000, maxExtraBeads: 3, extraBeadPrice: 20_000, businessExtraBeadPrice: 15_000, initialStock: 2 },
      { sku: 'VT-108-10MM', name: 'Hạt 10 mm', options: { bead_size_mm: 10 }, retailPrice: 300_000, initialStock: 1 },
    ],
  });
  const detail = (await call(app, { url: `/api/admin/products/${product.id}`, cookie: admin })).json().data;
  const variantA = detail.variants.find((v: { sku: string }) => v.sku === 'VT-108-8MM').id;
  const variantB = detail.variants.find((v: { sku: string }) => v.sku === 'VT-108-10MM').id;
  return { productId: product.id, slug: detail.slug, parentCategoryId: parent.id, categoryId: category.id, tagId: tag.id, variantA, variantB };
}

export async function registerCustomer(
  app: FastifyInstance,
  overrides: Record<string, unknown> = {},
): Promise<{ cookie: string; customer: Record<string, unknown> }> {
  const response = await call(app, {
    method: 'POST',
    url: '/api/auth/register',
    payload: { accountType: 'personal', email: `khach${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'mat khau 123', fullName: 'Nguyễn Văn A', phone: '0912345678', ...overrides },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  return { cookie: sessionCookieFrom(response.headers['set-cookie']), customer: response.json().data.customer };
}

export async function registerApprovedBusiness(app: FastifyInstance, admin: string) {
  const business = await registerCustomer(app, { accountType: 'business', companyName: 'Công ty TNHH Mẫu', taxCode: '0312345678', invoiceAddress: '1 Đường A, Quận 1, TP.HCM' });
  const review = await call(app, { method: 'POST', url: `/api/admin/customers/${business.customer.id}/business-review`, cookie: admin, payload: { decision: 'approve' } });
  if (review.statusCode !== 200) throw new Error(`approve failed: ${review.body}`);
  return business;
}

export const shippingAddress = { province: 'TP. Hồ Chí Minh', ward: 'Phường Bến Nghé', addressLine: '12 Lê Lợi' };
export const contact = { fullName: 'Trần Thị B', phone: '0987654321', email: 'b@example.com' };

export const newKey = () => `test-${crypto.randomUUID()}`;
