// db.js
// Nyimpen histori percakapan pakai SQLite biar Arnel "inget" konteks sebelumnya.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// DATA_DIR menunjuk ke folder persistent volume di Northflank (default: ./data untuk lokal)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "chat_history.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' atau 'assistant'
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const insertStmt = db.prepare(
  `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`
);

const historyStmt = db.prepare(
  `SELECT role, content FROM messages
   WHERE chat_id = ?
   ORDER BY id DESC
   LIMIT ?`
);

function saveMessage(chatId, role, content) {
  insertStmt.run(chatId, role, content, Date.now());
}

// Ambil N pesan terakhir, dikembalikan urut dari lama ke baru
function getHistory(chatId, limit = 20) {
  const rows = historyStmt.all(chatId, limit);
  return rows.reverse();
}

module.exports = { saveMessage, getHistory };