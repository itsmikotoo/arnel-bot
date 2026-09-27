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

Gemini diakses melalui `generateContent` dengan header `x-goog-api-key`; model, suhu, timeout, dan jumlah token dapat diubah lewat `.env`. `LIGHT_READING_CHANCE=0.035` memberi peluang kecil per balasan reaktif untuk memakai instruksi membaca nuansa pesan dengan lebih santai; nilai 0 mematikannya, rentang yang diterima 0–0.1. Ini tidak bergantung pada keyword user dan tidak mengubah fakta life state, cerita, atau memori. Koreksi user direspons menurut gaya saat itu tanpa frasa jawaban tetap. Retry berlaku pada timeout, masalah jaringan, HTTP 408/429/5xx. HTTP 400/401/403 dan respons yang diblokir tidak diulang otomatis. Foto dan sticker didekripsi di memori lalu dikirim langsung sebagai `inlineData` ke Gemini (maksimum 5 MB); tidak ada unggahan media ke penyimpanan eksternal. Sticker animasi dapat ditafsirkan sebagai satu frame, bergantung dukungan model terhadap WebP. Bot tidak mengirim emoji, termasuk untuk reaction.

## Foto referensi keluar

Opsional: dapatkan kunci API dari [Pexels API](https://www.pexels.com/api/) lalu isi `PEXELS_API_KEY=` di `.env` dan `pm2 restart arnel-v3 --update-env`. Bila kunci kosong, fitur gambar keluar mati dan chat teks tetap bekerja. Saat Gemini memutuskan foto nyata akan membantu (terutama permintaan contoh visual), ia menambahkan instruksi pencarian tersembunyi. Bot mencari melalui endpoint resmi Pexels, memeriksa kecocokan deskripsi hasil teratas, mengunduh foto dengan batas 5 MB, lalu mengirim gambar WhatsApp dengan kredit fotografer dan tautan sumber. Foto stok tidak selalu tersedia untuk makanan atau benda lokal yang sangat spesifik; jika tidak ada kecocokan, bot hanya mengirim teks dan tidak mengganti dengan gambar yang keliru. Bot tidak menganggap foto stok itu foto pribadi Arnel.

Pencarian gambar dibatasi terpisah dari Gemini: `IMAGE_SEARCH_DAILY_MAX=4` panggilan API per hari (termasuk retry), jarak minimal `IMAGE_SEARCH_MIN_GAP_MINUTES=120` antarpencarian, dan `IMAGE_SEARCH_TIMEOUT_MS=12000`. Penggunaan tersimpan di `data/image_search_limits.json` sehingga restart tidak menghapus kuota. Query bertema seksual/eksplisit atau orang ditolak, begitu juga foto dengan metadata bermasalah. Pexels menyediakan API gratis dengan batas bawaannya sendiri; pastikan penggunaanmu sesuai ketentuan serta atribusinya.

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
Periksa juga `LOG_LEVEL` di `.env` lama: ubah `silent` menjadi `info` agar status koneksi dan error terlihat di `pm2 logs`.

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
| `src/image-search.js` | Pencarian foto Pexels, pemeriksaan hasil, batas pemakaian, unduhan aman |
| `src/persona.js`, `style.js` | Identitas inti, aturan no slop, contoh gaya |
| `src/life.js`, `story.js` | Fase hidup, kejadian kecil, kontinuitas cerita |
| `src/storage.js`, `memory.js`, `relationship.js` | JSON atomik, histori, feedback, mood dan kebiasaan |
| `src/trainer.js`, `scheduler.js` | Command pemilik dan chat duluan |
| `scripts/import-style.js`, `scripts/migrate-v2.js` | Import gaya dan migrasi v2 |

`PROACTIVE_ENABLED=true` menghidupkan jadwal `PROACTIVE_TIMES` serta waktu acak atau saat lama sepi. Batas harian, jeda, dan aktivitas terakhir mencegah spam. Zona waktu memakai `TZ=Asia/Jakarta`. `CONNECTION_ONLY=true` tidak membutuhkan API key dan tidak membalas pesan. `LOG_LEVEL=info` mencatat status dan error tanpa isi chat atau key. State dalam `data/` disimpan via rename atomik; backup berkala tetap disarankan. **Jalankan hanya satu instance PM2** untuk satu `DATA_DIR` karena JSON store tidak dirancang untuk beberapa penulis.

### Proactive tanpa menumpuk

Setelah satu pesan proactive, scheduler menunggu balasan user apa pun (teks, foto, atau sticker yang didukung) sebelum boleh memulai lagi. Balasan tidak harus mengutip pesan tertentu. Status menunggu disimpan dalam `proactive_state.json`, tetap berlaku setelah restart dan pergantian hari; data lama diperiksa dari waktu proactive terakhir dan histori user. Pengiriman dengan hasil jaringan yang tidak pasti juga menunggu balasan agar tidak menggandakan pesan.

Gemini membuat isi secara dinamis dari persona, life state, mood, story threads dan waktu lokal (`TZ`). Tema tidak dibatasi pada masak atau belajar. Scheduler membandingkan dengan 30 pesan proactive terkirim terakhir serta 20 balasan terbaru di histori, termasuk saat upgrade. Jika terlalu mirip, Gemini diminta mengganti gagasan sekali; bila tetap mirip, pesan dilewati dan percobaan ditunda satu jam. Satu inisiatif dikirim sebagai satu bubble. Batas harian dan jeda lama tetap berlaku setelah user membalas; jadwal yang terlewat tidak dikirim sekaligus.

### Pesan beruntun dan variasi respons

Pesan teks dalam window `MESSAGE_DEBOUNCE_MS` (default 3500 ms setelah pesan terakhir) digabung berurutan, diberi penanda per pesan saat dikirim ke Gemini, dan disimpan utuh di histori. Variasi baca santai tidak aktif untuk gabungan beberapa pesan. Pesan yang datang setelah proses generasi dimulai masuk batch berikutnya, bukan menggantikan pesan yang sedang diproses. Log debug mencatat jumlah pesan per batch tanpa isi chat.

Filter gaya memeriksa penutup berulang berbentuk `tapi + saran/kondisi`, bukan hanya akhiran `sih`. Ia juga mendeteksi beberapa bentuk nasihat/caretaker yang berulang pada dua respons berdekatan dalam 30 menit dan meminta satu regenerasi dengan fungsi respons lain. Permintaan saran eksplisit tetap boleh dijawab dengan saran. Deteksi bahasa ini bersifat heuristik; contoh chat impor dan kualitas model tetap memengaruhi hasil.

Banter juga diarahkan agar Arnel tidak selalu mencari comeback atau memenangkan godaan. `src/banter.js` memeriksa pengulangan beberapa bentuk counter retoris, termasuk yang tanpa tanda tanya, serta perumpamaan dalam tiga balasan terakhir selama 30 menit. Counter beruntun atau analogi ketiga memicu satu regenerasi. Perbandingan yang diminta user dikecualikan. Pilihan menerima ejekan, tertawa, atau bereaksi biasa diberikan lewat instruksi abstrak dan contoh gaya impor, bukan giliran menang-kalah atau frasa balasan tetap. Detektor ini tidak menilai seluruh makna humor secara semantik.

Frasa gotcha `nah/tuh kan` beserta variasi tanda baca dan pemanjangan huruf diperiksa lintas sesi pada 200 pesan tersimpan terakhir per chat, tanpa batas 30 menit. Jika pernah muncul dalam balasan Arnel di jendela tersebut, prompt mengingatkan agar mengubah fungsi reaksi; pengulangan memicu maksimal satu regenerasi. Data memakai `chat_history.json` yang sudah persisten, termasuk histori sebelum upgrade dan setelah restart. Pesan user dan caption gambar tidak dihitung sebagai kebiasaan Arnel. Konteks Gemini tetap 20 pesan; tidak ada request tambahan untuk analisis histori. Deteksi ini bukan larangan permanen atau pemahaman semantik seluruh idiom; jika regenerasi gagal, mekanisme lama masih dapat mengirim draf pertama.

Saat obrolan mentok, prompt mengarahkan model memilih kaitan dinamis dari life state, cerita aktif, minat user yang diketahui, atau pengamatan kecil sesuai suasana dan histori. Masak/resep tidak menjadi fallback wajib; percakapan juga boleh selesai secara natural. Tidak ada daftar balasan cadangan atau pemicu topik berdasarkan kata `habis`. Reaksi sticker/foto ikut pemeriksaan gaya; godaan harus punya dasar dari konteks user, bukan asumsi Arnel sendiri.

### Informalitas dari gaya impor

`src/style.js` merangkum seluruh sampel aktif pengirim target menjadi bukti penulisan: bentuk kata yang muncul pada beberapa pesan, proporsi huruf kecil, akhir tanpa tanda baca, rata-rata panjang pesan, serta contoh tersebar dari sampel lama dan baru. Pesan lawan bicara pada kolom `input` tidak dihitung. Ringkasan di-cache, diperbarui saat data impor berubah, dan dibangun kembali dari `style_examples.json` setelah restart; data lama langsung didukung tanpa import ulang atau file state tambahan.

Prompt memakai bukti ini bersama contoh relevan untuk mengikuti singkatan, partikel, dan ejaan personal/regional yang benar-benar ada. Penghitungan kata tidak otomatis membedakan slang dari nama/topik: model diarahkan menafsirkan bukti tersebut, tidak menyalinnya sebagai daftar kata wajib. Angka bukan kuota dan ejaan langka tidak diwajibkan. Tanpa sampel, fallback memakai chat Indonesia santai umum secara konsisten. Kata ganti tetap aku/kamu, batas persona dan anti-pengulangan tetap berlaku. Tidak ada penggantian kata otomatis, dependency baru, atau panggilan API tambahan; konsistensi bahasa tetap perlu dievaluasi pada chat nyata.
