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
  aceh: 'Bank Aceh Syariah',
  agris: 'Bank IBK Indonesia',
  anz: 'Bank ANZ Indonesia',
  artha: 'Bank Artha Graha Internasional',
  artos: 'Bank Jago',
  bali: 'BPD Bali',
  banten: 'Bank Banten',
  bca: 'Bank BCA',
  bca_syr: 'Bank BCA Syariah',
  bengkulu: 'Bank Bengkulu',
  bii: 'Maybank Indonesia',
  bjb: 'Bank BJB',
  bjb_syr: 'Bank BJB Syariah',
  bni: 'Bank BNI',
  boc: 'Bank Of China (Hong Kong)',
  bri: 'Bank BRI',
  bsm: 'Bank BSI',
  btn: 'Bank BTN',
  btpn_syr: 'Bank Btpn Syariah',
  bukopin: 'Bank KB Bukopin',
  bukopin_syr: 'Bank KB Bukopin Syariah',
  bumi_arta: 'Bank Bumi Arta',
  capital: 'Bank Capital Indonesia',
  chinatrust: 'Bank CTBC Indonesia',
  cimb: 'Bank CIMB Niaga',
  citibank: 'Citibank',
  commonwealth: 'Bank Commonwealth',
  daerah_istimewa: 'BPD DIY',
  danamon: 'Bank Danamon',
  dbs: 'Bank DBS Indonesia',
  dki: 'Bank DKI',
  ganesha: 'Bank Ganesha',
  hana: 'Bank Keb Hana',
  harda: 'Allo Bank Indonesia',
  hsbc: 'Bank HSBC Indonesia',
  icbc: 'Bank ICBC Indonesia',
  ina_perdana: 'Bank Ina Perdana',
  index_selindo: 'Bank Index Selindo',
  india: 'Bank Of India Indonesia',
  jambi: 'BPD Jambi',
  jasa_jakarta: 'Bank Jasa Jakarta',
  jawa_tengah: 'Bank Jateng',
  jawa_timur: 'Bank Jatim',
  kalimantan_barat: 'Bank Kalbar',
  kalimantan_selatan: 'BPD Kalsel',
  kalimantan_tengah: 'BPD Kalteng',
  kesejahteraan_ekonomi: 'Seabank Indonesia',
  lampung: 'Bank Lampung',
  mandiri: 'Bank Mandiri',
  mantap: 'Bank Mandiri Taspen',
  maspion: 'Bank Maspion Indonesia',
  mayapada: 'Bank Mayapada',
  mayora: 'Bank Mayora',
  mega: 'Bank Mega',
  mega_syr: 'Bank Mega Syariah',
  mestika_dharma: 'Bank Mestika Dharma',
  mnc_internasional: 'Bank MNC Internasional',
  muamalat: 'Bank Muamalat Indonesia',
  nationalnobu: 'Bank Nationalnobu',
  nusa_tenggara_barat: 'Bank NTB Syariah',
  nusa_tenggara_timur: 'Bank NTT',
  nusantara_parahyangan: 'Bank Nusantara Parahyangan',
  ocbc: 'Bank OCBC Nisp',
  panin: 'Bank Panin',
  panin_syr: 'Bank Panin Dubai Syariah',
  papua: 'Bank Papua',
  permata: 'Bank Permata',
  prima: 'Prima Master Bank',
  qnb_kesawan: 'Bank QNB Indonesia',
  riau_dan_kepri: 'Bank Riau Kepri',
  royal: 'Bank Digital BCA',
  sahabat_sampoerna: 'Bank Sahabat Sampoerna',
  sbi_indonesia: 'Bank SBI Indonesia',
  shinhan: 'Bank Shinhan Indonesia',
  sinarmas: 'Bank Sinarmas',
  standard_chartered: 'Standard Chartered Bank',
  sulawesi: 'Bank Sulteng',
  sulawesi_tenggara: 'Bank Sultra',
  sulselbar: 'Bank Sulselbar',
  sulut: 'Bank Sulutgo',
  sumatera_barat: 'Bank Nagari',
  sumsel_dan_babel: 'Bank Sumsel Babel',
  sumut: 'Bank Sumut',
  tabungan_pensiunan_nasional: 'Bank Btpn',
  uob: 'Bank UOB Indonesia',
  victoria_internasional: 'Bank Victoria International',
  victoria_syr: 'Bank Victoria Syariah',
  woori: 'Bank Woori Saudara',
  yudha_bakti: 'Bank Neo Commerce',
};

export const Role = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
