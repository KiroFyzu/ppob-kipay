/**
 * Bentuk hasil yang dinormalisasi. Seluruh aplikasi hanya mengenal tipe di
 * file ini -- format mentah TokoVoucher tidak boleh bocor keluar dari folder
 * providers/. Kalau suatu saat ganti supplier, hanya folder ini yang diubah.
 */

/** Status yang sudah dinormalisasi dari beragam istilah milik supplier. */
export type SupplierStatus = 'success' | 'pending' | 'failed';

export interface SupplierOrderResult {
  status: SupplierStatus;
  /** ID transaksi di sisi supplier, untuk pelacakan dan komplain. */
  trxId: string | null;
  /** Serial number / bukti dari supplier bila ada. */
  serialNumber: string | null;
  message: string;
  /** Harga yang benar-benar dipotong supplier, kalau dilaporkan. */
  price: number | null;
  /** Respons mentah, disimpan untuk audit. */
  raw: unknown;
}

export interface SupplierBalance {
  balance: number;
  raw: unknown;
}

export interface SupplierProduct {
  kodeProduk: string;
  jenisId: number;
  namaProduk: string;
  price: number;
  isActive: boolean;
  raw: unknown;
}

export interface OrderParams {
  refId: string;
  kodeProduk: string;
  targetNumber: string;
}

export interface BankTransferParams {
  refId: string;
  bankCode: string;
  accountNumber: string;
  nominal: number;
}

export interface SupplierProvider {
  readonly name: string;
  order(params: OrderParams): Promise<SupplierOrderResult>;
  checkStatus(refId: string): Promise<SupplierOrderResult>;
  getBalance(): Promise<SupplierBalance>;
  listProducts(): Promise<SupplierProduct[]>;
  /** docs.tokovoucher.net/bank-transfer -- kirim saldo ke rekening bank. */
  transferBank(params: BankTransferParams): Promise<SupplierOrderResult>;
}

/**
 * Dilempar saat supplier tidak bisa dihubungi atau membalas dengan bentuk yang
 * tidak dikenali. Bedakan dari penolakan bisnis (saldo kurang, produk gangguan)
 * yang tetap dikembalikan sebagai SupplierOrderResult berstatus 'failed'.
 *
 * Ini penting: kegagalan transport berarti kita TIDAK TAHU apakah transaksi
 * sudah masuk ke supplier, jadi transaksi harus tetap PROCESSING dan diperiksa
 * ulang oleh worker -- bukan langsung di-refund.
 */
export class SupplierUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SupplierUnavailableError';
  }
}
