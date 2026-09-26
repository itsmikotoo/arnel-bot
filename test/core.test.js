import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage.js';
import { Life } from '../src/life.js';
import { Memory } from '../src/memory.js';
import { Relationship } from '../src/relationship.js';
import { trainer } from '../src/trainer.js';
import { Gemini, toGeminiHistory } from '../src/gemini.js';
import { allowed, incoming } from '../src/whatsapp.js';
import { Story } from '../src/story.js';
import { arnelPronouns } from '../src/voice.js';
import { Bot, splitReply, isShortAnswerToQuestion, startsWithBareQuestion, styleIssue, useLightReading } from '../src/bot.js';
import { CORRECTION_RULE, LIGHT_READING_VARIANT } from '../src/persona.js';
import { ImageSearch, extractImageRequest, safeQuery, selectPhoto } from '../src/image-search.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}
test('life state advances over months, survives restart, and manual stage wins', t => {
  const store = fixture(t), life = new Life(store), start = Date.UTC(2026, 8, 1);
  assert.equal(life.advance(start).stage, 'preparation');
  assert.equal(life.advance(start + 119 * 86400000).stage, 'preparation');
  assert.equal(life.advance(start + 120 * 86400000).stage, 'awaiting');
  assert.equal(life.advance(start + 155 * 86400000).stage, life.advance(start + 155 * 86400000).stage);
  life.setStage('med_student', 'manual', start + 160 * 86400000);
  assert.equal(new Life(new Store(store.dir)).advance(start + 300 * 86400000).stage, 'med_student');
});
test('trainer correction persists and avoids stale last assistant', async t => {
  const store = fixture(t), memory = new Memory(store), relationship = new Relationship(store), life = new Life(store);
  memory.addMessage('jid', 'user', 'capek'); memory.addMessage('jid', 'assistant', 'semangat ya');
  assert.equal(await trainer('!teach abis ngapain', 'jid', { memory, relationship, life }), 'nah gitu ya || aku inget');
  assert.equal(memory.exchange('jid').output, 'abis ngapain');
  assert.equal(memory.training('jid', 'capek')[0].output, 'abis ngapain');
  assert.match(await trainer('!life stage accepted', 'jid', { memory, relationship, life }), /diterima/);
  assert.equal(life.get().stage, 'accepted');
});
test('Arnel keeps aku/kamu despite imported slang and preserves unrelated words', () => {
  assert.deepEqual(splitReply('gw lulus kedokteran ui || traktirannya jangan lu tagih ya'), ['aku lulus kedokteran ui', 'traktirannya jangan kamu tagih ya']);
  assert.equal(arnelPronouns('Gue mau cerita ke elu, bukan soal lulus'), 'Aku mau cerita ke kamu, bukan soal lulus');
});
test('short answer to Arnel question gets a reaction before any follow-up', async t => {
  const store = fixture(t), memory = new Memory(store), life = new Life(store);
  memory.addMessage('jid', 'assistant', 'lagi ngapain nih?');
  assert.equal(isShortAnswerToQuestion('lagi ngedit', memory.history('jid')), true);
  assert.equal(startsWithBareQuestion('ngedit apaan tuh, project?'), true);
  assert.equal(startsWithBareQuestion('ngedit apaan'), true);
  assert.equal(startsWithBareQuestion('serius bener kayaknya'), true);
  assert.equal(startsWithBareQuestion('oh pantes sepi, ngedit apaan?'), false);
  const prompts = [], outputs = ['ngedit apaan tuh, project?', 'oh pantes sepi || lagi ngedit apa emangnya?'];
  const bot = new Bot({ config: {}, logger: { info() {}, warn() {}, debug() {} }, store, memory, relationship: { context: () => '' }, life, story: { active: () => [] }, style: { examples: () => [] }, gemini: { generate: async request => { prompts.push(request.system); return outputs.shift(); } } });
  assert.equal(await bot.ask('jid', 'lagi ngedit'), 'oh pantes sepi || lagi ngedit apa emangnya?');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Mulai dengan komentar personal/);
});
test('style check catches repeated structure and echo, but allows an isolated casual ending', () => {
  const last = [{ role: 'assistant', content: 'oh video, dikira modifikasi beneran, tapi seru sih' }];
  assert.equal(styleIssue('ohh, pasti keren nanti, tapi cocok sih', last, 'oke'), 'rumus asumsi dan penutup berulang');
  assert.equal(styleIssue('boleh juga tuh', last, 'oke'), '');
  assert.equal(styleIssue('wah capek banget hari ini kamu', [], 'capek banget hari ini'), 'frasa template');
  assert.equal(styleIssue('capek banget hari ini ya kamu', [], 'capek banget hari ini'), 'mengulang kata user');
  assert.equal(styleIssue('itu wajar kok', [], 'aku kesel'), 'frasa template');
});
test('rare reading variation is sampled independently of message content and preserves facts', async t => {
  assert.equal(useLightReading(.035, () => .02), true);
  assert.equal(useLightReading(.035, () => .04), false);
  assert.match(LIGHT_READING_VARIANT, /jangan sengaja salah memahami/);
  assert.match(CORRECTION_RULE, /jangan memakai frasa pengakuan yang tetap/i);
  const store = fixture(t), memory = new Memory(store), life = new Life(store), prompts = [];
  const bot = new Bot({ config: { lightReadingChance: 1 }, logger: { info() {}, warn() {}, debug() {} }, store, memory, relationship: { context: () => '' }, life, story: { active: () => [] }, style: { examples: () => [] }, gemini: { generate: async request => { prompts.push(request.system); return 'iya, lanjut dulu'; } } });
  await bot.ask('jid', 'cerita tentang project');
  assert.match(prompts[0], /life state, dan story continuity/);
  await bot.ask('jid', 'Mulai chat duluan', null, { proactive: true });
  assert.doesNotMatch(prompts[1], /Untuk balasan ini, baca pesan secara santai/);
});
test('image directive is removed from chat, unsafe queries and mismatched photos are rejected', () => {
  assert.deepEqual(extractImageRequest('mirip ini\n[[search_image: kue lumpur kismis]]'), { text: 'mirip ini', query: 'kue lumpur kismis', requested: true });
  assert.deepEqual(extractImageRequest('sebentar aku cari fotonya dulu [[search_image: kue lumpur traditional]]'), { text: 'sebentar aku cari fotonya dulu', query: 'kue lumpur traditional', requested: true });
  assert.equal(extractImageRequest('kayak gini || [[search_image: kue lumpur]]').text, 'kayak gini');
  assert.equal(extractImageRequest('sebentar [[search_image: kue lumpur').text, 'sebentar');
  assert.equal(safeQuery('foto nude'), '');
  assert.equal(safeQuery('portrait of woman'), '');
  assert.equal(selectPhoto([{ src: { medium: 'https://images.pexels.com/a.jpeg' }, url: 'https://www.pexels.com/photo/foo/', alt: 'portrait of a cat' }], 'kue lumpur'), null);
  const lupis = { src: { medium: 'https://images.pexels.com/photos/1.jpeg' }, url: 'https://www.pexels.com/photo/delicious-indonesian-kue-lupis-with-tea-37104347/', alt: 'Delicious Indonesian Kue Lupis With Tea' };
  const lumpur = { src: { medium: 'https://images.pexels.com/photos/2.jpeg' }, url: 'https://www.pexels.com/photo/kue-lumpur-2/', alt: 'Traditional kue lumpur' };
  assert.equal(selectPhoto([lupis], 'kue lumpur traditional'), null);
  assert.equal(selectPhoto([lupis, lumpur], 'kue lumpur traditional'), lumpur);
});
test('when no matching photo exists, bot does not promise one or leak search marker', async t => {
  const store = fixture(t), sent = [];
  const bot = new Bot({ config: {}, logger: { warn() {} }, store, memory: new Memory(store), life: new Life(store), relationship: new Relationship(store), story: { track() {} }, imageSearch: { enabled: true, search: async () => null } });
  bot.ask = async () => 'sebentar aku cari fotonya dulu [[search_image: kue lumpur traditional]]';
  bot.send = async (_jid, text) => sent.push(text);
  await bot.reply({}, 'jid', 'mau lihat bentuknya', null);
  assert.deepEqual(sent, ['belum nemu foto referensi yang pas']);
});
test('Pexels search downloads a relevant photo within persistent separate quota', async t => {
  const store = fixture(t), calls = [];
  const photo = { src: { medium: 'https://images.pexels.com/photos/1.jpeg' }, url: 'https://www.pexels.com/photo/kue-1/', alt: 'kue lumpur dessert', photographer: 'Foto Maker' };
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (String(url).startsWith('https://api.pexels.com/')) return new Response(JSON.stringify({ photos: [photo] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(Uint8Array.of(255, 216, 255), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const config = { imageSearchKey: 'demo', imageDailyMax: 1, imageGapMinutes: 120, imageTimeoutMs: 5000 };
  const search = new ImageSearch(config, store, { warn() {} }, fetchFn, () => Date.UTC(2026, 8, 26, 10));
  const result = await search.search('kue lumpur');
  assert.equal(result.photographer, 'Foto Maker');
  assert.equal(result.buffer.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'demo');
  assert.equal(await new ImageSearch(config, new Store(store.dir), { warn() {} }, fetchFn, () => Date.UTC(2026, 8, 26, 10)).search('kue lumpur'), null);
  assert.equal(calls.length, 2);
});
test('transient image search retry counts toward daily API quota', async t => {
  const store = fixture(t), statuses = [503, 200], photo = { src: { medium: 'https://images.pexels.com/photos/1.jpeg' }, url: 'https://www.pexels.com/photo/kue-1/', alt: 'kue lumpur', photographer: 'P' };
  const fetchFn = async url => String(url).includes('api.pexels.com')
    ? new Response(JSON.stringify({ photos: [photo] }), { status: statuses.shift() })
    : new Response(Uint8Array.of(255, 216), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const config = { imageSearchKey: 'demo', imageDailyMax: 2, imageGapMinutes: 120, imageTimeoutMs: 5000 };
  const search = new ImageSearch(config, store, { warn() {} }, fetchFn, () => Date.UTC(2026, 8, 26, 10));
  assert.ok(await search.search('kue lumpur'));
  assert.equal(store.read('image_search_limits', {}).count, 2);
  assert.equal(await search.search('kue lumpur'), null);
});
test('bot sends optional reference image after text and keeps directive out of memory', async t => {
  const store = fixture(t), memory = new Memory(store), sent = [];
  const bot = new Bot({ config: {}, logger: { warn() {} }, store, memory, life: new Life(store), relationship: new Relationship(store), story: { track() {} }, imageSearch: { enabled: true, search: async () => ({ buffer: Buffer.from('photo'), photographer: 'P', url: 'https://www.pexels.com/photo/1/' }) }, wa: { socket: { sendMessage: async (_jid, content) => sent.push(content) } } });
  bot.ask = async () => 'kayak kue basah kecil\n[[search_image: kue lumpur]]';
  bot.send = async (_jid, text) => { sent.push({ text }); };
  await bot.reply({ key: { remoteJid: 'jid' } }, 'jid', 'kue lumpur kayak gimana', null);
  assert.equal(sent[0].text, 'kayak kue basah kecil');
  assert.equal(sent[1].image.toString(), 'photo');
  assert.match(sent[1].caption, /Pexels/);
  assert.equal(memory.history('jid').at(-1).content, '[foto referensi: kue lumpur; sumber: Pexels]');
  assert.equal(memory.history('jid').at(-1).media, 'image');
});
test('trainer correction still targets the text when the last assistant message was a photo', t => {
  const memory = new Memory(fixture(t));
  memory.addMessage('jid', 'user', 'kue apa itu');
  memory.addMessage('jid', 'assistant', 'kue lumpur');
  memory.addMessage('jid', 'assistant', '[foto referensi: kue lumpur]', 'image');
  assert.equal(memory.exchange('jid').output, 'kue lumpur');
  memory.correct('jid', 'contoh kue lumpur');
  assert.equal(memory.exchange('jid').output, 'contoh kue lumpur');
});
test('history merges adjacent messages with the same role for Gemini', () => {
  assert.deepEqual(toGeminiHistory([{ role: 'assistant', content: 'old' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), [{ role: 'user', parts: [{ text: 'a\nb' }] }]);
});
test('bad JSON is preserved and stops startup', t => {
  const store = fixture(t);
  fs.writeFileSync(store.file('memories'), '{broken');
  assert.throws(() => store.read('memories', {}), SyntaxError);
  assert.equal(fs.readFileSync(store.file('memories'), 'utf8'), '{broken');
});
test('Gemini retries transient HTTP and keeps the API key out of the URL', async () => {
  let calls = 0;
  const client = new Gemini({ apiKey: 'secret', model: 'demo', temperature: 1, outputTokens: 200, timeoutMs: 5000 }, { warn() {} }, async (url, options) => {
    calls++;
    assert.equal(url.includes('secret'), false);
    assert.equal(options.headers['x-goog-api-key'], 'secret');
    return calls === 1
      ? { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }
      : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'iya bentar' }] } }] }) };
  });
  assert.equal(await client.generate({ system: 'fiksi', parts: [{ text: 'hai' }] }), 'iya bentar');
  assert.equal(calls, 2);
});
test('WhatsApp accepts alternate phone JID and reads quoted context', () => {
  const msg = { key: { remoteJid: '12345@lid', remoteJidAlt: '6281234567890@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'iya', contextInfo: { quotedMessage: { conversation: 'sudah makan?' } } } } };
  assert.equal(allowed(msg, '6281234567890'), true);
  assert.match(incoming(msg).text, /membalas pesan: sudah makan/);
  assert.equal(allowed(msg, '6280000000000'), false);
});
test('in-place upgrade keeps v2 story notes without overwriting them', t => {
  const store = fixture(t);
  store.write('arnel_story_notes', { jid: [{ content: 'gw tadi nyobain resep cookies baru', createdAt: Date.now() }] });
  const story = new Story(store);
  assert.equal(story.active('jid', 'cookies', 'preparation').length, 1);
  assert.equal(store.read('arnel_story_notes', {}).jid.length, 1);
});
