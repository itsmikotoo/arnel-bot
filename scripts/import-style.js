import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2);
const append = rawArgs.includes("--append");
const args = rawArgs.filter((arg) => arg !== "--append");
const speakerArg = args.at(-1);
const fileArgs = args.slice(0, -1);

if (!fileArgs.length || !speakerArg) {
  console.error("Pakai: npm run import-style -- \"/path/chat.txt\" [file-lain.json] \"Nama Lawan Chat\"");
  process.exit(1);
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const OUTPUT_FILE = path.join(DATA_DIR, "style_examples.json");
const LIMIT = Math.max(40, Math.min(800, Number(process.env.STYLE_IMPORT_LIMIT || 500)));

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
    /^(?:\[)?\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?::\d{2})?(?:\])?\s*(?:[-–]\s*)?([^:]+):\s*(.*)$/u,
  );
  return match ? { sender: clean(match[1]), text: clean(match[2]) } : null;
}

function nameKey(value = "") {
  const normalized = clean(value);
  try {
    // Instagram exports occasionally decode UTF-8 sender names as Latin-1.
    const repaired = Buffer.from(normalized, "latin1").toString("utf8");
    if (/[^\x00-\x7f]/.test(repaired)) return repaired.toLowerCase();
  } catch {
    // Keep the original spelling if it cannot be repaired.
  }
  return normalized.toLowerCase();
}

const targetName = nameKey(speakerArg);

function parseWhatsApp(text) {
  const messages = [];
  let current;

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed) {
      current = parsed;
      messages.push(current);
    } else if (current && clean(line)) {
      current.text = clean(`${current.text} ${line}`);
    }
  }

  return messages;
}

function parseInstagram(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.messages)) return [];

  return data.messages
    .filter((item) => typeof item.sender_name === "string" && typeof item.content === "string")
    .map((item) => ({
      sender: clean(item.sender_name),
      text: clean(item.content),
      timestamp: Number(item.timestamp_ms || 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

const messages = fileArgs.flatMap((fileArg) => {
  const raw = fs.readFileSync(path.resolve(fileArg), "utf8");
  try {
    return parseInstagram(raw);
  } catch {
    return parseWhatsApp(raw);
  }
}).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

const seen = new Set();
const candidates = messages
  .filter((item) => nameKey(item.sender) === targetName)
  .map((item) => clean(item.text))
  .filter((text) => text.length >= 3 && text.length <= 420 && !isMediaOrSystemMessage(text))
  .filter((text) => {
    const key = text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

function selectStyleSamples(items, limit) {
  if (items.length <= limit) return items;
  const recentCount = Math.ceil(limit * 0.6);
  const older = items.slice(0, -recentCount);
  const spacedOlder = Array.from({ length: limit - recentCount }, (_, index) => (
    older[Math.floor(index * older.length / (limit - recentCount))]
  ));
  return [...spacedOlder, ...items.slice(-recentCount)];
}

const samples = selectStyleSamples(candidates, LIMIT)
  .map((content) => ({ content, importedAt: Date.now() }));

if (!samples.length) {
  console.error(`Tidak ada pesan dari "${speakerArg}". Cek lagi nama pengirimnya persis seperti di file export.`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

let existing = [];
let sourceNames = [];
if (append) {
  try {
    const oldData = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    existing = Array.isArray(oldData.samples) ? oldData.samples : [];
    sourceNames = Array.isArray(oldData.sourceNames)
      ? oldData.sourceNames
      : oldData.sourceName ? [oldData.sourceName] : [];
  } catch {
    // Tidak ada referensi lama, lanjut sebagai import pertama.
  }
}

const unique = new Map();
for (const item of [...existing, ...samples]) {
  const content = clean(item.content);
  if (!content) continue;
  unique.set(content.toLowerCase(), { ...item, content });
}
const mergedSamples = selectStyleSamples([...unique.values()], LIMIT);
const sourceName = clean(speakerArg);
if (!sourceNames.includes(sourceName)) sourceNames.push(sourceName);

fs.writeFileSync(
  OUTPUT_FILE,
  JSON.stringify({ sourceName: sourceNames.at(-1), sourceNames, importedAt: Date.now(), samples: mergedSamples }, null, 2),
);

console.log(`${append ? "Menambah" : "Menyimpan"} ${samples.length} contoh dari ${sourceName}.`);
console.log(`Total referensi aktif: ${mergedSamples.length} contoh (batas ${LIMIT}).`);
console.log("Contoh ini dipakai sebagai referensi gaya Arnel, bukan disalin mentah.");
