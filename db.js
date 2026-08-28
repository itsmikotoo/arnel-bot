// db.js
// Nyimpen histori percakapan pakai file JSON biasa (gak perlu native compile,
// cocok buat volume chat personal yang kecil).

const fs = require("fs");
const path = require("path");

// DATA_DIR menunjuk ke folder persistent volume di Northflank (default: ./data untuk lokal)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "chat_history.json");

function loadAll() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function saveMessage(chatId, role, content) {
  const data = loadAll();
  if (!data[chatId]) data[chatId] = [];
  data[chatId].push({ role, content, created_at: Date.now() });
  // Biar file gak membengkak, simpan maksimal 200 pesan terakhir per chat
  if (data[chatId].length > 200) {
    data[chatId] = data[chatId].slice(-200);
  }
  saveAll(data);
}

// Ambil N pesan terakhir, dikembalikan urut dari lama ke baru
function getHistory(chatId, limit = 20) {
  const data = loadAll();
  const messages = data[chatId] || [];
  return messages.slice(-limit);
}

module.exports = { saveMessage, getHistory };