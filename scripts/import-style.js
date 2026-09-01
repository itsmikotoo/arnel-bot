import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [fileArg, speakerArg] = process.argv.slice(2);

if (!fileArg || !speakerArg) {
  console.error("Pakai: npm run import-style -- \"/path/chat.txt\" \"Nama Lawan Chat\"");
  process.exit(1);
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const OUTPUT_FILE = path.join(DATA_DIR, "style_examples.json");
const LIMIT = Math.max(20, Math.min(120, Number(process.env.STYLE_IMPORT_LIMIT || 80)));

function clean(value = "") {
  return value
    .replace(/[\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMediaOrSystemMessage(value) {
  return /^(<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|pesan ini telah dihapus|you deleted this message|this message was deleted)$/i.test(value);
}

function parseLine(line) {
  const match = clean(line).match(
    /^(?:\[)?\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?::\d{2})?(?:\])?\s*(?:[-–])?\s*)([^:]+):\s*(.*)$/u,
  );
  return match ? { sender: clean(match[1]), text: clean(match[2]) } : null;
}

const raw = fs.readFileSync(path.resolve(fileArg), "utf8");
const targetName = clean(speakerArg).toLowerCase();
const messages = [];
let current;

for (const line of raw.split(/\r?\n/)) {
  const parsed = parseLine(line);
  if (parsed) {
    current = parsed;
    messages.push(current);
  } else if (current && clean(line)) {
    current.text = clean(`${current.text} ${line}`);
  }
}

const seen = new Set();
const samples = messages
  .filter((item) => item.sender.toLowerCase() === targetName)
  .map((item) => clean(item.text))
  .filter((text) => text.length >= 3 && text.length <= 420 && !isMediaOrSystemMessage(text))
  .filter((text) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .slice(-LIMIT)
  .map((content) => ({ content, importedAt: Date.now() }));

if (!samples.length) {
  console.error(`Tidak ada pesan dari "${speakerArg}". Cek lagi nama pengirimnya persis seperti di file export.`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  OUTPUT_FILE,
  JSON.stringify({ sourceName: clean(speakerArg), importedAt: Date.now(), samples }, null, 2),
);

console.log(`Berhasil menyimpan ${samples.length} contoh gaya dari ${clean(speakerArg)} ke ${OUTPUT_FILE}`);
console.log("Contoh ini dipakai sebagai referensi gaya Arnel, bukan disalin mentah.");
