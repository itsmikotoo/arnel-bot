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
  assert.equal(await trainer('!teach abis ngapain', 'jid', { memory, relationship, life }), 'nah gitu ya || gw inget');
  assert.equal(memory.exchange('jid').output, 'abis ngapain');
  assert.equal(memory.training('jid', 'capek')[0].output, 'abis ngapain');
  assert.match(await trainer('!life stage accepted', 'jid', { memory, relationship, life }), /diterima/);
  assert.equal(life.get().stage, 'accepted');
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
