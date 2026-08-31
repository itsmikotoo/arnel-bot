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
