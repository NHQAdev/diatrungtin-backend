/** 1250000 → "1.250.000 ₫" (used in emails). */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')} ₫`;
}
