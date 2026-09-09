# Arnel Bot v2

Versi ringan berbasis Baileys 7. Tidak memakai Chromium atau Puppeteer.

## Menjalankan bot dan dashboard

`npm start` sekarang menjalankan **dashboard dan bot WhatsApp bersama**.
`npm run dashboard` adalah alias yang sama; jangan jalankan keduanya bersamaan.
`npm run bot` hanya menjalankan bot, tanpa dashboard.

Untuk memperbarui instalasi Debian yang sudah memakai branch ini, hentikan proses lama
(Ctrl+C), lalu:

```bash
cd ~/arnel-bot
git pull --ff-only origin feat/natural-chat
npm install
npm run check
npm test
npm start
```

Buka **http://localhost:3000** dari browser di komputer tempat bot berjalan.
Alamat dan port bisa diatur lewat `DASHBOARD_HOST` dan `DASHBOARD_PORT` di `.env`.
Default host `127.0.0.1` untuk akses lokal; jika sengaja memakai perangkat lain di LAN,
atur host `0.0.0.0` dan akses IP komputer bot. Dashboard LAN tidak punya autentikasi;
gunakan hanya pada jaringan yang dipercaya, jangan diekspos ke internet.
Jika port sudah dipakai, hentikan proses dashboard lama atau pilih port lain.

Untuk instalasi baru, siapkan `.env` dari `.env.example`, isi konfigurasi, lalu `npm install`.
Gunakan Node.js 20 (sama seperti Dockerfile); dependency SQLite memerlukan binary native.
Scan QR di terminal jika sesi WhatsApp belum tertaut.

### Data yang dipakai bersama

Dashboard dan bot memakai `data/arnel.sqlite3` untuk riwayat, training, memory, dan hubungan.
Saat pertama menjalankan versi gabungan, data JSON di folder `DATA_DIR` yang sama diimpor
sekali. Jika sudah ada SQLite dari dashboard lama, perubahan JSON yang lebih baru daripada
migrasi sebelumnya digabung tanpa menimpa state SQLite yang lebih baru. File JSON asli
**tetap disimpan**. Setelah itu, gunakan versi gabungan ini agar penulisan data tetap ke SQLite.
Jangan hapus folder `data` atau menyalin `.env.example` di atas `.env` saat upgrade.

Contoh gaya, aturan pemilik, dan catatan cerita tetap menggunakan file pendamping JSON
sehingga impor gaya lama dan fitur natural-chat tetap aktif. Jumlah contoh gaya dan pasangan
konteks terlihat di dashboard. Tombol **Teach** memperbaiki balasan yang dipilih di riwayat
serta menyimpan contoh koreksinya untuk prompt bot.

Untuk membuka dashboard tanpa menjalankan WhatsApp:

```bash
npm run dashboard -- --dashboard-only
```

## Chat duluan

Aktifkan scheduler melalui `.env`:

```env
PROACTIVE_ENABLED=true
PROACTIVE_TIMES=08:00,12:30,19:30
PROACTIVE_DAILY_MAX=5
```

Bot juga akan memilih waktu acak dan mengirim pesan setelah percakapan sepi 2-4 jam.
`ALLOWED_NUMBER` wajib diisi karena nomor tersebut menjadi tujuan chat inisiatif.

## Foto

Foto masuk hingga 5 MB dianalisis dengan Gemini. Arnel memberi satu reaction emoji
dan membalas dengan teks pendek berdasarkan isi foto. Foto tanpa caption tetap diproses.

## Trainer dan perkembangan hubungan

Nomor yang tercantum di `ALLOWED_NUMBER` dapat memberi feedback langsung melalui WhatsApp:

- `!good` menyimpan pasangan pesan dan balasan terakhir sebagai contoh yang disukai.
- `!teach jawaban yang diinginkan` mengganti balasan terakhir di riwayat dan menyimpannya sebagai contoh koreksi.
- `!atur aturan gaya` menyimpan aturan permanen agar tidak perlu melatih kesalahan yang sama satu per satu.
- `!aturan` menampilkan aturan yang sedang dipakai Arnel.

Contoh aturan:

```text
!atur jangan pura pura salah paham kalau konteksnya udh jelas
!atur kalau gw chat singkat jangan jadi defensif atau kebanyakan bubble
```

Contoh:

```text
user: !teach ohh sama rian main apaan
arnel: nah gitu ya
arnel: gw inget
```

Contoh latihan, tingkat kedekatan, mood, dan kebiasaan panjang chat disimpan di
`data/arnel.sqlite3`. Database tidak masuk Git karena folder `data` diabaikan. Mood bergeser perlahan tiap sekitar 12–20 interaksi, bukan berubah
acak di setiap pesan. Arnel memilih hingga enam contoh paling relevan untuk membantu membentuk balasan baru.

## Respons natural dan contoh percakapan

Arnel memakai contoh impor sebagai referensi cara merespons, bukan fakta tentang user.
Prompt memprioritaskan koreksi `!teach` dan aturan pemilik, kemudian gaya chat impor.
Balasan tidak wajib ditutup pertanyaan, tidak boleh menebak kegiatan/perasaan user sebagai
fakta, dan harus menerima koreksi. Permintaan cerita tetap boleh dijawab panjang.
Riwayat beberapa balasan terakhir membantu menghindari pola bertanya terus.

## Import gaya chat

File `data/style_examples.json` lama tetap terbaca tanpa konversi dan tanpa dihapus.
Agar referensinya memuat **pesan sebelumnya + respons teman**, impor ulang export asli
WhatsApp atau Instagram. Potongan jawaban lama tidak bisa direkonstruksi menjadi pasangan
percakapan tanpa file aslinya.

```bash
npm run import-style -- --append "/home/mikoto/Downloads/message_1.json" "Nama Lawan Chat"
STYLE_IMPORT_LIMIT=800 npm run import-style -- --append "/home/mikoto/Downloads/message_1 (copy 1).json" "Nama Teman Pertama"
STYLE_IMPORT_LIMIT=800 npm run import-style -- --append "/home/mikoto/Downloads/message_1 (copy 2).json" "Nama Teman Kedua"
```

- Defaultnya menambahkan contoh, sama seperti `--append`; contoh teman sebelumnya tetap ada.
- `STYLE_IMPORT_LIMIT` mengatur jumlah contoh dari impor ini (default 800, rentang 1–5000).
  Total gabungan dibatasi 5000. Jika melebihi batas, impor berhenti tanpa mengubah data lama.
- `--replace` hanya jika sengaja ingin mengganti semua contoh. Impor ulang yang sama tidak
  menambah duplikat pasangan pesan dan jawaban.
- Bubble berurutan dari orang yang sama digabung. Pesan balasan hanya dipasangkan jika
  berjarak maksimal dua jam. Media/pesan sistem dan batas antarfile memutus konteks agar
  tidak membuat pasangan palsu. WhatsApp memakai tanggal hari/bulan/tahun.
- Contoh dipilih berdasarkan pesan yang ditanggapi, kecocokan jenis percakapan dan
  variasi respons. Contoh lama tanpa pasangan masih menjadi referensi ritme bahasa.

Hanya sedikit contoh terpilih yang masuk ke tiap permintaan Gemini; bukan seluruh export.
Jangan masukkan export pribadi, `.env`, atau folder `data` ke GitHub.

## Verifikasi perubahan

```bash
npm run check
npm test
```

Tes berjalan offline memakai percakapan buatan, tanpa menghubungkan WhatsApp atau memanggil
Gemini. Tes dashboard memakai server HTTP lokal, database sementara dan memeriksa migrasi,
riwayat, memory serta training. Tes memeriksa parsing, append, format lama, pemilihan contoh dan penyusunan prompt;
kealamian jawaban model tetap perlu dicoba dengan obrolan nyata di perangkat pemilik.

## Kelanjutan cerita Arnel

Saat Arnel menceritakan kegiatan, rencana, atau kejadian dirinya, bot menyimpan ringkasan teksnya
di `data/arnel_story_notes.json`. Catatan ini dipakai hanya untuk menjaga cerita Arnel tetap
konsisten pada chat berikutnya dan tidak menyalin isi chat user sebagai cerita Arnel.

## Memori pribadi

Pemilik bot yang nomornya ada di `ALLOWED_NUMBER` dapat menyimpan memori secara sengaja:

```text
!ingat suka cookies
!ingat lagi nyiapin ujian ekonomi
!ingatan
```

`!ingat` menyimpan catatan di `data/arnel.sqlite3`; `!ingatan` menampilkan hingga sepuluh
catatan terakhir. Memori dikirim ke Gemini hanya untuk membantu balasan dan pesan inisiatif yang
relevan. Jangan simpan kata sandi, token, alamat lengkap, atau informasi sangat sensitif.
