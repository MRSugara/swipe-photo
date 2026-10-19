# Swipe Photo

Pilih foto-foto bagus dari ribuan foto lokal dengan cepat — pakai keyboard, mouse, atau geser (swipe), langsung dari browser. Tanpa framework dan tanpa dependency.

Klik **Pilih folder foto**, pilih folder di jendela yang muncul, lalu tinggal tekan panah: foto bagus langsung dipindah (bukan disalin) ke folder `Bagus` yang otomatis dibuat di dalam folder itu. Foto lain tetap di tempatnya.

## Menjalankan

Butuh [Node.js](https://nodejs.org) 18+ (tanpa `npm install`).

**Windows**: klik dua kali **`Swipe Photo.bat`**. Kalau Node.js belum terpasang, halaman download-nya dibuka otomatis. Biarkan jendela hitam terbuka selama memakai Swipe Photo; tutup jendela itu kalau sudah selesai. Klik dua kali lagi saat sudah berjalan cukup membuka browser.

**macOS / Linux**:

```bash
node server.js
```

Browser terbuka otomatis di `http://localhost:4321`.

| Variabel env | Default | Keterangan |
|---|---|---|
| `PORT` | `4321` | Port server |
| `HOST` | `0.0.0.0` | Pakai `127.0.0.1` supaya hanya bisa diakses dari komputer ini (launcher Windows sudah memakai ini) |
| `NO_OPEN` | – | Isi `1` supaya browser tidak dibuka otomatis |

## Proyek

Tiap folder foto yang pernah dibuka jadi satu **proyek** di beranda (misalnya `Project A`, `Project B`, `Project C`), lengkap dengan progres (belum dilihat / bagus) dan tombol **Lanjutkan**.

```
Project A/
├── IMG_001.jpg      ← dilewati / belum dilihat (tetap di sini)
├── IMG_001.CR2      ← RAW pasangan, ikut ke mana pun JPEG-nya pergi
└── Bagus/           ← dibuat otomatis saat mulai
    ├── IMG_002.jpg
    └── IMG_002.CR2
```

- Pilihan tiap foto (bagus / dilewati) disimpan di `~/.swipe-photo/decisions/`, daftar proyek di `~/.swipe-photo/projects.json`. Saat proyek dibuka lagi semua tanda tetap ada, foto bagus tampil lagi di urutan aslinya, dan pemilihan lanjut dari foto pertama yang belum dipilih.
- Tombol ✕ menghapus proyek dari daftar beserta catatan pilihannya. Foto dan folder tidak disentuh.
- Kalau dibuka dari perangkat lain (misalnya HP) atau jendela pilih folder gagal, yang muncul adalah daftar folder di dalam halaman sebagai gantinya.

## Cara memilih

| Tombol / gerakan | Aksi |
|---|---|
| `→` · geser foto ke kanan · dua jari ke kanan di trackpad | Pindahkan ke folder **Bagus** |
| `←` / `↓` · geser ke kiri · dua jari ke kiri | Lewati (file tetap di tempat) |
| `↑` / `⌘Z` / `Ctrl+Z` | Batalkan pilihan terakhir |
| `Spasi` · klik foto | Zoom 100% (ukuran asli) untuk cek fokus; scroll untuk zoom lebih jauh |
| `B` | Bandingkan foto beruntun (seri) berdampingan |
| `Esc` | Keluar dari zoom / kembali ke daftar proyek |
| `?` | Tampilkan cara pakai |

Semua aksi juga tersedia sebagai tombol di bawah foto.

- **Memilih ulang**: klik foto mana saja di daftar (kiri, atau bawah di HP) lalu pilih lagi. Foto bagus yang diganti jadi lewati otomatis dikembalikan ke tempat asalnya.
- **Filter**: tampilkan *Semua foto*, *Belum dipilih*, *Bagus saja* (untuk cek ulang hasil), atau *Dilewati saja*.
- **Seri foto**: foto di folder yang sama dengan jam ambil (EXIF) berjarak ≤ 2 detik dikelompokkan. Tekan `B`, tandai yang bagus (klik atau tombol `1`–`9`), lalu `Enter`; sisanya dilewati. Satu `↑` membatalkan seluruh seri.
- **Info foto** di bawah foto: tanggal ambil, resolusi, ukuran file, kamera, dan setelan (f, shutter, ISO, focal length). Tanda `~` berarti tanggal dari file karena EXIF tidak ada.

## Fitur

- **Cepat & ringan**: pindah file berjalan di background, 6 foto berikutnya di-preload. Daftar foto virtual — hanya kotak yang terlihat yang dibuat, jadi puluhan ribu foto tetap mulus. Info EXIF diambil bertahap di sekitar foto yang sedang dilihat.
- **RAW + JPEG berpasangan**: `.CR2`, `.CR3`, `.NEF`, `.ARW`, `.RAF`, `.ORF`, `.RW2`, `.DNG`, dll. serta sidecar `.xmp` dengan nama sama ikut dipindah bersama foto utamanya, dengan nama tujuan yang tetap serasi (`IMG_1 (1).jpg` + `IMG_1 (1).CR2`). Di macOS, RAW tanpa JPEG tetap bisa ditampilkan.
- **HEIC** (foto iPhone) dan RAW dikonversi ke JPEG dengan `sips` dan di-cache; zoom memakai versi ukuran asli.
- **Scan subfolder**, urutan nama natural (`IMG_2` sebelum `IMG_10`).
- **Duplikat dilewati**: foto yang isinya identik dengan yang sudah ada di folder Bagus, atau salinan ganda di folder sumber, hanya tampil sekali (dan tidak dihitung sebagai "belum dilihat").
- Pindah antar-disk tetap aman (copy + hapus, timestamp dipertahankan).

Format: JPG, PNG, WebP, GIF, AVIF, BMP, HEIC/HEIF (macOS), RAW (pasangan; ditampilkan di macOS).

## Tes

```bash
npm test        # atau: node --test
```

Menjalankan server dengan HOME sementara (data asli tidak tersentuh) dan menguji alur pindah/batalkan, pasangan RAW/XMP, nama bentrok, pilihan tersimpan, foto kembar, EXIF, keamanan path, dan hapus proyek.

## Catatan

- **macOS**: semua fitur. Kalau folder Desktop/Dokumen/Unduhan tidak bisa dibuka, beri izin akses untuk aplikasi terminal di System Settings → Privacy & Security → Files and Folders.
- **Windows**: jendela pilih folder (PowerShell) dan "Buka folder Bagus" (Explorer) tersedia. HEIC tidak didukung, RAW hanya ikut dipindah sebagai pasangan JPEG, dan thumbnail memakai foto asli (tanpa versi kecil), jadi folder berisi foto sangat besar terasa lebih berat.
- Secara default `node server.js` listen di `0.0.0.0` sehingga bisa dibuka dari perangkat lain di jaringan yang sama. Tidak ada autentikasi — siapa pun di jaringan itu bisa melihat daftar folder dan memindahkan file. Di jaringan yang tidak dipercaya, jalankan dengan `HOST=127.0.0.1 node server.js`.
