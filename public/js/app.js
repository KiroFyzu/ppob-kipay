/* ===========================================================================
   Peningkatan progresif.

   Setiap fungsi di sini hanya mempercepat hal yang SUDAH bisa dilakukan tanpa
   JavaScript: memilih brand tetap berjalan lewat tautan biasa, dan halaman
   status tetap menyegarkan diri lewat meta refresh. Kalau file ini gagal
   dimuat, situs tetap berfungsi penuh.
   =========================================================================== */

(function () {
  'use strict';

  /**
   * Memilih brand tanpa memuat ulang seluruh halaman.
   * Katalog diambil dari endpoint publik yang sama dengan yang dipakai API.
   */
  function setupBrandPicker() {
    var form = document.getElementById('form-topup');
    if (!form) return;

    var brandInput = document.getElementById('input-brand');
    var cards = form.querySelectorAll('.brand-card');
    var grid = form.querySelector('.nominal-grid');
    var scroll = form.querySelector('.nominal-scroll');
    if (!brandInput || !grid || !scroll) return;

    cards.forEach(function (card) {
      card.addEventListener('click', function (event) {
        var brand = card.getAttribute('data-brand');
        if (!brand) return;

        event.preventDefault();

        cards.forEach(function (c) {
          c.classList.remove('selected');
          c.setAttribute('aria-current', 'false');
        });
        card.classList.add('selected');
        card.setAttribute('aria-current', 'true');
        brandInput.value = brand;

        // URL ikut diperbarui supaya tombol kembali dan muat ulang tetap
        // menampilkan brand yang sama.
        window.history.replaceState({}, '', '/?brand=' + encodeURIComponent(brand));

        grid.setAttribute('aria-busy', 'true');

        fetch('/api/v1/products?brand=' + encodeURIComponent(brand), {
          headers: { Accept: 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Gagal memuat produk');
            return res.json();
          })
          .then(function (payload) {
            renderNominals(grid, payload.data.products);
            scroll.scrollTop = 0;
          })
          .catch(function () {
            // Kalau permintaan gagal, kembalikan ke perilaku dasar: muat ulang
            // halaman dengan brand yang dipilih.
            window.location.href = '/?brand=' + encodeURIComponent(brand);
          })
          .finally(function () {
            grid.removeAttribute('aria-busy');
          });
      });
    });
  }

  function formatRupiah(value) {
    return 'Rp' + Number(value).toLocaleString('id-ID');
  }

  /**
   * Node dibangun lewat DOM API, bukan innerHTML dengan string gabungan.
   * Data ini berasal dari katalog kita sendiri, tapi membangun HTML dari
   * string adalah kebiasaan yang cepat berubah menjadi celah XSS begitu
   * sumber datanya bertambah.
   */
  function renderNominals(grid, products) {
    grid.textContent = '';

    products.forEach(function (product) {
      var label = document.createElement('label');
      label.className = 'nominal-card';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'nominal';
      input.value = String(product.nominal);

      var inner = document.createElement('span');
      inner.className = 'nominal-inner';

      var value = document.createElement('span');
      value.className = 'nominal-value';
      value.textContent = formatRupiah(product.nominal);

      var price = document.createElement('span');
      price.className = 'nominal-price';
      price.textContent = formatRupiah(product.price);

      inner.appendChild(value);
      inner.appendChild(price);
      label.appendChild(input);
      label.appendChild(inner);
      grid.appendChild(label);
    });
  }

  /** Tombol nominal cepat di halaman saldo. */
  function setupQuickAmounts() {
    var input = document.getElementById('input-amount');
    if (!input) return;

    document.querySelectorAll('.chip-btn[data-amount]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        input.value = btn.getAttribute('data-amount') || '';
        input.focus();
      });
    });
  }

  /**
   * Mencegah kiriman ganda saat koneksi lambat. Ini murni kenyamanan --
   * pengaman sebenarnya ada di server (idempotency key dan cooldown nomor
   * tujuan), karena tombol yang dinonaktifkan tidak menghentikan siapa pun
   * yang mengirim request langsung.
   */
  function setupSubmitGuard() {
    document.querySelectorAll('form').forEach(function (form) {
      form.addEventListener('submit', function () {
        var button = form.querySelector('button[type="submit"]');
        if (!button) return;
        setTimeout(function () {
          button.disabled = true;
          button.textContent = 'Memproses...';
        }, 0);
      });
    });
  }

  setupBrandPicker();
  setupQuickAmounts();
  setupSubmitGuard();
})();
