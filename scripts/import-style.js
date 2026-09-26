import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/storage.js';

const args = process.argv.slice(2);
const append = args[0] === '--append';
if (append) args.shift();
const speaker = args.pop();
if (!speaker || !args.length) { console.error('Pakai: npm run import-style -- [--append] file1.txt [file2.json ...] "Nama Pengirim"'); process.exit(1); }
const clean = x => String(x || '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
const noise = /^(<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|you sent an attachment\.|pesan ini telah dihapus|this message was deleted)$/i;
function whatsapp(text) {
  const messages = []; let last;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(?:\[)?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?::\d{2})?(?:\])?\s*(?:[-–]\s*)?([^:]+):\s*(.*)$/u);
    if (m) { last = { sender: clean(m[1]), text: clean(m[2]) }; messages.push(last); }
    else if (last && line.trim()) last.text = clean(`${last.text} ${line}`);
  }
  return messages;
}
function instagram(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.messages)) throw new Error('Instagram JSON tanpa array messages');
  return data.messages.filter(x => typeof x.sender_name === 'string' && typeof x.content === 'string')
    .map(x => ({ sender: clean(x.sender_name), text: clean(x.content), at: Number(x.timestamp_ms || 0) }))
    .sort((a, b) => a.at - b.at);
}
function sample(items, limit) {
  if (items.length <= limit) return items;
  const newest = Math.ceil(limit * .6), older = items.slice(0, -newest);
  return [...Array.from({ length: limit - newest }, (_, i) => older[Math.floor(i * older.length / (limit - newest))]), ...items.slice(-newest)];
}
const examples = [];
for (const filename of args) {
  const raw = fs.readFileSync(path.resolve(filename), 'utf8');
  const messages = filename.toLowerCase().endsWith('.json') ? instagram(raw) : whatsapp(raw);
  let previous = null;
  for (const m of messages) {
    const content = clean(m.text);
    if (!content || noise.test(content) || content.length > 420) { previous = null; continue; }
    if (m.sender.toLowerCase() === speaker.toLowerCase() && content.length >= 3) {
      examples.push({ content, ...(previous?.sender.toLowerCase() !== speaker.toLowerCase() ? { input: previous?.text?.slice(0, 240), output: content } : {}), importedAt: Date.now() });
    }
    previous = m;
  }
}
const limit = Math.max(40, Math.min(3000, Number(process.env.STYLE_IMPORT_LIMIT || 800)));
if (!examples.length) { console.error(`Tidak ada pesan dari "${speaker}". Periksa nama pengirim di export.`); process.exit(1); }
const store = new Store(path.resolve(process.env.DATA_DIR || './data'));
const old = append ? store.read('style_examples', { samples: [] }).samples || [] : [];
const seen = new Set();
const combined = [...old, ...examples].filter(x => {
  const key = clean(x.content).toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key); return true;
});
const selected = sample(combined, limit);
store.write('style_examples', { sourceName: speaker, importedAt: Date.now(), samples: selected });
console.log(`${selected.length} contoh disimpan (${examples.length} dari file masukan).`);
