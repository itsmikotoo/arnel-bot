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
