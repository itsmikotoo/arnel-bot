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
