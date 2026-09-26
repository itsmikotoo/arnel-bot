import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/storage.js';
import { Scheduler, similarProactive } from '../src/scheduler.js';
const now = Date.UTC(2026, 8, 27, 1);
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.write('proactive_state', { awaitingReply: false, lastActivityAt: now - 7200000, nextIdleAt: now - 1, nextRandomAt: now - 1 });
  const sent = [];
  const args = { store, config: { proactive: true, times: [], dailyMax: 5, gapMinutes: 1, recentMinutes: 1 }, logger: { info() {}, error() {} }, target: async () => 'jid', lock: async (_jid, job) => job(), generate: async () => 'tadi denger suara kucing dari luar', send: async (_jid, text) => { sent.push(text); return text; }, ...extra };
  return { store, sent, args, scheduler: new Scheduler(args) };
}
test('one unanswered initiative blocks later slots, next day and restart; any reply releases it', async t => {
  const { scheduler, args, store, sent } = fixture(t);
  await scheduler.tick(now);
  assert.equal(sent.length, 1);
  const restarted = new Scheduler({ ...args, store: new Store(store.dir), generate: async () => 'baru nemu lagu yang pernah kamu bahas' });
  await restarted.tick(now + 86400000);
  assert.equal(sent.length, 1);
  restarted.activity(now + 86400001);
  await restarted.tick(now + 86400001 + 7 * 3600000);
  assert.equal(sent.length, 2);
  assert.equal(new Store(store.dir).read('proactive_state', {}).awaitingReply, true);
});
test('near duplicate is regenerated once with a different theme; persistent repeats are skipped', async t => {
  const original = 'tadi sempet ketiduran pas baca rangkuman biokimia tau tau udah sore aja';
  const repeat = 'tadi sempet ketiduran sebentar pas baca rangkuman biokimia || tau tau udah sore aja';
  assert.equal(similarProactive(original, repeat), true);
  let calls = 0;
  const { scheduler, store, sent } = fixture(t, { generate: async () => ++calls === 1 ? repeat : 'kayaknya hujan bentar lagi, suara genteng tetangga udah rame' });
  store.update('proactive_state', {}, s => { s.recent = [{ text: original, sentAt: now - 86400000 }]; });
  await scheduler.tick(now);
  assert.equal(calls, 2);
  assert.equal(sent.length, 1);
  scheduler.activity(now + 1);
  scheduler.generate = async () => { calls++; return sent[0]; };
  await scheduler.tick(now + 7 * 3600000);
  await scheduler.tick(now + 7 * 3600000 + 30000);
  assert.equal(calls, 4);
  assert.equal(sent.length, 1);
});
test('user reply during generation cancels proactive send', async t => {
  const { scheduler, sent } = fixture(t);
  scheduler.generate = async () => { scheduler.activity(now + 1); return 'pesan baru'; };
  await scheduler.tick(now);
  assert.equal(sent.length, 0);
});
test('ambiguous send failure remains blocked across restart', async t => {
  const { scheduler, store, args, sent } = fixture(t, { send: async () => { throw new Error('connection closed'); } });
  await assert.rejects(scheduler.tick(now), /connection closed/);
  await new Scheduler({ ...args, store: new Store(store.dir) }).tick(now + 86400000);
  assert.equal(sent.length, 0);
  assert.equal(store.read('proactive_state', {}).awaitingReply, true);
});
test('upgrade infers unanswered proactive from old state and chat history', t => {
  const { store, args } = fixture(t);
  store.write('proactive_state', { lastProactiveAt: now });
  store.write('chat_history', { jid: [{ role: 'user', content: 'oke', createdAt: now - 10000 }] });
  new Scheduler(args);
  assert.equal(store.read('proactive_state', {}).awaitingReply, true);
});
