import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/storage.js';
const source = path.resolve(process.argv[2] || '');
const target = path.resolve(process.argv[3] || './data');
if (!process.argv[2] || !fs.existsSync(source) || source === target) { console.error('Pakai: node scripts/migrate-v2.js /path/arnel-bot/data ./data'); process.exit(1); }
const store = new Store(target);
for (const name of ['chat_history', 'training_examples', 'relationship_state', 'memories', 'behavior_rules', 'style_examples', 'proactive_state']) {
  const from = path.join(source, `${name}.json`), to = store.file(name);
  if (fs.existsSync(from) && !fs.existsSync(to)) { const data = JSON.parse(fs.readFileSync(from, 'utf8')); store.write(name, data); console.log(`impor ${name}`); }
}
const oldStories = path.join(source, 'arnel_story_notes.json');
if (fs.existsSync(oldStories) && !fs.existsSync(store.file('story_threads'))) {
  const data = JSON.parse(fs.readFileSync(oldStories, 'utf8'));
  const now = Date.now(), threads = {};
  for (const [jid, items] of Object.entries(data)) threads[jid] = items.map(x => ({ text: x.content, createdAt: x.createdAt || now, lastMentionAt: x.updatedAt || x.createdAt || now, expiresAt: now + 30 * 86400000, stage: 'preparation' })).slice(-40);
  store.write('story_threads', threads); console.log('impor story_threads');
}
const authFrom = path.join(source, 'baileys_auth'), authTo = path.join(target, 'baileys_auth');
if (fs.existsSync(authFrom) && !fs.existsSync(authTo)) { fs.cpSync(authFrom, authTo, { recursive: true, mode: 0o700 }); console.log('impor baileys_auth'); }
console.log('Selesai. File v2 asli tidak diubah; target yang sudah ada tidak ditimpa.');
