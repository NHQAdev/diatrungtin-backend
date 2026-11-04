import type { DbOrTrx } from '../../db/client.js';
import type { PriceTier, VariantOptions } from '../../db/schema.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { availableQuantity, extraBeadPriceFor, unitPriceFor } from '../catalog/pricing.js';

// Turns what the customer has in the cart into priced lines. Used by the quote endpoint (no lock)
// and by order creation (with row locks, inside the order transaction). The frontend never sends
// prices: everything is read from the database here.

export interface CartItemInput {
  variantId: string;
  quantity: number;
  extraBeads: number;
}

export interface PricedLine {
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  variantName: string;
  sku: string;
  options: VariantOptions;
  imageUrl: string | null;
  unitPrice: number;
  extraBeads: number;
  extraBeadUnitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface CartProblem {
  variantId: string;
  reason: 'unavailable' | 'insufficient_stock';
  availableQuantity: number;
}

export interface PricedCart {
  priceTier: PriceTier;
  lines: PricedLine[];
  subtotal: number;
  problems: CartProblem[];
}

export async function priceCart(
  db: DbOrTrx,
  items: CartItemInput[],
  tier: PriceTier,
  options: { lockVariants: boolean },
): Promise<PricedCart> {
  if (items.length === 0) throw badRequest('Giỏ hàng đang trống.');

  const variantIds = [...new Set(items.map((item) => item.variantId))].sort();

  // FOR UPDATE: while this transaction runs, nobody else can change these variants' stock.
  // Sorting the ids means two orders always lock rows in the same order (no deadlock).
  let variantQuery = db.selectFrom('product_variants').selectAll().where('id', 'in', variantIds).orderBy('id');
  if (options.lockVariants) variantQuery = variantQuery.forUpdate();
  const variants = await variantQuery.execute();

  const productIds = [...new Set(variants.map((variant) => variant.product_id))];
  const products = productIds.length
    ? await db
        .selectFrom('products as p')
        .innerJoin('categories as c', 'c.id', 'p.category_id')
        .select([
          'p.id',
          'p.name',
          'p.slug',
          'p.status',
          'c.is_visible as category_visible',
          (eb) =>
            eb
              .selectFrom('product_images as i')
              .select('i.url')
              .whereRef('i.product_id', '=', 'p.id')
              .orderBy('i.sort_order')
              .limit(1)
              .as('image_url'),
        ])
        .where('p.id', 'in', productIds)
        .execute()
    : [];

  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const productById = new Map(products.map((product) => [product.id, product]));

  // Total quantity asked per variant (the same variant can appear twice with different extra beads).
  const requestedPerVariant = new Map<string, number>();
  for (const item of items) requestedPerVariant.set(item.variantId, (requestedPerVariant.get(item.variantId) ?? 0) + item.quantity);

  const lines: PricedLine[] = [];
  const problems: CartProblem[] = [];
  const reported = new Set<string>();

  for (const item of items) {
    const variant = variantById.get(item.variantId);
    const product = variant ? productById.get(variant.product_id) : undefined;
    const sellable = variant && product && variant.status === 'active' && product.status === 'active' && product.category_visible;

    if (!variant || !product || !sellable) {
      if (!reported.has(item.variantId)) problems.push({ variantId: item.variantId, reason: 'unavailable', availableQuantity: 0 });
      reported.add(item.variantId);
      continue;
    }

    if (item.extraBeads > variant.max_extra_beads) {
      throw new AppError(400, 'VALIDATION_ERROR', `"${product.name} — ${variant.name}" chỉ được thêm tối đa ${variant.max_extra_beads} hạt.`, [
        { field: 'items', variantId: variant.id, maxExtraBeads: variant.max_extra_beads },
      ]);
    }

    if ((requestedPerVariant.get(variant.id) ?? 0) > variant.stock && !reported.has(variant.id)) {
      problems.push({ variantId: variant.id, reason: 'insufficient_stock', availableQuantity: availableQuantity(variant.stock) });
      reported.add(variant.id);
    }

    const unitPrice = unitPriceFor(variant, tier);
    const extraBeadUnitPrice = item.extraBeads > 0 ? (extraBeadPriceFor(variant, tier) ?? 0) : 0;
    lines.push({
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      productSlug: product.slug,
      variantName: variant.name,
      sku: variant.sku,
      options: variant.options,
      imageUrl: product.image_url,
      unitPrice,
      extraBeads: item.extraBeads,
      extraBeadUnitPrice,
      quantity: item.quantity,
      lineTotal: (unitPrice + item.extraBeads * extraBeadUnitPrice) * item.quantity,
    });
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  return { priceTier: tier, lines, subtotal, problems };
}

/** Flat shipping fee from store settings, free above the threshold. Refuses checkout until configured. */
export async function shippingFeeFor(db: DbOrTrx, subtotal: number): Promise<number> {
  const settings = await db.selectFrom('store_settings').select(['shipping_fee', 'free_shipping_threshold']).where('id', '=', 1).executeTakeFirst();
  if (!settings || settings.shipping_fee === null) {
    throw new AppError(503, 'STORE_NOT_CONFIGURED', 'Cửa hàng chưa cấu hình phí giao hàng. Vui lòng thử lại sau.');
  }
  if (settings.free_shipping_threshold !== null && subtotal >= settings.free_shipping_threshold) return 0;
  return settings.shipping_fee;
}
