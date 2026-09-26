# Arnel Bot v3

Rewrite ringan Arnel Bot untuk Debian: Node.js 20+, Baileys 7, Gemini REST. Satu proses saja memakai direktori data yang sama. Karakter Arnel adalah fiksi; bot tidak mengklaim manusia nyata saat ditanya langsung. Tidak ada dashboard atau server HTTP dalam v3.

## Mulai di Debian

```bash
sudo apt update
sudo apt install -y nodejs npm
node --version                       # pastikan v20 atau lebih baru
cd ~/arnel-bot
test -f .env || cp .env.example .env
nano .env
npm install
npm run check
npm start
```

Paket Debian yang memberi Node di bawah v20 perlu diganti dengan Node 20+ terlebih dahulu; lihat [instruksi nvm resmi](https://github.com/nvm-sh/nvm#install--update-script). Jika memakai nvm, instal dan jalankan PM2 dari user yang sama agar PATH saat boot mengarah ke versi Node yang benar.

Isi `GEMINI_API_KEY`, `GEMINI_MODEL` yang tersedia pada akunmu, dan `ALLOWED_NUMBER` dalam format `628...` di `.env`. Untuk QR awal biarkan `CONNECTION_ONLY=true`; scan dari WhatsApp > Perangkat tertaut. Setelah terhubung, hentikan Ctrl+C, ubah ke `false`, lalu jalankan lagi. `ALLOWED_NUMBER` wajib saat bot aktif; bot hanya memproses chat pribadi nomor ini. Bila JID akun WhatsApp menggunakan LID, Baileys perlu menyediakan `remoteJidAlt`/mapping nomor; uji dulu dengan nomor yang diizinkan. Simpan `.env` dan `data/` secara privat. Jangan jalankan v2 dan v3 dengan sesi auth yang sama secara bersamaan.

Gemini diakses melalui `generateContent` dengan header `x-goog-api-key`; model, suhu, timeout, dan jumlah token dapat diubah lewat `.env`. Retry berlaku pada timeout, masalah jaringan, HTTP 408/429/5xx. HTTP 400/401/403 dan respons yang diblokir tidak diulang otomatis. Foto dan sticker didekripsi di memori lalu dikirim langsung sebagai `inlineData` ke Gemini (maksimum 5 MB); tidak ada unggahan media ke penyimpanan eksternal. Sticker animasi dapat ditafsirkan sebagai satu frame, bergantung dukungan model terhadap WebP. Bot tidak mengirim emoji, termasuk untuk reaction.

## Proses terus berjalan dengan pm2

```bash
npm install -g pm2
cd ~/arnel-bot-v3
pm2 start ecosystem.config.cjs
pm2 logs arnel-v3
pm2 save
pm2 startup
```

Jalankan perintah `sudo ...` yang dicetak oleh `pm2 startup`, lalu `pm2 save` lagi. Gunakan user Linux yang sama untuk PM2, `.env`, dan `data/`. `pm2 restart arnel-v3 --update-env` setelah mengubah `.env`. Pada logout 401, proses keluar dengan kode 10 dan konfigurasi PM2 menghentikan restart; backup `data/`, hapus **hanya** `data/baileys_auth`, lalu `pm2 restart arnel-v3` untuk QR baru. Jangan hapus seluruh `data/`.

## Migrasi data v2

Jika checkout branch v3 **di direktori v2 yang sama**, hentikan bot v2, backup `data/`, lalu pindah branch. Chat, training, aturan, memori, relationship, style, scheduler, dan sesi Baileys tetap berada pada `data/`; catatan cerita lama otomatis dikonversi sekali saat startup. Life state baru dimulai pada startup pertama.

Jika v3 dipasang di direktori **terpisah**, hentikan v2 dan jalankan:

```bash
node scripts/migrate-v2.js ~/arnel-bot/data ./data
```

Importer migrasi menyalin chat, contoh training/gaya, aturan, memori, relationship, jadwal proactive, catatan cerita, dan session Baileys jika target belum ada. Ia tidak menimpa data target dan tidak mengubah v2. Backup kedua direktori sebelum migrasi. Life state v3 mulai dari tanggal pertama dijalankan; gunakan `!life stage` bila fase sudah lebih maju. Session lama mungkin tetap butuh QR baru karena perubahan library/WhatsApp.

## Trainer (dikirim dari nomor `ALLOWED_NUMBER`)

| Perintah | Fungsi |
| --- | --- |
| `!good` | Simpan pasangan pesan/jawaban terakhir sebagai contoh bagus |
| `!teach jawaban baru` | Simpan koreksi dan ubah jawaban terakhir dalam histori lokal |
| `!atur aturan gaya` / `!aturan` | Tambah / lihat aturan gaya persisten |
| `!ingat fakta` / `!ingatan` | Tambah / lihat memori tentang lawan bicara |
| `!life status` | Lihat fase dan kejadian hidup Arnel |
| `!life stage awaiting` | Pindah fase dan atur ulang tanggal mulai fase |
| `!life stage accepted diterima UI` | Pindah fase dengan catatan dalam riwayat transisi |
| `!life event hasil tryout hari ini naik` | Tambah kejadian kecil (aktif 21 hari) |
| `!help` | Lihat ringkasan |

Fase tersedia: `preparation`, `awaiting`, `accepted`, `rejected`, `med_student`, `reapplying`. Otomatis setelah 120 hari persiapan → menunggu; setelah 35 hari menunggu → hasil (`accepted` atau `rejected`, dipilih secara deterministik dari seed yang tersimpan); 90 hari kemudian → mahasiswa awal atau persiapan ulang. Ini alur fiksi, bukan prediksi penerimaan yang nyata. Transisi manual mereset hitungan dan membuang kejadian fase lama. Untuk hasil yang kamu tentukan sendiri, kirim `!life stage accepted` atau `!life stage rejected` sebelum transisi otomatis. Peristiwa kecil dibuat paling cepat sekitar 6–9 hari dan habis setelah 18 hari; hasil tryout dan hal yang mengubah jalan hidup sebaiknya diatur manual agar sesuai cerita yang kamu inginkan.

Setiap permintaan Gemini mendapat prompt yang dirakit dari identitas inti di `persona.js`, fase dan kejadian aktif dari `life_state.json`, story thread yang masih berlaku, mood/relationship, aturan, memori, serta contoh training dan style. `story_threads.json` menyimpan cerita diri yang sudah benar-benar terkirim, memudar setelah 30 hari dan hanya dipakai pada fase yang sama. `life_state.json` mengalahkan detail cerita lama yang bertentangan. Komponen ini disimpan setelah tiap perubahan sehingga shutdown tidak kehilangan state. Prompt mengurangi gaya asisten dan satu kali regenerasi dilakukan bila balasan memakai frasa generik terlarang. Kualitas bahasa tetap bergantung pada model dan contoh yang diimpor.

## Import contoh gaya

File WhatsApp `.txt` atau Instagram `message_1.json`; nama argumen terakhir harus sama dengan nama pengirim yang ingin diambil. Beberapa file dapat digabung. `--append` mempertahankan data sebelumnya.

```bash
npm run import-style -- "/home/mikoto/Downloads/chat.txt" "Nama Pengirim"
npm run import-style -- --append "/home/mikoto/Downloads/message_1.json" "/home/mikoto/Downloads/message_2.json" "Nama Pengirim"
STYLE_IMPORT_LIMIT=800 npm run import-style -- --append "message_1.json" "Nama Pengirim"
```

Importer menyimpan contoh respons beserta pesan sebelumnya bila ada; seleksi mencampur 40% contoh tersebar dari masa lama dan 60% contoh terbaru. Jangan masukkan rahasia atau chat orang lain tanpa izin. Style dipakai sebagai acuan ritme, bukan fakta atau identitas karakter.

## Konfigurasi dan file

| File | Tugas |
| --- | --- |
| `src/index.js`, `config.js`, `logger.js` | Wiring proses, validasi `.env`, logging terstruktur |
| `src/whatsapp.js` | Session Baileys, QR, reconnect, filter chat, dekripsi media |
| `src/bot.js`, `gemini.js` | Debounce, antrean per chat, prompt/request Gemini, pengiriman bubble |
| `src/persona.js`, `style.js` | Identitas inti, aturan no slop, contoh gaya |
| `src/life.js`, `story.js` | Fase hidup, kejadian kecil, kontinuitas cerita |
| `src/storage.js`, `memory.js`, `relationship.js` | JSON atomik, histori, feedback, mood dan kebiasaan |
| `src/trainer.js`, `scheduler.js` | Command pemilik dan chat duluan |
| `scripts/import-style.js`, `scripts/migrate-v2.js` | Import gaya dan migrasi v2 |

`PROACTIVE_ENABLED=true` menghidupkan jadwal `PROACTIVE_TIMES` serta waktu acak atau saat lama sepi. Batas harian, jeda, dan aktivitas terakhir mencegah spam. Zona waktu memakai `TZ=Asia/Jakarta`. `CONNECTION_ONLY=true` tidak membutuhkan API key dan tidak membalas pesan. `LOG_LEVEL=info` mencatat status dan error tanpa isi chat atau key. State dalam `data/` disimpan via rename atomik; backup berkala tetap disarankan. **Jalankan hanya satu instance PM2** untuk satu `DATA_DIR` karena JSON store tidak dirancang untuk beberapa penulis.
