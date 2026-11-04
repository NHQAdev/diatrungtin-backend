import { z } from 'zod';

// Shared helpers for request parsing and paginated responses.

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

export const IdParam = z.object({ id: z.string().uuid('ID không hợp lệ.') });
export const SlugParam = z.object({ slug: z.string().min(1).max(200) });

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');

/** Vietnamese mobile number: 10 digits starting with 0. Accepts spaces, dots and +84 when typing. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s.-]/g, '').replace(/^\+84/, '0'))
  .pipe(z.string().regex(/^0[0-9]{9}$/, 'Số điện thoại không hợp lệ.'));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Email không hợp lệ.')
  .max(254);

/** Optional text from a form: empty string becomes null. */
export const optionalText = (max = 5000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/** Money in VND: a positive whole number. */
export const moneySchema = z.number().int('Giá phải là số nguyên (VNĐ).').positive('Giá phải lớn hơn 0.').max(1_000_000_000_000);
