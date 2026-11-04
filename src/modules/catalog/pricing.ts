import type { PriceTier } from '../../db/schema.js';

// One place that decides which price a customer pays. Used by the product pages, the checkout
// quote and order creation, so the three can never disagree.

export interface PricedVariantFields {
  retail_price: number;
  business_price: number | null;
  extra_bead_price: number | null;
  business_extra_bead_price: number | null;
}

/** Business customers get the business price when one is set, otherwise the retail price (Q7). */
export function unitPriceFor(variant: PricedVariantFields, tier: PriceTier): number {
  if (tier === 'business' && variant.business_price !== null) return variant.business_price;
  return variant.retail_price;
}

/** Price of one extra bead for this tier, or null when the variant does not offer extra beads. */
export function extraBeadPriceFor(variant: PricedVariantFields, tier: PriceTier): number | null {
  if (tier === 'business' && variant.business_extra_bead_price !== null) return variant.business_extra_bead_price;
  return variant.extra_bead_price;
}

/** Stock is shown as "how many can I buy", capped so the exact warehouse count is not exposed. */
export function availableQuantity(stock: number): number {
  return Math.min(stock, 99);
}
