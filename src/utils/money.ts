import { env } from '../config/env';

/**
 * Semua nominal disimpan sebagai bilangan bulat rupiah (tanpa sen), sehingga
 * tidak ada pembulatan floating point di jalur uang.
 */
export function calculateSellPrice(basePrice: number): number {
  const withMarkup =
    basePrice + env.MARKUP_FLAT + (basePrice * env.MARKUP_PERCENT) / 100;
  const rounding = env.PRICE_ROUNDING > 0 ? env.PRICE_ROUNDING : 1;
  return Math.ceil(withMarkup / rounding) * rounding;
}

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}
