# Arnel Bot — WhatsApp Persona Chatbot

Bot WhatsApp dengan persona "Arnel Latasha" menggunakan `whatsapp-web.js` + Claude API + SQLite untuk histori percakapan.

## Struktur Project

```
arnel-bot/
├── index.js          # Bot utama: koneksi WA + panggil AI + kirim balasan
├── persona.js         # System prompt / kepribadian Arnel
├── db.js              # Penyimpanan histori chat (SQLite)
├── package.json
├── .env.example        # Contoh konfigurasi
└── chat_history.db     # Dibuat otomatis saat pertama jalan
```

## Cara Setup

### 1. Install Node.js
Pastikan Node.js versi 18+ terinstall. Cek dengan:
```bash
node -v
```

### 2. Install dependencies
```bash
cd arnel-bot
npm install
```

### 3. Konfigurasi environment
```bash
cp .env.example .env
```
Lalu edit `.env`:
- `GEMINI_API_KEY` — API key dari [aistudio.google.com](https://aistudio.google.com) (klik "Get API Key", gratis)
- `ALLOWED_CHAT_ID` — nomor kamu sendiri (nomor kedua), format `62xxxxxxxxxx@c.us`.
  Ini penting supaya bot cuma bales chat kamu, bukan siapa aja yang chat ke nomor bot.

### 4. Jalankan bot
```bash
npm start
```
Akan muncul QR code di terminal. Scan pakai **nomor bot** (nomor pertama) lewat:
WhatsApp di HP → Menu (titik tiga) → Perangkat Tertaut → Tautkan Perangkat.

Setelah scan sekali, session tersimpan di folder `.wwebjs_auth/` — gak perlu scan ulang
selama folder itu gak dihapus dan server gak ganti.

### 5. Testing
Chat ke nomor bot dari nomor kamu (yang terdaftar di `ALLOWED_CHAT_ID`). Bot akan
membalas dengan gaya khas Arnel — pesan pendek dipisah beberapa bubble, tanpa emoji.

## Menjalankan terus-menerus (production)

Supaya bot tetap hidup 24 jam dan auto-restart kalau crash, pakai `pm2`:

```bash
npm install -g pm2
pm2 start index.js --name arnel-bot
pm2 save
pm2 startup   # ikuti instruksi yang muncul biar auto-start saat server reboot
```

Cek log:
```bash
pm2 logs arnel-bot
```

## Catatan Penting

- **Risiko banned**: `whatsapp-web.js` adalah library unofficial (reverse-engineered),
  bukan API resmi WhatsApp Business. Pemakaian wajar (chat personal) umumnya aman,
  tapi hindari pola yang terlalu "robotic" (respon instan tanpa jeda, volume pesan sangat tinggi).
- **Biaya API**: bot ini pakai Gemini API (`gemini-2.5-flash`) yang punya free tier —
  cukup buat pemakaian chat personal sehari-hari. Kalau volume chat sangat tinggi,
  cek limit terbaru di [ai.google.dev/pricing](https://ai.google.dev/pricing).
- **Privasi**: `ALLOWED_CHAT_ID` penting supaya bot gak otomatis bales orang lain yang
  chat ke nomor bot itu.
- **Ubah persona**: semua kepribadian Arnel ada di `persona.js`, tinggal edit teksnya
  kalau mau nyesuaiin lebih lanjut.

## Pengembangan Selanjutnya (opsional)

- Ringkasan histori otomatis kalau chat udah kepanjangan (biar konteks gak kepotong)
- Bot inisiatif kirim pesan duluan di waktu tertentu (butuh scheduler seperti `node-cron`)
- Dukungan voice note (text-to-speech) atau kirim gambar