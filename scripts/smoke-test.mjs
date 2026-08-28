const BASE = 'http://127.0.0.1:3000/api/v1';
let pass = 0, fail = 0;

function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const stamp = Date.now();
  const email = `user${stamp}@test.local`;

  console.log('\n--- 1. Katalog publik ---');
  const brands = await call('GET', '/products/brands');
  check('GET /products/brands = 200', brands.status === 200);
  check('4 brand tersedia', brands.json?.data?.length === 4, JSON.stringify(brands.json?.data));

  const dana = await call('GET', '/products?brand=dana');
  check('filter brand case-insensitive', dana.status === 200 && dana.json.data.count === 113,
    `count=${dana.json?.data?.count}`);
  const sample = dana.json.data.products.find((p) => p.nominal === 10000);
  check('harga jual > modal (10.209 -> markup)', sample.price > 10209, `price=${sample.price}`);
  check('harga modal tidak bocor ke client', !('basePrice' in sample), JSON.stringify(sample));

  const badBrand = await call('GET', '/products?brand=BITCOIN');
  check('brand tidak dikenal ditolak 400', badBrand.status === 400);

  console.log('\n--- 2. Registrasi & auth ---');
  const reg = await call('POST', '/auth/register', {
    body: { email, password: 'password123', name: 'User Uji' },
  });
  check('register = 201', reg.status === 201, JSON.stringify(reg.json));
  const token = reg.json.data.token;

  const weak = await call('POST', '/auth/register', {
    body: { email: `w${stamp}@t.local`, password: 'abc', name: 'X' },
  });
  check('password lemah ditolak 400', weak.status === 400);

  const noAuth = await call('GET', '/transactions');
  check('tanpa token ditolak 401', noAuth.status === 401);

  console.log('\n--- 3. Saldo kosong menolak transaksi ---');
  const poor = await call('POST', '/transactions', {
    token,
    body: { brand: 'DANA', nominal: 10000, targetNumber: '081234567890' },
  });
  check('saldo kurang ditolak 409', poor.status === 409, `status=${poor.status}`);
  check('kode error INSUFFICIENT_BALANCE',
    poor.json?.error?.code === 'INSUFFICIENT_BALANCE', JSON.stringify(poor.json?.error));

  console.log('\n--- 4. Deposit saldo ---');
  const dep = await call('POST', '/balance/deposits', {
    token, body: { amount: 500000, method: 'MANUAL_TRANSFER' },
  });
  check('deposit dibuat = 201', dep.status === 201, JSON.stringify(dep.json));
  const invoiceId = dep.json.data.invoiceId;
  check('ada kode unik pada nominal transfer', dep.json.data.totalPaid > dep.json.data.amount,
    `totalPaid=${dep.json.data.totalPaid}`);

  const admin = await call('POST', '/auth/login', {
    body: { email: 'admin@ppob.local', password: process.env.ADMIN_PASS },
  });
  check('login admin = 200', admin.status === 200, JSON.stringify(admin.json));
  const adminToken = admin.json.data.token;

  const forbidden = await call('GET', '/admin/blocked-targets', { token });
  check('user biasa ditolak dari /admin 403', forbidden.status === 403);

  const confirm = await call('POST', `/admin/deposits/${invoiceId}/confirm`, { token: adminToken });
  check('konfirmasi deposit = 200', confirm.status === 200, JSON.stringify(confirm.json));

  const confirmAgain = await call('POST', `/admin/deposits/${invoiceId}/confirm`, { token: adminToken });
  check('konfirmasi ulang tidak menambah saldo dua kali', confirmAgain.status === 200);

  const bal1 = await call('GET', '/balance', { token });
  check('saldo = 500.000 setelah dua kali konfirmasi',
    bal1.json.data.balance === 500000, `balance=${bal1.json.data.balance}`);

  console.log('\n--- 5. Transaksi sukses ---');
  const okTx = await call('POST', '/transactions', {
    token, body: { brand: 'DANA', nominal: 10000, targetNumber: '081234567890' },
  });
  check('transaksi dibuat = 201', okTx.status === 201, JSON.stringify(okTx.json));
  check('status SUCCESS', okTx.json.data.status === 'SUCCESS', okTx.json.data?.status);
  check('nomor tujuan disamarkan di respons',
    okTx.json.data.targetNumber.includes('*'), okTx.json.data.targetNumber);
  const price = okTx.json.data.price;

  const bal2 = await call('GET', '/balance', { token });
  check('saldo terpotong tepat sebesar harga jual',
    bal2.json.data.balance === 500000 - price, `${bal2.json.data.balance} vs ${500000 - price}`);

  console.log('\n--- 6. Idempotency ---');
  const key = `key-${stamp}`;
  const i1 = await call('POST', '/transactions', {
    token, headers: { 'Idempotency-Key': key },
    body: { brand: 'OVO', nominal: 20000, targetNumber: '081298765432' },
  });
  const i2 = await call('POST', '/transactions', {
    token, headers: { 'Idempotency-Key': key },
    body: { brand: 'OVO', nominal: 20000, targetNumber: '081298765432' },
  });
  check('percobaan kedua = 200 (bukan transaksi baru)', i2.status === 200, `status=${i2.status}`);
  check('refId sama', i1.json.data.refId === i2.json.data.refId,
    `${i1.json.data?.refId} vs ${i2.json.data?.refId}`);
  check('ditandai reused', i2.json.data.reused === true);

  const balAfterIdem = await call('GET', '/balance', { token });
  const expected = 500000 - price - i1.json.data.price;
  check('saldo hanya terpotong sekali',
    balAfterIdem.json.data.balance === expected,
    `${balAfterIdem.json.data.balance} vs ${expected}`);

  console.log('\n--- 7. Transaksi gagal harus refund ---');
  const before = balAfterIdem.json.data.balance;
  const failTx = await call('POST', '/transactions', {
    token, body: { brand: 'GOPAY', nominal: 50000, targetNumber: '081211112000' },
  });
  check('status REFUNDED', failTx.json.data.status === 'REFUNDED',
    JSON.stringify(failTx.json.data?.status));
  const balAfterRefund = await call('GET', '/balance', { token });
  check('saldo kembali utuh', balAfterRefund.json.data.balance === before,
    `${balAfterRefund.json.data.balance} vs ${before}`);

  console.log('\n--- 8. Validasi nomor tujuan ---');
  const badNum = await call('POST', '/transactions', {
    token, body: { brand: 'DANA', nominal: 10000, targetNumber: '02112345678' },
  });
  check('prefix non-seluler ditolak 400', badNum.status === 400, JSON.stringify(badNum.json?.error));
  check('kode UNKNOWN_OPERATOR_PREFIX',
    badNum.json?.error?.code === 'UNKNOWN_OPERATOR_PREFIX');

  const badNominal = await call('POST', '/transactions', {
    token, body: { brand: 'DANA', nominal: 12345, targetNumber: '081234567891' },
  });
  check('nominal tidak ada di katalog ditolak 404', badNominal.status === 404);

  console.log('\n--- 9. Cooldown nomor tujuan ---');
  const cooldown = await call('POST', '/transactions', {
    token, body: { brand: 'DANA', nominal: 20000, targetNumber: '081234567890' },
  });
  check('kirim ulang ke nomor sama ditahan 429', cooldown.status === 429,
    `status=${cooldown.status}`);
  check('kode TARGET_COOLDOWN', cooldown.json?.error?.code === 'TARGET_COOLDOWN');

  console.log('\n--- 10. Transaksi pending & worker rekonsiliasi ---');
  const pend = await call('POST', '/transactions', {
    token, body: { brand: 'SHOPEEPAY', nominal: 25000, targetNumber: '081255551111' },
  });
  check('status awal PROCESSING', pend.json.data.status === 'PROCESSING',
    pend.json.data?.status);
  console.log('       menunggu worker (maks 150 detik, backoff 10s/20s/40s)...');

  let finalStatus = 'PROCESSING';
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const s = await call('GET', `/transactions/${pend.json.data.refId}`, { token });
    finalStatus = s.json.data.status;
    if (finalStatus !== 'PROCESSING') break;
  }
  check('worker menuntaskan jadi SUCCESS', finalStatus === 'SUCCESS', `status=${finalStatus}`);

  console.log('\n--- 11. Blokir nomor tujuan ---');
  await call('POST', '/admin/blocked-targets', {
    token: adminToken, body: { number: '0812-9999-8888', reason: 'uji blokir' },
  });
  const blocked = await call('POST', '/transactions', {
    token, body: { brand: 'DANA', nominal: 10000, targetNumber: '+6281299998888' },
  });
  check('nomor terblokir ditolak 403 (normalisasi format bekerja)',
    blocked.status === 403, `status=${blocked.status}`);

  console.log('\n--- 12. Audit ledger ---');
  const me = await call('GET', '/auth/me', { token });
  const audit = await call('GET', `/admin/balance/audit/${me.json.data.id}`, { token: adminToken });
  check('saldo tercatat cocok dengan hitung ulang ledger',
    audit.json.data.drift === 0, JSON.stringify(audit.json.data));

  const hist = await call('GET', '/balance/history?limit=50', { token });
  const types = hist.json.data.entries.map((e) => e.type);
  check('ledger memuat DEPOSIT, PURCHASE, dan REFUND',
    types.includes('DEPOSIT') && types.includes('PURCHASE') && types.includes('REFUND'),
    types.join(','));

  console.log('\n--- 13. Webhook tanpa signature ---');
  const hook = await fetch('http://127.0.0.1:3000/api/v1/webhooks/tokovoucher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref_id: okTx.json.data.refId, status: 'gagal' }),
  });
  check('callback tanpa signature ditolak 401', hook.status === 401, `status=${hook.status}`);
  const stillOk = await call('GET', `/transactions/${okTx.json.data.refId}`, { token });
  check('transaksi sukses tidak bisa diubah callback palsu',
    stillOk.json.data.status === 'SUCCESS', stillOk.json.data?.status);

  console.log(`\n===== HASIL: ${pass} lulus, ${fail} gagal =====\n`);
  process.exit(fail > 0 ? 1 : 0);
};

run().catch((e) => { console.error('ERROR:', e); process.exit(1); });
