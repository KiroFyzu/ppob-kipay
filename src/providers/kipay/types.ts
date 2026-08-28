/**
 * Bentuk hasil yang dinormalisasi dari KiPay (kipay.id/docs). Format mentah
 * (snake_case) tidak boleh bocor keluar dari folder providers/ -- lihat
 * alasan yang sama di providers/tokovoucher/types.ts.
 */

export type KipayStatus = 'pending' | 'paid' | 'expired';

export interface KipayTransaction {
  trxId: string;
  mode: 'sandbox' | 'production';
  /** Nominal yang diminta (sebelum kode unik) -- ini yang masuk saldo user. */
  requestedAmount: number;
  uniqueCode: number;
  /** requestedAmount + uniqueCode -- ini yang harus dibayar user PERSIS. */
  amount: number;
  feeAmount: number;
  netAmount: number;
  status: KipayStatus;
  provider: string | null;
  /** Payload EMV QRIS mentah, dipakai untuk render QR. */
  qrPayload: string | null;
  matchedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  raw: unknown;
}

export class KipayUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'KipayUnavailableError';
  }
}
