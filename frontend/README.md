# EstafAgen — Frontend (Ronde 3–4.6)

Halaman statis, tanpa framework/build step. `ethers` v6 dimuat dari CDN
(pinned 6.17.0, sama dengan versi di `node_modules`) dengan SRI + fallback
ke CDN kedua; bila keduanya gagal, halaman menampilkan pesan jelas
(bukan mati diam-diam).

## File

```
frontend/
  index.html      Struktur halaman (mobile-first, satu kolom)
  styles.css      Gaya
  config.js       Alamat kontrak per chain (97/56 diisi Ronde 4/5)
  estafagen.js    Client kontrak — dipakai UI DAN integration test (UMD)
  app.js          Wiring DOM (connect, direktori, profil, tugas, rantai)
  local-config.json  (dibuat oleh scripts/deploy-local.js — lokal saja,
                      JANGAN di-commit; hanya alamat localhost)
```

## Cara kerja

- **Konektor:** hanya `window.ethereum` (injected). Tanpa QR, tanpa
  WalletConnect. Tanpa wallet pun direktori + tugas tetap bisa dibaca
  (mode tamu) lewat public RPC chain yang dipilih — pembacaan selalu
  lewat public RPC, wallet hanya dipakai untuk signing.
- **Direktori:** ditemukan HANYA dari event `ProfilePublished` — entri
  yang diterbitkan sendiri oleh holder (opt-in). Pemindaian dimulai
  dari `deployedFromBlock` di `config.js` (bukan blok 0) dan hasilnya
  di-cache di memori per chain. Pencarian di-debounce ±300 ms.
  Tidak ada lookup nama→alamat untuk holder yang tidak
  mempublikasikan diri. Nama `.ai` di profil adalah deklarasi sendiri;
  alamat selalu ditampilkan.
- **Tugas akar tidak bisa diselesaikan:** tugas akar berstatus Open dan
  kontrak tidak punya jalur ke Completed untuknya (temuan Ronde 2).
  UI tidak menampilkan tombol "Selesai" pada tugas akar; yang
  diselesaikan adalah subtugas yang didelegasikan.
- **Status transaksi 4 tahap:** menyiapkan → menunggu konfirmasi wallet →
  menunggu jaringan → berhasil/gagal, + link explorer. Semua error
  berbahasa Indonesia, tanpa kode mentah (lihat `explainError()` di
  `estafagen.js`).

## Uji lokal (tanpa testnet, tanpa tBNB)

```bash
# 1. Uji integrasi end-to-end (node lokal + alur frontend):
node scripts/integration-test.js
#    Menyalakan `npx hardhat node` sendiri, deploy mock + EstafAgen,
#    lalu menjalankan alur: terbitkan profil -> cari di direktori ->
#    delegasikan -> terima -> selesaikan -> lihat rantai (+ jalur
#    tolak, multi-level, non-holder, hapus profil). Node dimatikan lagi.

# 2. Coba UI di browser terhadap node lokal:
#    Terminal A: npx hardhat node
#    Terminal B: node scripts/deploy-local.js   # tulis local-config.json
#    Terminal C: cd frontend && python3 -m http.server 8000
#    Buka http://localhost:8000, pilih "Hardhat lokal", hubungkan
#    wallet ke jaringan Hardhat (chain 31337). Akun lokal 0-2 sudah
#    diberi status holder oleh deploy-local.js.
```

## Ronde 4 (testnet) — selesai 22 Nov 2026

- `config.js`: chain 97 terisi — EstafAgen
  `0x0d3D7d28c3f553a8328F0B7e0AFd9F9D4E84D667`, mock registry
  `0x98b7f94587473f7290dAff8c1781f6C7aA3C2Ef0`, `deployedFromBlock`
  144092369 (blok deploy mock; EstafAgen di 144092375).
- Kedua kontrak Sourcify `exact_match`. Verifikasi native BscScan
  masih butuh API key Etherscan gratis (lihat README root).
- Deploy script dengan assert chainId (97 → mock, 56 → resmi):
  `scripts/deploy-testnet.js`.
