/**
 * Uji alur halaman web dari ujung ke ujung.
 *
 * Berbeda dari scripts/smoke-test.mjs yang menguji API JSON, berkas ini
 * menguji lapisan yang dilihat pengguna: form, cookie sesi, perlindungan CSRF,
 * pengalihan halaman terlindungi, dan isi HTML yang dirender.
 *
 * Jalankan dengan server sudah menyala:
 *   ADMIN_PASS='...' node scripts/web-smoke-test.mjs
 */

const BASE = 'http://127.0.0.1:3000';
let pass = 0;
let fail = 0;

function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

/** Wadah cookie sederhana, karena fetch bawaan Node tidak menyimpan cookie. */
function createJar() {
  const cookies = new Map();

  return {
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    get(name) {
      return cookies.get(name);
    },
  };
}

function client() {
  const jar = createJar();

  async function req(method, path, { form, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: {
        Cookie: jar.header(),
        Accept: 'text/html',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    jar.absorb(res);
    const body = await res.text();
    return { status: res.status, location: res.headers.get('location'), body, jar };
  }

  return {
    jar,
    get: (path, opts) => req('GET', path, opts),
    post: (path, form, opts) => req('POST', path, { form, ...opts }),
    /** Mengambil token CSRF dari halaman, seperti yang dilakukan browser. */
    async csrf(path = '/') {
      await req('GET', path);
      return jar.get('csrf_token');
    },
  };
}

const run = async () => {
  const stamp = Date.now();
  const email = `web${stamp}@test.local`;

  // Nomor tujuan dibuat unik tiap kali tes dijalankan. Kalau statis, run kedua
  // menabrak batas harian per nomor tujuan di fraud.service.ts -- dan tes yang
  // hanya lulus sekali sehari tidak ada gunanya.
  const suffix = String(stamp).slice(-6);
  const targetSuccess = `0813${suffix}88`;
  const targetPending = `0813${suffix}111`;
  const targetBlocked = `0812${suffix}44`;
  const maskOf = (n) => `${n.slice(0, 4)}****${n.slice(-4)}`;

  const user = client();

  console.log('\n--- 1. Halaman publik ---');
  const home = await user.get('/');
  check('beranda = 200', home.status === 200);
  check('menampilkan keempat brand',
    ['DANA', 'OVO', 'GoPay', 'ShopeePay'].every((b) => home.body.includes(b)));
  check('menampilkan pilihan nominal', home.body.includes('nominal-card'));
  check('tamu diarahkan untuk masuk', home.body.includes('Masuk untuk melanjutkan'));
  check('cookie CSRF diterbitkan', Boolean(user.jar.get('csrf_token')));

  const brandFilter = await user.get('/?brand=SHOPEEPAY');
  check('filter brand lewat query param bekerja',
    brandFilter.body.includes('aria-current="true"') && brandFilter.status === 200);

  console.log('\n--- 2. Halaman terlindungi mengalihkan ke login ---');
  const guarded = await user.get('/dasbor');
  check('/dasbor tanpa sesi = 302', guarded.status === 302, `status=${guarded.status}`);
  check('dialihkan ke /masuk dengan tujuan kembali',
    guarded.location?.startsWith('/masuk?next='), guarded.location ?? '');

  console.log('\n--- 3. Perlindungan CSRF ---');
  const csrf = await user.csrf('/daftar');
  const noCsrf = await user.post('/daftar', {
    name: 'Tanpa CSRF', email: `x${stamp}@t.local`, password: 'password123',
  });
  check('form tanpa token CSRF ditolak 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  const wrongCsrf = await user.post('/daftar', {
    _csrf: 'a'.repeat(64),
    name: 'CSRF Salah', email: `y${stamp}@t.local`, password: 'password123',
  });
  check('token CSRF salah ditolak 403', wrongCsrf.status === 403, `status=${wrongCsrf.status}`);

  console.log('\n--- 4. Daftar dan masuk ---');
  const reg = await user.post('/daftar', {
    _csrf: csrf, name: 'Pengguna Uji', email, password: 'password123',
  });
  check('daftar berhasil = 302', reg.status === 302, `status=${reg.status}`);
  check('dialihkan ke dasbor', reg.location === '/dasbor', reg.location ?? '');
  check('cookie sesi diberikan', Boolean(user.jar.get('session')));

  const dash = await user.get('/dasbor');
  check('dasbor = 200', dash.status === 200);
  check('menyapa dengan nama pengguna', dash.body.includes('Pengguna Uji'));
  check('menampilkan saldo Rp0', dash.body.includes('Rp0'));

  const weakPass = await user.post('/daftar', {
    _csrf: csrf, name: 'Lemah', email: `z${stamp}@t.local`, password: 'abc',
  });
  check('password pendek ditolak 400', weakPass.status === 400, `status=${weakPass.status}`);
  check('pesan kesalahan ditampilkan di form',
    weakPass.body.includes('Minimal 8 karakter') || weakPass.body.includes('minimal 8 karakter'));

  console.log('\n--- 5. Topup tanpa saldo ---');
  const poor = await user.post('/topup', {
    _csrf: csrf, brand: 'DANA', nominal: '10000', targetNumber: targetSuccess,
  });
  check('ditolak 400', poor.status === 400, `status=${poor.status}`);
  check('form dirender ulang dengan pesan saldo kurang',
    poor.body.includes('Saldo tidak mencukupi'), '');
  check('nomor tujuan tetap terisi', poor.body.includes(targetSuccess));

  console.log('\n--- 6. Deposit dan konfirmasi admin ---');
  const dep = await user.post('/saldo/deposit', {
    _csrf: csrf, amount: '300000', method: 'MANUAL_TRANSFER',
  });
  check('tagihan deposit dibuat = 302', dep.status === 302, `status=${dep.status}`);
  const invoiceId = dep.location?.split('/').pop() ?? '';
  check('dialihkan ke halaman tagihan', invoiceId.startsWith('INV'), dep.location ?? '');

  const invoice = await user.get(`/saldo/deposit/${invoiceId}`);
  check('halaman tagihan = 200', invoice.status === 200);
  check('menampilkan instruksi nominal unik',
    invoice.body.includes('Transfer tepat sejumlah'));
  check('menyegarkan diri selama menunggu',
    invoice.body.includes('http-equiv="refresh"'));

  const admin = client();
  const adminCsrf = await admin.csrf('/masuk');
  const adminLogin = await admin.post('/masuk', {
    _csrf: adminCsrf, email: 'admin@ppob.local', password: process.env.ADMIN_PASS,
  });
  check('admin berhasil masuk', adminLogin.status === 302, `status=${adminLogin.status}`);

  const adminPage = await admin.get('/admin');
  check('panel admin = 200', adminPage.status === 200, `status=${adminPage.status}`);
  check('tagihan menunggu muncul di panel', adminPage.body.includes(invoiceId));

  const forbidden = await user.get('/admin');
  check('pengguna biasa ditolak dari /admin 403', forbidden.status === 403,
    `status=${forbidden.status}`);

  const confirm = await admin.post(`/admin/deposit/${invoiceId}/konfirmasi`, {
    _csrf: adminCsrf,
  });
  check('admin mengonfirmasi deposit = 302', confirm.status === 302, `status=${confirm.status}`);

  const saldo = await user.get('/saldo');
  check('saldo bertambah menjadi Rp300.000', saldo.body.includes('Rp300.000'));
  check('mutasi deposit tercatat', saldo.body.includes('Deposit saldo'));

  console.log('\n--- 7. Topup berhasil ---');
  const topup = await user.post('/topup', {
    _csrf: csrf, brand: 'DANA', nominal: '25000', targetNumber: targetSuccess,
  });
  check('topup dibuat = 302', topup.status === 302, `status=${topup.status}`);
  const refId = topup.location?.split('/').pop() ?? '';
  check('dialihkan ke halaman struk', refId.startsWith('TRX'), topup.location ?? '');

  const receipt = await user.get(`/transaksi/${refId}`);
  check('halaman struk = 200', receipt.status === 200);
  check('status tampil Berhasil', receipt.body.includes('Berhasil'));
  check('nomor tujuan disamarkan', receipt.body.includes(maskOf(targetSuccess)), maskOf(targetSuccess));
  check('tidak menyegarkan diri saat sudah final',
    !receipt.body.includes('http-equiv="refresh"'));

  const list = await user.get('/transaksi');
  check('riwayat memuat transaksi', list.body.includes(refId));

  const filtered = await user.get('/transaksi?status=SUCCESS');
  check('filter status bekerja', filtered.status === 200 && filtered.body.includes(refId));

  console.log('\n--- 8. Transaksi pending menyegarkan diri ---');
  const pending = await user.post('/topup', {
    _csrf: csrf, brand: 'OVO', nominal: '20000', targetNumber: targetPending,
  });
  const pendingRef = pending.location?.split('/').pop() ?? '';
  const pendingPage = await user.get(`/transaksi/${pendingRef}`);
  check('status tampil Diproses', pendingPage.body.includes('Diproses'),
    `status=${pendingPage.status}`);
  check('halaman menyegarkan diri otomatis',
    pendingPage.body.includes('http-equiv="refresh"'));

  console.log('\n--- 9. Blokir nomor lewat panel admin ---');
  const blocked = await admin.post('/admin/blokir', {
    _csrf: adminCsrf, number: targetBlocked, reason: 'uji blokir web',
  });
  check('nomor diblokir = 302', blocked.status === 302, `status=${blocked.status}`);

  const blockedTopup = await user.post('/topup', {
    _csrf: csrf, brand: 'DANA', nominal: '10000', targetNumber: '+62' + targetBlocked.slice(1),
  });
  check('topup ke nomor terblokir ditolak 400', blockedTopup.status === 400,
    `status=${blockedTopup.status}`);
  check('pesan penolakan muncul di form',
    blockedTopup.body.includes('tidak dapat digunakan'));

  console.log('\n--- 10. Keamanan pengalihan setelah login ---');
  const attacker = client();
  const aCsrf = await attacker.csrf('/masuk');
  const openRedirect = await attacker.post('/masuk', {
    _csrf: aCsrf, email, password: 'password123', next: 'https://situs-jahat.example',
  });
  check('tujuan kembali ke situs luar diabaikan',
    openRedirect.location === '/dasbor', openRedirect.location ?? '');

  console.log('\n--- 11. Keluar ---');
  const logout = await user.post('/keluar', { _csrf: csrf });
  check('keluar = 302', logout.status === 302, `status=${logout.status}`);
  const afterLogout = await user.get('/dasbor');
  check('sesi benar-benar berakhir', afterLogout.status === 302,
    `status=${afterLogout.status}`);

  console.log('\n--- 12. Halaman error ---');
  const missing = await user.get('/halaman-yang-tidak-ada');
  check('404 merender halaman HTML, bukan JSON', missing.status === 404 &&
    missing.body.includes('<!DOCTYPE html>'));
  check('menampilkan pesan yang bisa dibaca',
    missing.body.includes('tidak ada atau sudah dipindahkan'));

  const apiMissing = await fetch(`${BASE}/api/v1/tidak-ada`, {
    headers: { Accept: 'application/json' },
  });
  const apiBody = await apiMissing.json();
  check('jalur /api tetap membalas JSON', apiBody.success === false &&
    apiBody.error.code === 'ROUTE_NOT_FOUND');

  console.log(`\n===== HASIL WEB: ${pass} lulus, ${fail} gagal =====\n`);
  process.exit(fail > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
