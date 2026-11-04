import { z } from 'zod';
import { moneySchema, optionalText, slugSchema } from '../../lib/http.js';

// Request bodies for the admin catalog API.

export const CategoryBody = z.object({
  name: z.string().trim().min(1, 'Vui lòng nhập tên danh mục.').max(200),
  slug: slugSchema.optional(),
  parentId: z.string().uuid().nullish(),
  description: optionalText(),
  sortOrder: z.number().int().default(0),
  isVisible: z.boolean().default(true),
});

export const CollectionBody = z.object({
  name: z.string().trim().min(1, 'Vui lòng nhập tên bộ sưu tập.').max(200),
  slug: slugSchema.optional(),
  description: optionalText(),
  imageUrl: optionalText(1000),
  sortOrder: z.number().int().default(0),
  isVisible: z.boolean().default(true),
});

export const TagBody = z.object({
  type: z.enum(['audience', 'need']),
  name: z.string().trim().min(1, 'Vui lòng nhập tên.').max(100),
  slug: slugSchema.optional(),
  sortOrder: z.number().int().default(0),
});

const variantOptions = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Tên thuộc tính chỉ gồm chữ thường, số, dấu gạch dưới.'),
    z.union([z.string().trim().min(1).max(100), z.number()]),
  )
  .default({});

const variantFields = {
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,63}$/, 'SKU chỉ gồm chữ in hoa, số và dấu gạch ngang (2–64 ký tự).'),
  name: z.string().trim().min(1, 'Vui lòng nhập tên phiên bản.').max(200),
  options: variantOptions,
  retailPrice: moneySchema,
  businessPrice: moneySchema.nullish(),
  maxExtraBeads: z.number().int().min(0).max(100).default(0),
  extraBeadPrice: moneySchema.nullish(),
  businessExtraBeadPrice: moneySchema.nullish(),
  status: z.enum(['active', 'hidden']).default('active'),
  sortOrder: z.number().int().default(0),
};

function checkExtraBeads(value: { maxExtraBeads?: number; extraBeadPrice?: number | null }, ctx: z.RefinementCtx) {
  if ((value.maxExtraBeads ?? 0) > 0 && !value.extraBeadPrice) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['extraBeadPrice'], message: 'Cần nhập giá mỗi hạt khi cho phép thêm hạt.' });
  }
}

export const VariantCreateBody = z
  .object({ ...variantFields, initialStock: z.number().int().min(0).max(1_000_000).default(0) })
  .superRefine(checkExtraBeads);

// Stock is NOT editable here: it changes only through stock adjustments and orders (so it is always logged).
export const VariantUpdateBody = z.object(variantFields).partial().superRefine(checkExtraBeads);

const productFields = {
  categoryId: z.string().uuid('Vui lòng chọn danh mục.'),
  name: z.string().trim().min(1, 'Vui lòng nhập tên sản phẩm.').max(300),
  slug: slugSchema.optional(),
  shortDescription: optionalText(1000),
  description: optionalText(20000),
  material: optionalText(500),
  specs: z.array(z.object({ label: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(500) })).max(50).default([]),
  usageGuide: optionalText(10000),
  status: z.enum(['draft', 'active', 'hidden']).default('draft'),
  seoTitle: optionalText(200),
  seoDescription: optionalText(500),
  images: z.array(z.object({ url: z.string().trim().url().max(1000), alt: optionalText(300) })).max(20).default([]),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  collectionIds: z.array(z.string().uuid()).max(50).default([]),
};

export const ProductCreateBody = z.object({
  ...productFields,
  variants: z.array(VariantCreateBody).max(50).default([]),
});

export const ProductUpdateBody = z.object(productFields).partial();

export const StockAdjustmentBody = z.object({
  change: z.number().int().refine((n) => n !== 0, 'Số lượng thay đổi phải khác 0.'),
  note: z.string().trim().min(1, 'Vui lòng ghi lý do điều chỉnh tồn kho.').max(500),
});

export const AdminProductListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'hidden']).optional(),
  categoryId: z.string().uuid().optional(),
  lowStock: z.coerce.number().int().min(0).optional(),
});
