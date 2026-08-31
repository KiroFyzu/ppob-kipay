# PPOB E-Wallet

Top up e-wallet (DANA, OVO, GoPay, ShopeePay) dengan TokoVoucher sebagai
supplier H2H. Terdiri dari REST API dan halaman web server-rendered yang
berbagi satu lapisan service yang sama.

Stack: Node.js + TypeScript + Express + Prisma + PostgreSQL (Supabase) + EJS.

## Menjalankan

```bash
npm install
cp .env.example .env          # lalu isi JWT_SECRET, DATABASE_URL, DIRECT_URL (Supabase)
npm run db:push               # menerapkan skema Prisma ke database Supabase
npm run seed:products         # impor 193 produk dari harga-produk-tokovoucher.csv
npm run seed:admin -- admin@domainmu.com
npm run dev
```

`DATABASE_URL` dan `DIRECT_URL` diambil dari Supabase Dashboard > Project
Settings > Database > Connection string — yang pertama connection pooler
(port 6543), yang kedua koneksi langsung (port 5432) khusus dipakai Prisma
CLI saat migrate/db push.

Buka `http://localhost:3000` untuk halaman web; API ada di `/api/v1`. Worker
ikut jalan di proses yang sama.

Menguji seluruh alur dari ujung ke ujung (server harus sudah jalan):

```bash
ADMIN_PASS='password-admin' npm run test:smoke   # 40 skenario API
ADMIN_PASS='password-admin' npm run test:web     # 52 skenario halaman web
```

Untuk produksi, `npm run build` mengompilasi TypeScript **dan** menyalin
`views/` serta `public/` ke `dist/` — tanpa langkah salin itu server produksi
tetap menyala tapi setiap halaman gagal dirender.

## Status supplier

Secara bawaan `TOKOVOUCHER_MODE=mock`, artinya **tidak ada request yang keluar**
dan tidak ada saldo asli yang terpotong. Provider tiruan meniru semua jalur,
dipilih lewat akhiran nomor tujuan:

| Nomor berakhiran | Perilaku |
|---|---|
| `000` | Gagal → saldo di-refund |
| `111` | Pending → dituntaskan worker rekonsiliasi |
| `999` | Supplier tidak bisa dihubungi → transaksi ditahan `PROCESSING` |
| lainnya | Sukses seketika |

Sebelum beralih ke `live`, tiga hal di `src/providers/tokovoucher/client.ts`
harus dicocokkan dengan dokumentasi di dashboard member: path endpoint, rumus
signature, dan nama field pada respons. Bagian lain aplikasi tidak perlu diubah.

## Halaman web

| Path | Keterangan |
|---|---|
| `/` | Beranda: pilih layanan, nominal, dan nomor tujuan |
| `/transfer-bank` | Kirim saldo ke rekening bank, riwayatnya |
| `/transfer-bank/:refId` | Struk transfer bank |
| `/docs` | Dokumentasi API (publik, tidak perlu login) |
| `/masuk`, `/daftar` | Autentikasi |
| `/dasbor` | Ringkasan saldo dan transaksi terakhir |
| `/transaksi` | Riwayat, bisa disaring per status |
| `/transaksi/:refId` | Struk transaksi |
| `/saldo` | Saldo, mutasi, dan pembuatan tagihan deposit (QRIS menampilkan QR langsung di halaman) |
| `/saldo/deposit/:invoiceId` | Instruksi pembayaran |
| `/akun` | Kelola API key: buat, regenerate, cabut |
| `/admin` | Konfirmasi deposit, transaksi bermasalah, blokir nomor/rekening |

Beberapa keputusan yang perlu diketahui sebelum mengubah bagian ini:

**Handler halaman memanggil service secara langsung**, bukan memanggil API
sendiri lewat HTTP. Memanggil API sendiri berarti satu perjalanan jaringan
tambahan, penanganan error ganda, dan dua sumber kebenaran yang lama-lama
berbeda perilaku.

**Sesi web memakai cookie httpOnly**, bukan token di localStorage, sehingga
satu celah XSS tidak langsung berubah menjadi pencurian sesi. Konsekuensinya
cookie ikut terkirim otomatis di setiap request, jadi **semua form POST wajib
melewati verifikasi CSRF** (`src/web/csrf.ts`). Tanpa itu, situs lain bisa
memasang form tersembunyi yang membelanjakan saldo pengunjungnya. API tidak
menyentuh cookie sama sekali dan tetap memakai header `Authorization`.

**Halaman tetap berfungsi tanpa JavaScript.** Memilih brand berjalan lewat
tautan biasa (`/?brand=DANA`), dan halaman status menyegarkan diri dengan
`<meta http-equiv="refresh">`. Berkas `public/js/app.js` hanya mempercepat
keduanya; kalau gagal dimuat, situs tetap utuh.

**Content Security Policy melarang inline script dan style.** CSP yang
mengizinkan `unsafe-inline` kehilangan sebagian besar manfaatnya sebagai
penahan XSS, jadi seluruh CSS dan JS berada di file terpisah di `public/`.

**Hati-hati dengan `<%= %>` di EJS**: tag itu meng-escape HTML, jadi
`<%= 'aria-current="true"' %>` menghasilkan atribut rusak. Tulis atributnya
utuh di template dan isi hanya nilainya.

## Endpoint API

Semua respons berbentuk `{ "success": true, "data": ... }` atau
`{ "success": false, "error": { "code", "message", "details" } }`. Jalur
`/api/*` selalu membalas JSON; halaman web mendapat HTML, termasuk saat error.

### Publik

| Method | Path | Keterangan |
|---|---|---|
| GET | `/health` | Status server dan database |
| GET | `/api/v1/products/brands` | Daftar brand beserta rentang nominal |
| GET | `/api/v1/products?brand=DANA` | Katalog produk dan harga jual |
| POST | `/api/v1/auth/register` | Daftar akun (langsung dapat JWT + satu API key default) |
| POST | `/api/v1/auth/login` | Login, mengembalikan JWT |

### Perlu autentikasi

Kirim `Authorization: Bearer <jwt>` atau `X-API-Key: sk_...`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/v1/auth/me` | Profil singkat |
| POST | `/api/v1/auth/api-keys` | Buat API key tambahan (ditampilkan sekali) |
| GET | `/api/v1/auth/api-keys` | Daftar API key |
| POST | `/api/v1/auth/api-keys/:id/regenerate` | Cabut key lama, buat key baru dengan label sama |
| DELETE | `/api/v1/auth/api-keys/:id` | Cabut API key |
| GET | `/api/v1/balance` | Saldo saat ini |
| GET | `/api/v1/balance/history` | Riwayat mutasi saldo |
| POST | `/api/v1/balance/deposits` | Buat tagihan deposit (`method`: `MANUAL_TRANSFER` atau `QRIS`) |
| GET | `/api/v1/balance/deposits` | Daftar deposit |
| GET | `/api/v1/balance/deposits/:invoiceId/qr.png` | Gambar QR (deposit QRIS) |
| POST | `/api/v1/balance/deposits/:invoiceId/cancel` | Batalkan deposit |
| POST | `/api/v1/transactions` | Buat transaksi top up e-wallet |
| GET | `/api/v1/transactions` | Riwayat transaksi top up |
| GET | `/api/v1/transactions/:refId` | Detail satu transaksi top up |
| POST | `/api/v1/bank-transfers` | Kirim saldo ke rekening bank (`bankCode`, `targetNumber`, `nominal`) |
| GET | `/api/v1/bank-transfers` | Riwayat transfer bank |
| GET | `/api/v1/bank-transfers/:refId` | Detail satu transfer bank |

### Admin

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/v1/admin/supplier/balance` | Saldo kita di TokoVoucher |
| POST | `/api/v1/admin/products/sync` | Tarik katalog dari API supplier |
| GET | `/api/v1/admin/stats` | Ringkasan: produk, pengguna, transaksi ditinjau, keuntungan |
| POST | `/api/v1/admin/deposits/:invoiceId/confirm` | Konfirmasi pembayaran manual |
| POST | `/api/v1/admin/balance/adjust` | Penyesuaian saldo (wajib beralasan) |
| GET | `/api/v1/admin/balance/audit/:userId` | Bandingkan saldo dengan ledger |
| GET/POST/DELETE | `/api/v1/admin/blocked-targets` | Kelola nomor yang diblokir |
| GET | `/api/v1/admin/transactions/flagged` | Transaksi yang butuh tinjauan manual |
| GET | `/api/v1/admin/transactions/successful` | Transaksi sukses lintas user (e-wallet + transfer bank) |
| GET | `/api/v1/admin/users` | Daftar pengguna terdaftar |
| POST | `/api/v1/admin/users/:id/activate` | Aktifkan akun |
| POST | `/api/v1/admin/users/:id/deactivate` | Nonaktifkan akun (tidak bisa untuk akun sendiri) |

### Webhook

- `POST /api/v1/webhooks/tokovoucher` — callback supplier untuk topup e-wallet
  maupun transfer bank (dibedakan lewat `ref_id`), wajib menyertakan header
  `X-TokoVoucher-Authorization` berisi `md5(member_code:signature_key:ref_id)`
  — rumus yang sama dipakai untuk menandatangani order, bukan secret terpisah.
- `POST /api/v1/webhooks/kipay` — callback KiPay untuk deposit QRIS, wajib
  menyertakan header `X-Webhook-Signature` berisi
  `sha256=` + HMAC-SHA256(raw body, `KIPAY_WEBHOOK_SECRET`). Daftarkan URL ini
  sebagai Webhook URL project di dashboard KiPay untuk mendapatkan secretnya.

## Contoh membuat transaksi

Produk boleh disebut lewat `brand` + `nominal`, atau langsung `kodeProduk`.
Cara pertama membuat client tidak perlu tahu 193 kode produk dan tetap benar
meski katalog supplier berubah.

```bash
curl -X POST http://localhost:3000/api/v1/transactions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-12345" \
  -d '{ "brand": "DANA", "nominal": 25000, "targetNumber": "081234567890" }'
```

`Idempotency-Key` bersifat opsional tapi sangat disarankan: percobaan ulang
dengan key yang sama mengembalikan transaksi yang sama, bukan membuat
transaksi baru.

## Status transaksi

Kolom `status` pada `Transaction` dan `BankTransfer` (lihat `src/domain/enums.ts`,
label Indonesianya di `src/web/view-helpers.ts`):

| Nilai | Label web | Arti |
|---|---|---|
| `PENDING` | Menunggu | Baru dibuat, belum dikirim ke supplier |
| `PROCESSING` | Diproses | Sudah dikirim, hasil belum pasti (saldo sudah terpotong); dicek ulang worker rekonsiliasi, atau di-refund manual admin kalau macet |
| `SUCCESS` | Berhasil | Final — terkirim ke tujuan |
| `FAILED` | Gagal | Final — saldo otomatis di-refund |
| `REFUNDED` | Dikembalikan | Final — saldo sudah dikembalikan (otomatis dari `FAILED` atau manual dari `PROCESSING`) |

Detail lengkap alur `PROCESSING` ada di bagian "Bagaimana uang dijaga" di
bawah, dan di dokumentasi API publik (`/docs#status-transaksi`).

## Bagaimana uang dijaga

Ini bagian yang paling menentukan, jadi ditulis eksplisit.

**Ledger, bukan kolom saldo.** Setiap pergerakan uang menjadi satu baris di
`ledger_entries` yang mencatat saldo sebelum dan sesudah. Kolom `users.balance`
hanyalah cache. `GET /admin/balance/audit/:userId` menghitung ulang dari ledger
dan melaporkan selisihnya — kalau pernah tidak nol, ada bug yang harus dikejar.

**Satu peristiwa, satu mutasi.** Tiap mutasi punya `postingKey` unik
(`PURCHASE:<txId>`, `REFUND:<txId>`, `DEPOSIT:<txId>`). Constraint unique di
kolom itu yang membuat callback ganda, retry, atau klik dua kali tidak bisa
memotong maupun mengembalikan saldo dua kali.

**Debit dulu, kirim kemudian.** Saldo dipotong dan transaksi dicatat dalam satu
database transaction, baru order dikirim ke supplier. Kalau urutannya dibalik,
ada jendela di mana order sudah terkirim tapi belum tercatat — dan proses yang
mati di jendela itu membuat uang keluar tanpa jejak. Panggilan HTTP ke supplier
dilakukan di luar database transaction, supaya menunggu jaringan tidak mengunci
tabel.

**Ragu berarti tidak me-refund.** Kalau supplier tidak bisa dihubungi atau
membalas dengan status yang tidak dikenali, transaksi dibiarkan `PROCESSING`,
bukan digagalkan. Menebak "gagal" berarti user bisa menerima saldo e-wallet
**dan** uangnya kembali. Transaksi yang tidak juga jelas setelah
`RECONCILE_STUCK_AFTER_MINUTES` ditandai untuk diperiksa manusia, tetap tanpa
refund otomatis.

**Callback tidak dipercaya sendirian.** Worker rekonsiliasi memeriksa aktif
setiap transaksi yang menggantung dengan backoff 10s → 20s → 40s → … → 30 menit,
sehingga callback yang tidak pernah sampai tidak membuat transaksi tergantung
selamanya. Worker juga menyelamatkan transaksi yang saldonya sudah terpotong
tapi belum sempat terkirim.

## Lapisan anti-fraud

Saldo e-wallet bersifat likuid dan transaksinya tidak bisa ditarik kembali,
jadi satu-satunya titik kendali yang efektif adalah sebelum order dikirim.
Semua batas diatur lewat `.env`:

- Jeda minimum antar transaksi ke nomor tujuan yang sama
- Batas jumlah dan total rupiah per nomor tujuan per 24 jam, **berlaku lintas
  akun** — kalau tidak, pelaku tinggal membuat banyak akun untuk menembak nomor
  yang sama
- Batas jumlah transaksi per user per jam
- Daftar nomor yang diblokir
- Validasi prefix operator seluler sebelum uang bergerak

Rate limit HTTP terpasang terpisah sebagai penahan banjir request. Khusus
endpoint autentikasi, pembatasnya **dua lapis** (`src/http/rate-limits.ts`):
ketat per alamat email, longgar per IP. Membatasi hanya per-IP punya kelemahan
serius di Indonesia — operator seluler menempatkan banyak pelanggan di balik
satu IP publik (CGNAT), sehingga beberapa percobaan login gagal dari satu orang
bisa mengunci pengguna lain yang kebetulan memakai operator yang sama. Lapis
per-akun juga tetap bekerja walau penyerang berganti-ganti IP.

## Catatan produksi

**Database Postgres (Supabase).** Saldo dikunci dengan
`SELECT ... FOR UPDATE` di `src/modules/balance/ledger.service.ts` supaya dua
mutasi konkuren terhadap user yang sama tidak saling menimpa. Kolom
status/role/brand tetap bertipe `String` (bukan enum Postgres) dan dibatasi
lewat konstanta di `src/domain/enums.ts`.

**Worker harus tunggal.** Saat ini worker ikut jalan di proses API. Kalau API
di-scale ke banyak instance, jalankan worker sebagai proses tersendiri
(`npm run worker`) dan matikan `startWorkers()` di `src/server.ts` — kalau
tidak, setiap instance akan memeriksa transaksi yang sama bersamaan.

**Deposit QRIS lewat KiPay.** Method `QRIS` di `POST /api/v1/balance/deposits`
membuat tagihan QRIS lewat KiPay (kipay.id/docs) dan butuh `KIPAY_API_KEY` +
`KIPAY_WEBHOOK_SECRET` terisi -- tanpa itu, permintaan deposit QRIS ditolak
dengan `PAYMENT_GATEWAY_UNAVAILABLE`. Method `MANUAL_TRANSFER` tetap tersedia
sebagai fallback tanpa payment gateway, dikonfirmasi admin lewat
`POST /api/v1/admin/deposits/:invoiceId/confirm`. Kedua method bermuara ke
`markDepositPaid()` yang sama, jadi mengganti/menambah payment gateway lain
nanti tidak mengubah logika saldo sama sekali.

**Transfer bank lewat TokoVoucher.** `POST /api/v1/bank-transfers` mengirim
saldo user langsung ke rekening bank (docs.tokovoucher.net/bank-transfer).
Modelnya (`BankTransfer`) terpisah dari `Transaction` karena tidak ada katalog
Product di baliknya -- kode bank dan nominal bebas per permintaan, dibatasi
lewat `BANK_TRANSFER_MIN_AMOUNT`/`BANK_TRANSFER_MAX_AMOUNT`. Alur ledger,
idempotency, refund-saat-gagal, dan worker rekonsiliasinya sama persis dengan
topup e-wallet.

**Harga jual dihitung ulang otomatis** dari harga modal terbaru setiap kali
katalog disinkronkan, jadi kenaikan harga supplier tidak diam-diam memakan
margin. Rumusnya diatur lewat `MARKUP_FLAT`, `MARKUP_PERCENT`, dan
`PRICE_ROUNDING`.

## Struktur

```
src/
  config/env.ts              validasi environment, gagal cepat saat startup
  domain/enums.ts            nilai status/brand (String, bukan enum Postgres)
  lib/                       prisma, logger, tipe error
  utils/                     normalisasi nomor, perhitungan harga, ref id
  providers/tokovoucher/     satu-satunya tempat yang tahu format API supplier
  modules/
    auth/                    JWT dan API key
    products/                katalog dan pricing
    balance/                 ledger dan deposit
    transactions/            alur transaksi dan anti-fraud
  http/
    app.ts                   perakitan Express, CSP, view engine
    rate-limits.ts           pembatas autentikasi dua lapis
    routes/, middleware/     endpoint API JSON
  web/
    web.routes.ts            handler halaman
    web-auth.middleware.ts   sesi berbasis cookie httpOnly
    csrf.ts                  double-submit cookie
    view-helpers.ts          format rupiah, tanggal, lencana status
  workers/                   rekonsiliasi status, penutupan deposit
views/
  partials/                  head, footer, tabel transaksi
  pages/                     satu berkas per halaman
public/
  css/style.css              satu stylesheet, mendukung mode gelap
  js/app.js                  peningkatan progresif saja
scripts/
  seed-products.ts           impor katalog dari CSV
  seed-admin.ts              buat akun admin pertama
  copy-assets.mjs            salin views dan public ke dist saat build
  smoke-test.mjs             uji 40 skenario API
  web-smoke-test.mjs         uji 52 skenario halaman web
```
