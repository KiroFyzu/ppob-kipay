/**
 * Kolom status/role/brand di database memakai String (bukan enum Postgres),
 * jadi nilai-nilai ini yang menjadi kontrak. Selalu pakai konstanta di sini,
 * jangan tulis string mentah di service.
 */

export const Brand = {
  DANA: 'DANA',
  OVO: 'OVO',
  GOPAY: 'GOPAY',
  SHOPEEPAY: 'SHOPEEPAY',
} as const;
export type Brand = (typeof Brand)[keyof typeof Brand];

export const BRANDS = Object.values(Brand);

export function isBrand(value: string): value is Brand {
  return (BRANDS as string[]).includes(value);
}

/** Pemetaan jenis_id TokoVoucher ke brand internal. */
export const JENIS_ID_TO_BRAND: Record<number, Brand> = {
  123: Brand.DANA,
  124: Brand.OVO,
  125: Brand.GOPAY,
  128: Brand.SHOPEEPAY,
};

/**
 * Prefix kode produk ke brand. Ini fallback untuk baris katalog yang jenis_id
 * atau namanya tidak konsisten -- di CSV supplier, produk GoPay (jenis_id 125)
 * bernama "Customer 10.000", jadi nama produk tidak bisa dipercaya untuk
 * menentukan brand.
 */
export const KODE_PREFIX_TO_BRAND: Array<[string, Brand]> = [
  ['DANA', Brand.DANA],
  ['OVO', Brand.OVO],
  ['GOPAY', Brand.GOPAY],
  ['HSHOP', Brand.SHOPEEPAY],
  ['SHOPEE', Brand.SHOPEEPAY],
];

/** Nama brand untuk ditampilkan ke user. */
export const BRAND_LABEL: Record<Brand, string> = {
  DANA: 'DANA',
  OVO: 'OVO',
  GOPAY: 'GoPay',
  SHOPEEPAY: 'ShopeePay',
};

export const TxStatus = {
  /** Transaksi dibuat, saldo sudah didebit, belum dikirim ke supplier. */
  PENDING: 'PENDING',
  /** Sudah dikirim ke supplier, menunggu hasil akhir. */
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  /** Gagal dan saldo sudah dikembalikan ke user. */
  REFUNDED: 'REFUNDED',
} as const;
export type TxStatus = (typeof TxStatus)[keyof typeof TxStatus];

/** Status akhir: tidak akan berubah lagi, worker berhenti memantau. */
export const TERMINAL_TX_STATUSES: TxStatus[] = [
  TxStatus.SUCCESS,
  TxStatus.FAILED,
  TxStatus.REFUNDED,
];

export function isTerminal(status: string): boolean {
  return (TERMINAL_TX_STATUSES as string[]).includes(status);
}

export const DepositStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
} as const;
export type DepositStatus = (typeof DepositStatus)[keyof typeof DepositStatus];

export const LedgerType = {
  DEPOSIT: 'DEPOSIT',
  PURCHASE: 'PURCHASE',
  REFUND: 'REFUND',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type LedgerType = (typeof LedgerType)[keyof typeof LedgerType];

/**
 * Kode bank_id -> label tampilan. Diambil langsung dari endpoint publik
 * TokoVoucher yang dipakai halaman member.tokovoucher.net/list-bank
 * (GET https://api.tokovoucher.net/v1/transfer/bank/list), disaring hanya
 * baris yang punya bank_id (beberapa bank di daftar itu tidak punya kode dan
 * berarti tidak didukung transfer). Label diformat ulang dari nama resmi
 * (semula huruf besar semua) untuk tampilan, kode-nya (key di object ini)
 * TIDAK diubah -- itu yang dikirim apa adanya ke parameter `bank`.
 *
 * Kode yang tidak ada di sini tetap diterima dan diteruskan apa adanya ke
 * TokoVoucher (validasi kode bank sepenuhnya di sisi mereka); map ini cuma
 * mempercantik label di UI.
 */
export const BANK_LABEL: Record<string, string> = {
  seabank: 'SeaBank',
  bca: 'Bank BCA',
  mandiri: 'Bank Mandiri',
  bri: 'Bank BRI',
  artos: 'Bank Jago',
};

export const Role = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
