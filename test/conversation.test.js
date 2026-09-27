import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot, styleIssue, tapiAdviceEnding } from '../src/bot.js';
import { Store } from '../src/storage.js';
import { Memory } from '../src/memory.js';
import { Life } from '../src/life.js';
import { Relationship } from '../src/relationship.js';
import { gotchaPhrase } from '../src/banter.js';
import { Style, languageProfile } from '../src/style.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-conversation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), requests = [], memory = new Memory(store);
  const bot = new Bot({ config: { allowedNumber: '628123', debounceMs: 60000, lightReadingChance: 1 }, logger: { info() {}, warn() {}, debug() {}, error() {} }, store, memory, life: new Life(store), relationship: new Relationship(store), story: { active: () => [], track() {} }, style: { examples: () => [] }, scheduler: { activity() {} }, gemini: { generate: async request => { requests.push(request); return 'bagian audionya bisa jadi penentu suasananya'; } } });
  bot.send = async (jid, text) => memory.addMessage(jid, 'assistant', text);
  t.after(() => { for (const p of bot.pending.values()) clearTimeout(p.timer); });
  return { bot, requests, memory };
}
const message = (id, text) => ({ key: { id, remoteJid: '628123@s.whatsapp.net' }, message: { conversation: text } });
test('burst reaches Gemini once with every message in order and is saved intact', async t => {
  const { bot, requests, memory } = fixture(t);
  await bot.onMessage(message('1', 'aku lagi ngedit video motor'));
  await bot.onMessage(message('2', 'tapi audionya belum cocok'));
  await bot.flush('628123@s.whatsapp.net');
  assert.equal(requests.length, 1);
  const prompt = requests[0].parts[0].text;
  assert.match(prompt, /\[Pesan 1\]\naku lagi ngedit video motor/);
  assert.match(prompt, /\[Pesan 2\]\ntapi audionya belum cocok/);
  assert.doesNotMatch(requests[0].system, /Untuk balasan ini, baca pesan secara santai/);
  assert.equal(memory.history('628123@s.whatsapp.net')[0].content, 'aku lagi ngedit video motor\ntapi audionya belum cocok');
});
test('messages arriving while a previous turn is running are retained in the next batch', async t => {
  const { bot, memory } = fixture(t);
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  bot.gemini.generate = async () => {
    if (++calls === 1) { started(); await new Promise(resolve => { finish = resolve; }); }
    return 'bagian audionya bisa jadi penentu suasananya';
  };
  await bot.onMessage(message('1', 'aku lagi ngedit'));
  const first = bot.flush('628123@s.whatsapp.net');
  await began;
  await bot.onMessage(message('2', 'video motor'));
  await bot.onMessage(message('3', 'buat temen'));
  const second = bot.flush('628123@s.whatsapp.net');
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(memory.history('628123@s.whatsapp.net').filter(x => x.role === 'user').map(x => x.content), ['aku lagi ngedit', 'video motor\nbuat temen']);
});
test('closing tapi suggestions match across different particles; factual contrast is allowed', () => {
  const prior = [{ role: 'assistant', content: 'boleh lanjut, tapi kalau ngantuk tidur aja', createdAt: Date.now() }];
  assert.equal(tapiAdviceEnding('boleh juga, tapi rebahan dulu'), true);
  assert.match(styleIssue('oke, tapi kalau udah capek istirahat aja', prior, 'iya'), /penutup tapi dengan saran/);
  assert.equal(tapiAdviceEnding('aku mau keluar tapi hujan'), false);
});
test('caretaker intent repeats even with different framing, but advice requests are allowed', () => {
  const prior = [{ role: 'assistant', content: 'mending tidur dulu', createdAt: Date.now() }];
  assert.match(styleIssue('coba rebahan aja', prior, 'aku baru selesai edit'), /fungsi nasihat berulang/);
  assert.equal(styleIssue('coba rebahan aja', prior, 'mending ngapain sekarang'), '');
  assert.equal(styleIssue('aku mau tidur dulu', prior, 'iya'), '');
  assert.equal(styleIssue('bagian endingnya aku suka', prior, 'nih hasil editnya'), '');
});
test('consecutive rhetorical counters are detected without question marks', () => {
  const examples = ['kurang panjang apa coba kalau dipanggil pas upacara', 'maunya sepanjang apa emang biar puas', 'emang tinggi kamu berapaan sih sampai ngatain aku pendek'];
  for (let i = 1; i < examples.length; i++) {
    assert.match(styleIssue(examples[i], [{ role: 'assistant', content: examples[i - 1], createdAt: Date.now() }], 'pendek banget'), /counter retoris berulang/);
  }
  assert.equal(styleIssue('kamu besok berangkat jam berapa?', [{ role: 'assistant', content: examples[0] }], 'besok aku pergi'), '');
  assert.equal(styleIssue('yaudah kali ini kamu menang', [{ role: 'assistant', content: examples[1] }], 'nama kamu pendek'), '');
});
test('frequent analogies are flagged but isolated or requested comparisons are allowed', () => {
  const history = ['rasanya kaya mau dipanggil ke ruang guru', 'aku kayak pemain cadangan hari ini'].map(content => ({ role: 'assistant', content, createdAt: Date.now() }));
  assert.match(styleIssue('ini serasa sidang skripsi', history, 'ditanya mulu ya'), /perumpamaan berulang/);
  assert.equal(styleIssue('kue ini kayak pancake kecil', history, 'bentuk kuenya kayak apa'), '');
  assert.equal(styleIssue('rasanya kaya mau dipanggil ke ruang guru', [], 'deg degan ya'), '');
  assert.equal(styleIssue('kayaknya besok aja', history, 'mau kapan'), '');
});
test('repeated banter triggers one rewrite and accepts a relaxed non-counter response', async t => {
  const { bot, memory } = fixture(t);
  memory.addMessage('jid', 'user', 'nama kamu pendek');
  memory.addMessage('jid', 'assistant', 'kurang panjang apa coba kalau dipanggil pas upacara');
  const drafts = ['maunya sepanjang apa emang biar puas', 'iya deh aku kalah'];
  let calls = 0;
  bot.gemini.generate = async request => {
    calls++;
    if (calls === 2) assert.match(request.system, /counter retoris berulang/);
    return drafts.shift();
  };
  assert.equal(await bot.ask('jid', 'masih pendek'), 'iya deh aku kalah');
  assert.equal(calls, 2);
});
test('social roast must be grounded in user context, not a previous assistant invention', () => {
  const roast = 'dih ngirim sticker begitu gayanya udah kayak anak Jaksel nongkrong di Senopati';
  assert.match(styleIssue(roast, [], '[sticker]'), /stereotip sosial tanpa konteks/);
  assert.match(styleIssue(roast, [{ role: 'assistant', content: 'kamu anak Jaksel di Senopati' }], '[sticker]'), /stereotip sosial tanpa konteks/);
  assert.equal(styleIssue(roast, [{ role: 'user', content: 'aku lagi bahas stereotip anak Jaksel nongkrong Senopati' }], 'lanjut'), '');
  assert.equal(styleIssue('Senopati ada di Jakarta Selatan', [], 'lokasinya di mana'), '');
});
test('sticker replies are checked and rewritten while retaining image context', async t => {
  const { bot } = fixture(t), calls = [];
  const drafts = ['dih ngirim sticker begitu gayanya udah kayak anak Jaksel nongkrong di Senopati', 'wkwkwk'];
  bot.gemini.generate = async request => { calls.push(request); return drafts.shift(); };
  assert.equal(await bot.ask('jid', '', { kind: 'sticker', mimeType: 'image/webp', buffer: Buffer.from('sticker') }), 'wkwkwk');
  assert.equal(calls.length, 2);
  assert.match(calls[1].system, /stereotip sosial tanpa konteks/);
  assert.deepEqual(calls[0].parts, calls[1].parts);
  assert.equal(calls[1].parts[1].inlineData.mimeType, 'image/webp');
});
test('gotcha variants share a cross-session limit without treating user quotes as assistant habits', () => {
  const old = [{ role: 'assistant', content: 'tuh kan langsung ngaku kalau emang hobi molor', createdAt: Date.now() - 3 * 86400000 }];
  for (const text of ['nah kan jujur', 'nah, kan ketahuan', 'tuhh kann ngaku juga']) {
    assert.equal(gotchaPhrase(text), true);
    assert.match(styleIssue(text, [], 'iya', false, old), /gotcha berulang lintas sesi/);
  }
  assert.equal(styleIssue('nah kan jujur', [], 'iya'), '');
  assert.equal(styleIssue('nah kan jujur', [{ role: 'user', content: 'tuh kan' }], 'iya'), '');
  assert.equal(styleIssue('nah kan jujur', [{ role: 'assistant', content: 'tuh kan', media: 'image' }], 'iya'), '');
  assert.equal(gotchaPhrase('nah kamu duluan'), false);
  assert.equal(gotchaPhrase('itu kanvas baru'), false);
});
test('gotcha monitoring survives restart and looks beyond Gemini context without enlarging it', async t => {
  const { bot, memory } = fixture(t);
  memory.addMessage('jid', 'assistant', 'tuh kan langsung ngaku');
  for (let i = 0; i < 24; i++) memory.addMessage('jid', i % 2 ? 'assistant' : 'user', `percakapan lain ${i}`);
  bot.store.update('chat_history', {}, db => { db.jid[0].createdAt = Date.now() - 3 * 86400000; });
  bot.memory = new Memory(new Store(bot.store.dir));
  const calls = [], drafts = ['nah kan jujur', 'aku juga belum pengen bangun'];
  bot.gemini.generate = async request => { calls.push(request); return drafts.shift(); };
  assert.equal(await bot.ask('jid', 'masih ngantuk'), 'aku juga belum pengen bangun');
  assert.equal(calls.length, 2);
  assert.match(calls[0].system, /Riwayat lintas sesi/);
  assert.match(calls[1].system, /gotcha berulang lintas sesi/);
  assert.doesNotMatch(JSON.stringify(calls[0].history), /langsung ngaku/);
  assert.equal(styleIssue('nah kan jujur', bot.memory.history('different-jid', 200), 'iya'), '');
});
test('topic exhaustion uses current life and story context, without a canned cooking fallback', async t => {
  const { bot, requests } = fixture(t);
  bot.life.context = () => 'sedang menunggu pengumuman pendidikan';
  bot.story.active = () => [{ text: 'buku pinjaman belum dikembalikan' }];
  await bot.ask('jid', 'habis bahan obrolannya');
  assert.equal(requests.length, 1);
  assert.match(requests[0].system, /Jangan otomatis menawarkan masak, resep/);
  assert.match(requests[0].system, /sedang menunggu pengumuman pendidikan/);
  assert.match(requests[0].system, /buku pinjaman belum dikembalikan/);
  assert.match(requests[0].system, /membiarkan percakapan selesai/);
  assert.match(requests[0].system, /kata pendek seperti habis tidak otomatis/);
});
test('language profile learns observed spelling from target output, not the other speaker', () => {
  const profile = languageProfile([
    { input: 'bahwasanya formalbanget', output: 'capeknyo capeknyo nian' },
    { input: 'formalbanget lagi', output: 'capeknyo nian' },
    { content: 'Gue udh pulang.' },
  ]);
  assert.deepEqual(profile.frequent, [['capeknyo', 2], ['nian', 2]]);
  assert.equal(profile.count, 3);
  assert.equal(profile.bareEndingPercent, 67);
  assert.doesNotMatch(JSON.stringify(profile), /formalbanget|bahwasanya|\bgue\b/i);
  assert.equal(languageProfile([]), null);
});
test('existing imported styles guide register and update after reimport or restart', async t => {
  const { bot, requests } = fixture(t);
  bot.store.write('style_examples', { samples: [{ content: 'capeknyo nian' }, { content: 'ngantuknyo nian' }] });
  bot.style = new Style(bot.store);
  const before = bot.style.languageContext();
  assert.match(before, /capeknyo/);
  assert.equal(new Style(new Store(bot.store.dir)).languageContext(), before);
  await bot.ask('jid', 'lagi apa');
  assert.match(requests[0].system, /ejaan personal\/regional/);
  assert.match(requests[0].system, /capeknyo/);
  assert.doesNotMatch(requests[0].system, /Belum ada gaya impor/);
  bot.store.write('style_examples', { samples: [{ content: 'emg gt' }, { content: 'emg gpp' }] });
  assert.doesNotMatch(bot.style.languageContext(), /capeknyo/);
  assert.match(bot.style.languageContext(), /emg/);
  bot.store.write('style_examples', { samples: [] });
  assert.equal(bot.style.languageContext(), '');
  await bot.ask('jid', 'lagi apa');
  assert.match(requests.at(-1).system, /Belum ada gaya impor/);
  assert.match(requests.at(-1).system, /Kata ganti tetap aku\/kamu/);
});
