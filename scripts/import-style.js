import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { clean, normalize } from "../style.js";

const MAX_PAIR_GAP = 2 * 60 * 60 * 1000;
const MAX_BUBBLE_GAP = 15 * 60 * 1000;

// Meta exports may encode UTF-8 bytes as Latin-1 characters. Keep real Unicode intact.
export function decodeInstagram(value = "") {
  if (!/[\u0080-\u00ff]/.test(value) || [...value].some((char) => char.codePointAt(0) > 255)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("\ufffd") ? value : decoded;
}

function isMediaOrSystemMessage(value) {
  return !value || /(?:<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|media tidak disertakan|pesan ini telah dihapus|you deleted this message|this message was deleted|sent an attachment|mengirim lampiran|reacted .+ to your message)/i.test(value)
    || /https?:\/\//i.test(value);
}

export function parseWhatsApp(text) {
  const messages = [];
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = clean(rawLine);
    const match = line.match(/^\[?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(AM|PM)?\]?\s*(?:[-–]\s*)?(.*)$/i);
    if (match) {
      const [, day, month, year, hour, minute, second, period, body] = match;
      const sender = body.match(/^([^:]+):\s*(.*)$/);
      let hours = Number(hour);
      if (period) hours = hours % 12 + (period.toUpperCase() === "PM" ? 12 : 0);
      const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
      const timestamp = Date.UTC(fullYear, Number(month) - 1, Number(day), hours, Number(minute), Number(second || 0));
      current = { sender: sender ? clean(sender[1]) : "", text: sender ? clean(sender[2]) : "", timestamp };
      messages.push(current); // System/media messages remain boundaries for pairing.
    } else if (current && line) {
      current.text = clean(`${current.text} ${line}`);
    }
  }
  return messages;
}

export function parseInstagram(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.messages)) throw new Error("JSON bukan export pesan Instagram");
  return data.messages.map((item) => ({
    sender: clean(decodeInstagram(typeof item.sender_name === "string" ? item.sender_name : "")),
    text: clean(decodeInstagram(typeof item.content === "string" ? item.content : "")),
    timestamp: Number(item.timestamp_ms) || 0,
  })).sort((a, b) => a.timestamp - b.timestamp);
}

export function buildSamples(messages, speaker, importedAt = Date.now()) {
  const target = clean(speaker).toLowerCase();
  const turns = [];
  for (const message of messages) {
    const text = clean(message.text);
    if (!message.sender || isMediaOrSystemMessage(text)) {
      turns.push(null);
      continue;
    }
    const previous = turns.at(-1);
    const timestamp = message.timestamp || 0;
    const gap = timestamp - (previous?.timestamp || 0);
    const sameTurn = previous && previous.sender === message.sender && timestamp && previous.timestamp
      && gap >= 0 && gap <= MAX_BUBBLE_GAP && previous.text.length + text.length < 600;
    if (sameTurn) {
      previous.text += ` || ${text}`;
      previous.timestamp = timestamp;
    } else {
      turns.push({ sender: message.sender, text, timestamp, startedAt: timestamp });
    }
  }
  const samples = [];
  for (const [index, turn] of turns.entries()) {
    if (!turn || turn.sender.toLowerCase() !== target || turn.text.length > 600) continue;
    const previous = turns[index - 1];
    const gap = turn.startedAt - (previous?.timestamp || 0);
    const hasContext = previous && previous.text.length <= 600 && previous.sender.toLowerCase() !== target
      && turn.startedAt && previous.timestamp && gap >= 0 && gap <= MAX_PAIR_GAP;
    samples.push({
      content: turn.text,
      ...(hasContext ? { input: previous.text } : {}),
      sourceName: clean(speaker),
      importedAt,
    });
  }
  return samples;
}

export function selectStyleSamples(items, limit) {
  if (items.length <= limit) return items;
  const recentCount = Math.ceil(limit * 0.6);
  const older = items.slice(0, -recentCount);
  const count = limit - recentCount;
  const spaced = Array.from({ length: count }, (_, index) => older[Math.floor(index * older.length / count)]);
  return [...spaced, ...items.slice(-recentCount)];
}

export function mergeSamples(existing, incoming) {
  const unique = new Map();
  for (const item of [...existing, ...incoming]) {
    if (!item || typeof item.content !== "string" || !item.content.trim()) continue;
    const key = JSON.stringify([normalize(item.input || ""), normalize(item.content)]);
    // Keep the original timestamps on a no-op reimport.
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export function runImport(args, env = process.env) {
  const flags = args.filter((arg) => arg.startsWith("--"));
  if (flags.some((flag) => !["--append", "--replace"].includes(flag)) || (flags.includes("--append") && flags.includes("--replace"))) {
    throw new Error("Pakai salah satu --append atau --replace");
  }
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const speaker = positional.at(-1);
  const files = positional.slice(0, -1);
  if (!speaker || !files.length) throw new Error('Pakai: npm run import-style -- [--append|--replace] "/path/chat.json" [file-lain.json] "Nama Lawan Chat"');
  const requestedLimit = Number(env.STYLE_IMPORT_LIMIT || 800);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5000) {
    throw new Error("STYLE_IMPORT_LIMIT harus bilangan bulat 1 sampai 5000");
  }
  // Parse each file independently: never pair the end of one conversation with another.
  const candidates = files.flatMap((file) => {
    const raw = fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, "");
    const messages = raw.trimStart().startsWith("{") ? parseInstagram(raw) : parseWhatsApp(raw);
    return buildSamples(messages, speaker);
  });
  const incoming = selectStyleSamples(mergeSamples([], candidates), requestedLimit);
  if (!incoming.length) throw new Error(`Tidak ada pesan dari "${speaker}". Cek nama pengirim di export.`);
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const output = path.join(dataDir, "style_examples.json");
  let previous = {};
  if (fs.existsSync(output)) {
    previous = JSON.parse(fs.readFileSync(output, "utf8"));
    if (!Array.isArray(previous.samples)) throw new Error("Format style_examples.json lama tidak valid; file tidak diubah");
  }
  const existing = flags.includes("--replace") ? [] : (previous.samples || []);
  const samples = mergeSamples(existing, incoming);
  if (samples.length > 5000) throw new Error("Gabungan melebihi 5000 contoh; kurangi STYLE_IMPORT_LIMIT atau pilih --replace secara sengaja. File lama tidak diubah.");
  const sourceNames = [...new Set(samples.map((item) => item.sourceName).filter(Boolean))];
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = `${output}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...previous, schemaVersion: 2, sourceName: clean(speaker), sourceNames, importedAt: Date.now(), samples }, null, 2));
  fs.renameSync(temp, output);
  const paired = samples.filter((item) => item.input).length;
  return { count: samples.length, paired, added: samples.length - existing.length, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await import("dotenv/config");
    const result = runImport(process.argv.slice(2));
    console.log(`Aktif ${result.count} contoh (${result.paired} pasangan konteks dan respons; ${result.added} tambahan) di ${result.output}`);
    console.log("Contoh lama tetap dipakai. Impor ulang export dengan --append untuk menambahkan pasangan konteks.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
