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
