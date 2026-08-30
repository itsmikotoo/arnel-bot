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
