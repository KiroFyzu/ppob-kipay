import { config } from 'dotenv';
import { z } from 'zod';

config();

const int = (fallback: number) => z.coerce.number().int().default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.string().default('info'),
    CORS_ORIGIN: z.string().default('*'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET minimal 32 karakter'),
    JWT_EXPIRES_IN: z.string().default('1d'),

    /**
     * mock = tidak ada request keluar, dipakai selama dokumentasi API supplier
     * belum diverifikasi. live = benar-benar memotong saldo TokoVoucher.
     */
    TOKOVOUCHER_MODE: z.enum(['mock', 'live']).default('mock'),
    TOKOVOUCHER_BASE_URL: z.string().url().default('https://api.tokovoucher.net'),
    TOKOVOUCHER_MEMBER_CODE: z.string().default(''),
    TOKOVOUCHER_SIGNATURE_KEY: z.string().default(''),

    MARKUP_FLAT: int(500),
    MARKUP_PERCENT: z.coerce.number().default(1),
    PRICE_ROUNDING: int(100),

    DEPOSIT_MIN_AMOUNT: int(10_000),
    DEPOSIT_MAX_AMOUNT: int(10_000_000),
    DEPOSIT_EXPIRY_MINUTES: int(60),

    /**
     * KiPay (kipay.id) -- payment gateway QRIS dipakai untuk deposit method
     * QRIS. KIPAY_API_KEY adalah api_key project (format qpg_...), dikirim di
     * URL path, bukan header -- lihat dokumentasi resmi.
     */
    KIPAY_BASE_URL: z.string().url().default('https://kipay.id'),
    KIPAY_API_KEY: z.string().default(''),
    KIPAY_WEBHOOK_SECRET: z.string().default(''),

    BANK_TRANSFER_MIN_AMOUNT: int(10_000),
    BANK_TRANSFER_MAX_AMOUNT: int(5_000_000),

    FRAUD_MAX_TX_PER_TARGET_DAY: int(5),
    FRAUD_MAX_AMOUNT_PER_TARGET_DAY: int(2_000_000),
    FRAUD_MAX_TX_PER_USER_HOUR: int(20),
    FRAUD_MIN_INTERVAL_SECONDS: int(60),

    RECONCILE_INTERVAL_MS: int(15_000),
    RECONCILE_BATCH_SIZE: int(25),
    RECONCILE_STUCK_AFTER_MINUTES: int(60),
  })
  .superRefine((value, ctx) => {
    // Mode live tanpa kredensial akan gagal saat transaksi pertama, dan saat
    // itu uang user sudah terlanjur didebit. Lebih baik ditolak sejak startup.
    if (value.TOKOVOUCHER_MODE === 'live') {
      if (!value.TOKOVOUCHER_MEMBER_CODE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TOKOVOUCHER_MEMBER_CODE'],
          message: 'wajib diisi saat TOKOVOUCHER_MODE=live',
        });
      }
      if (!value.TOKOVOUCHER_SIGNATURE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TOKOVOUCHER_SIGNATURE_KEY'],
          message: 'wajib diisi saat TOKOVOUCHER_MODE=live',
        });
      }
    }

    if (value.NODE_ENV === 'production' && value.CORS_ORIGIN === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'jangan pakai * di produksi, sebutkan domain yang diizinkan',
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;
