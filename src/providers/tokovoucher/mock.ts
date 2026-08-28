import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import {
  BankTransferParams,
  OrderParams,
  SupplierBalance,
  SupplierOrderResult,
  SupplierProduct,
  SupplierProvider,
  SupplierUnavailableError,
} from './types';

/**
 * Provider tiruan untuk pengembangan dan pengujian, tanpa memotong saldo asli.
 *
 * Perilakunya sengaja dibuat "jahat" supaya alur yang jarang terjadi ikut
 * teruji sejak awal -- bukan cuma jalur sukses:
 *
 *   - Nomor berakhiran 000 selalu GAGAL      -> menguji jalur refund
 *   - Nomor berakhiran 111 tertahan PENDING  -> menguji worker rekonsiliasi
 *     (baru menjadi sukses setelah dicek beberapa kali)
 *   - Nomor berakhiran 999 melempar error    -> menguji penanganan supplier
 *     tidak bisa dihubungi, transaksi harus tetap PROCESSING dan TIDAK
 *     langsung di-refund
 *   - Selain itu sukses seketika
 */
export class MockSupplierClient implements SupplierProvider {
  readonly name = 'mock';

  /** refId -> berapa kali statusnya sudah dicek. */
  private readonly checkCounts = new Map<string, number>();
  private readonly orders = new Map<string, SupplierOrderResult>();

  async order({ refId, kodeProduk, targetNumber }: OrderParams): Promise<SupplierOrderResult> {
    logger.warn(
      { refId, kodeProduk, targetNumber },
      'MOCK supplier: order tidak dikirim ke mana pun',
    );

    await delay(150);

    if (targetNumber.endsWith('999')) {
      throw new SupplierUnavailableError('MOCK: supplier sedang tidak bisa dihubungi');
    }

    const result: SupplierOrderResult = targetNumber.endsWith('000')
      ? {
          status: 'failed',
          trxId: `MOCK-${randomUUID().slice(0, 8)}`,
          serialNumber: null,
          message: 'MOCK: tujuan diblokir oleh operator',
          price: null,
          raw: { mock: true },
        }
      : targetNumber.endsWith('111')
        ? {
            status: 'pending',
            trxId: `MOCK-${randomUUID().slice(0, 8)}`,
            serialNumber: null,
            message: 'MOCK: sedang diproses',
            price: null,
            raw: { mock: true },
          }
        : {
            status: 'success',
            trxId: `MOCK-${randomUUID().slice(0, 8)}`,
            serialNumber: `SN${Date.now()}`,
            message: 'MOCK: transaksi berhasil',
            price: null,
            raw: { mock: true },
          };

    this.orders.set(refId, result);
    return result;
  }

  /** Konvensi status sama seperti order(), tapi dipicu lewat nomor rekening. */
  async transferBank({
    refId,
    bankCode,
    accountNumber,
    nominal,
  }: BankTransferParams): Promise<SupplierOrderResult> {
    logger.warn(
      { refId, bankCode, accountNumber, nominal },
      'MOCK supplier: transfer bank tidak dikirim ke mana pun',
    );

    await delay(150);

    if (accountNumber.endsWith('999')) {
      throw new SupplierUnavailableError('MOCK: supplier sedang tidak bisa dihubungi');
    }

    const result: SupplierOrderResult = accountNumber.endsWith('000')
      ? {
          status: 'failed',
          trxId: `MOCK-${randomUUID().slice(0, 8)}`,
          serialNumber: null,
          message: 'MOCK: nomor rekening tidak valid',
          price: null,
          raw: { mock: true },
        }
      : accountNumber.endsWith('111')
        ? {
            status: 'pending',
            trxId: `MOCK-${randomUUID().slice(0, 8)}`,
            serialNumber: null,
            message: 'MOCK: sedang diproses',
            price: null,
            raw: { mock: true },
          }
        : {
            status: 'success',
            trxId: `MOCK-${randomUUID().slice(0, 8)}`,
            serialNumber: null,
            message: 'MOCK: transfer berhasil',
            price: null,
            raw: { mock: true },
          };

    this.orders.set(refId, result);
    return result;
  }

  async checkStatus(refId: string): Promise<SupplierOrderResult> {
    await delay(100);

    const stored = this.orders.get(refId);
    if (!stored) {
      return {
        status: 'failed',
        trxId: null,
        serialNumber: null,
        message: 'MOCK: transaksi tidak ditemukan',
        price: null,
        raw: { mock: true },
      };
    }

    if (stored.status !== 'pending') return stored;

    // Yang pending menjadi sukses setelah dicek 3 kali, meniru transaksi
    // yang butuh waktu di sisi supplier.
    const count = (this.checkCounts.get(refId) ?? 0) + 1;
    this.checkCounts.set(refId, count);

    if (count < 3) return stored;

    const resolved: SupplierOrderResult = {
      ...stored,
      status: 'success',
      serialNumber: `SN${Date.now()}`,
      message: 'MOCK: transaksi berhasil setelah pending',
    };
    this.orders.set(refId, resolved);
    return resolved;
  }

  async getBalance(): Promise<SupplierBalance> {
    return { balance: 10_000_000, raw: { mock: true } };
  }

  async listProducts(): Promise<SupplierProduct[]> {
    // Katalog di mode mock diisi lewat `npm run seed:products` dari file CSV,
    // bukan dari sini.
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
