# EstafAgen — Frontend (Ronde 3)

Halaman statis, tanpa framework/build step. `ethers` v6 dimuat dari CDN
(pinned 6.17.0, sama dengan versi di `node_modules`).

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
  (mode tamu) lewat public RPC chain yang dipilih.
- **Direktori:** ditemukan HANYA dari event `ProfilePublished` — entri
  yang diterbitkan sendiri oleh holder (opt-in). Tidak ada lookup
  nama→alamat untuk holder yang tidak mempublikasikan diri. Nama `.ai`
  di profil adalah deklarasi sendiri; alamat selalu ditampilkan.
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

## Ronde 4 (testnet) akan mengisi

- `config.js`: alamat EstafAgen + mock registry di chain 97.
- Deploy script dengan assert chainId (97 → mock, 56 → resmi).
