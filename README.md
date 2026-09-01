# Arnel Bot v2

Versi ringan berbasis Baileys 7. Tidak memakai Chromium atau Puppeteer.

## Tes koneksi bersih di Windows PowerShell

```powershell
cd D:\blender\bot
Remove-Item -Recurse -Force .\data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\node_modules -ErrorAction SilentlyContinue
Remove-Item .\package-lock.json -Force -ErrorAction SilentlyContinue
Copy-Item .env.example .env
npm install
npm run check
npm start
```

Biarkan `CONNECTION_ONLY=true` saat tes awal. Scan QR melalui WhatsApp > Perangkat tertaut.
Jika terminal menampilkan `WhatsApp tersambung`, hentikan dengan Ctrl+C, ubah menjadi
`CONNECTION_ONLY=false`, isi `GEMINI_API_KEY` serta `ALLOWED_NUMBER`, lalu jalankan lagi.

Jangan upload `.env` atau folder `data` ke GitHub.

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

Contoh latihan disimpan di `data/training_examples.json`, sedangkan tingkat kedekatan, mood,
dan kebiasaan panjang chat disimpan di `data/relationship_state.json`. Keduanya tidak masuk Git
karena folder `data` diabaikan. Mood bergeser perlahan tiap sekitar 12–20 interaksi, bukan berubah
acak di setiap pesan. Arnel memilih hingga enam contoh paling relevan untuk membantu membentuk balasan baru.

## Import gaya chat

Kamu dapat mengimpor gaya dari export chat WhatsApp tanpa media atau file JSON dari export
Instagram. Importer mengambil hanya pesan dari nama lawan chat yang kamu tentukan, membuang media
dan duplikat, lalu menyimpan maksimal 240 contoh di `data/style_examples.json`.

```bash
npm run import-style -- "/home/mikoto/Downloads/WhatsApp Chat with Nama.txt" "Nama Lawan Chat"
npm run import-style -- "/home/mikoto/Downloads/message_1.json" "Nama Lawan Chat"
npm run import-style -- "/home/mikoto/Downloads/message_1.json" "/home/mikoto/Downloads/message_2.json" "Nama Lawan Chat"
```

Contoh terpilih dikirim ke Gemini hanya sebagai referensi ritme bahasa Arnel. Jangan impor chat
yang tidak punya izin untuk dipakai, dan jangan gunakan chat berisi data sensitif. Hasil impor
tidak membuat Arnel menyalin kata-kata persis atau meniru identitas orang tersebut.
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

`!ingat` menyimpan catatan di `data/memories.json`; `!ingatan` menampilkan hingga sepuluh
catatan terakhir. Memori dikirim ke Gemini hanya untuk membantu balasan dan pesan inisiatif yang
relevan. Jangan simpan kata sandi, token, alamat lengkap, atau informasi sangat sensitif.
