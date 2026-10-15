# Swipe Photo

Sortir ribuan foto lokal dengan cepat pakai keyboard — langsung dari browser, tanpa framework dan tanpa dependency.

Isi path folder sumber, folder **bagus**, dan folder **jelek**, lalu tinggal tekan panah: foto langsung dipindah (bukan disalin) ke folder yang dipilih.

## Menjalankan

Butuh Node.js 18+ (tanpa `npm install`).

```bash
node server.js
```

Browser terbuka otomatis di `http://localhost:4321`.

| Variabel env | Default | Keterangan |
|---|---|---|
| `PORT` | `4321` | Port server |
| `HOST` | `0.0.0.0` | Pakai `127.0.0.1` supaya hanya bisa diakses dari komputer ini |
| `NO_OPEN` | – | Isi `1` supaya browser tidak dibuka otomatis |

## Tombol

| Tombol | Aksi |
|---|---|
| `→` | Pindahkan ke folder **bagus** |
| `←` | Pindahkan ke folder **jelek** |
| `↓` | Lewati (file tetap di tempat) |
| `↑` / `⌘Z` | Undo — file dikembalikan ke folder asal |
| `Esc` | Kembali ke beranda / ganti folder |

## Fitur

- **Cepat**: pindah file berjalan di background, 6 foto berikutnya di-preload & di-decode lebih dulu.
- **Strip vertikal** di kiri berisi foto sebelum & sesudah beserta statusnya (thumbnail kecil buatan server).
- **HEIC** (foto iPhone) dikonversi ke JPEG dengan `sips` dan di-cache.
- **Scan subfolder** (opsional), urutan nama natural (`IMG_2` sebelum `IMG_10`).
- **Duplikat dilewati**: foto yang isinya identik dengan yang sudah ada di folder bagus/jelek, atau salinan ganda di folder sumber, hanya tampil sekali.
- **Lanjut dari posisi terakhir** setelah reload.
- Nama bentrok di folder tujuan otomatis jadi `nama (1).jpg`; pindah antar-disk tetap aman (copy + hapus).

Format: JPG, PNG, WebP, GIF, AVIF, BMP, HEIC/HEIF.

## Catatan

- Konversi HEIC dan thumbnail memakai `sips`, jadi butuh **macOS**.
- Secara default server listen di `0.0.0.0` sehingga bisa dibuka dari perangkat lain di jaringan yang sama. Tidak ada autentikasi — siapa pun di jaringan itu bisa memindahkan file. Di jaringan yang tidak dipercaya, jalankan dengan `HOST=127.0.0.1 node server.js`.
