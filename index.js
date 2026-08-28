// index.js
// Bot utama: connect ke WhatsApp, terima pesan, panggil AI, kirim balasan bertahap.

require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SYSTEM_PROMPT } = require("./persona");
const { saveMessage, getHistory } = require("./db");

// ---- Konfigurasi ----
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || null;
// Format ALLOWED_CHAT_ID: "628xxxxxxxxxx@c.us" (nomor kamu sendiri, pakai kode negara, tanpa +/spasi)
// Kalau null, bot akan balas ke semua chat masuk (TIDAK disarankan untuk testing pertama).

const MAX_HISTORY = 20; // jumlah pesan terakhir yang dikirim sebagai konteks ke AI

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: SYSTEM_PROMPT,
});

// ---- Setup WhatsApp client ----
// DATA_DIR menunjuk ke folder persistent volume di Northflank (default: ./data untuk lokal)
const DATA_DIR = process.env.DATA_DIR || "./data";

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: `${DATA_DIR}/.wwebjs_auth` }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // penting di container dengan RAM/shm terbatas
      "--disable-gpu",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("Scan QR code ini pakai WhatsApp di nomor bot:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Bot siap! Arnel udah online.");
});

client.on("auth_failure", (msg) => {
  console.error("Autentikasi gagal:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Terputus:", reason);
});

// ---- Handler pesan masuk ----
client.on("message", async (msg) => {
  try {
    const chatId = msg.from;

    // Filter: kalau ALLOWED_CHAT_ID diset, cuma respon ke chat itu
    if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
      return;
    }

    // Abaikan pesan dari grup (opsional, hapus baris ini kalau mau bot jalan di grup juga)
    if (chatId.endsWith("@g.us")) return;

    const userText = msg.body?.trim();
    if (!userText) return;

    console.log(`[masuk] ${chatId}: ${userText}`);

    // Simpan pesan user ke histori
    saveMessage(chatId, "user", userText);

    // Ambil histori percakapan buat konteks
    const history = getHistory(chatId, MAX_HISTORY);
    // Gemini butuh histori dimulai dari role "user", dan format role "model" bukan "assistant"
    const historyForAI = history
      .map((h) => ({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.content }],
      }))
      .slice(0, -1); // pesan terakhir (yang barusan masuk) dikirim terpisah, bukan sebagai histori

    // Tampilkan "typing..." biar lebih natural
    const chat = await msg.getChat();
    await chat.sendStateTyping();

    // Panggil Gemini API
    const chatSession = model.startChat({ history: historyForAI });
    const result = await chatSession.sendMessage(userText);
    const rawReply = result.response.text().trim();

    // Simpan balasan penuh ke histori (biar konteks AI tetap utuh)
    saveMessage(chatId, "assistant", rawReply);

    // Pecah balasan jadi beberapa bubble pesan berdasarkan tanda "||"
    const parts = rawReply
      .split("||")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    for (const part of parts) {
      // Delay biar kerasa natural, proporsional sama panjang teks
      const delay = Math.min(1200 + part.length * 30, 4000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      await chat.sendStateTyping();
      await client.sendMessage(chatId, part);
    }
  } catch (err) {
    console.error("Error saat proses pesan:", err);
  }
});

client.initialize();