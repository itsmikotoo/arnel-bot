import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "chat_history.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadAll() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(data) {
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, DB_FILE);
}

export function saveMessage(chatId, role, content) {
  const data = loadAll();
  data[chatId] ||= [];
  data[chatId].push({ role, content, createdAt: Date.now() });
  data[chatId] = data[chatId].slice(-200);
  saveAll(data);
}

export function getHistory(chatId, limit = 20) {
  return (loadAll()[chatId] || []).slice(-limit);
}
