import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextTurnQueue, deliverReplyParts } from '../text-turns.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let id = 0;
  const timers = new Map();
  return {
    setTimer(fn) { timers.set(++id, fn); return id; },
    clearTimer(key) { timers.delete(key); },
    flush() { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); },
  };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('messages arriving during generation replace the stale reply and retain both inputs in order', async () => {
  const time = clock();
  const generation = deferred();
  const inputs = [];
  const sent = [];
  const queue = createTextTurnQueue({ ...time, delayMs: 3500, onTurn: async (chat, batch, isCurrent) => {
    inputs.push(batch.map(item => item.text));
    if (inputs.length === 1) await generation.promise;
    return deliverReplyParts(['pantesan'], { isCurrent, beforeSend: async () => {}, send: async text => sent.push(text) });
  } });
  queue.push('owner', { text: 'tadi tidurnya juga jam 2' });
  time.flush();
  queue.push('owner', { text: 'jadinya sekalian tidur ampe siang' });
  time.flush();
  generation.resolve();
  await settle();
  assert.deepEqual(inputs, [['tadi tidurnya juga jam 2'], ['tadi tidurnya juga jam 2', 'jadinya sekalian tidur ampe siang']]);
  assert.deepEqual(sent, ['pantesan']);
  queue.close();
});

test('new input during typing cancels unsent bubbles; delivered input is not replayed', async () => {
  const time = clock();
  const sent = [];
  const inputs = [];
  let changed = false;
  const queue = createTextTurnQueue({ ...time, delayMs: 3500, onTurn: async (chat, batch, isCurrent) => {
    inputs.push(batch.map(item => item.text));
    return deliverReplyParts(changed ? ['oalah'] : ['pantesan', 'begadang nonton apa'], {
      isCurrent,
      beforeSend: async (part, index) => {
        if (index === 1 && !changed) {
          changed = true;
          queue.push('owner', { text: 'anime' });
          time.flush();
        }
      },
      send: async text => sent.push(text),
    });
  } });
  queue.push('owner', { text: 'tidur jam 2' }); time.flush();
  await settle();
  assert.deepEqual(sent, ['pantesan', 'oalah']);
  assert.deepEqual(inputs, [['tidur jam 2'], ['anime']]);
  queue.close();
});

test('initial debounce coalesces while unrelated chats and close do not leak work', async () => {
  const time = clock();
  const input = [];
  const queue = createTextTurnQueue({ ...time, delayMs: 3500, onTurn: async (chat, batch) => { input.push([chat, batch.map(item => item.text)]); } });
  queue.push('a', { text: 'satu' }); queue.push('a', { text: 'dua' }); queue.push('b', { text: 'lain' });
  time.flush(); await settle();
  assert.deepEqual(input, [['a', ['satu', 'dua']], ['b', ['lain']]]);
  queue.push('a', { text: 'stop' }); queue.close(); time.flush(); await settle();
  assert.equal(input.length, 2);
});

test('network failure after one delivered bubble reports only what was sent', async () => {
  await assert.rejects(deliverReplyParts(['satu', 'dua'], {
    isCurrent: () => true, beforeSend: async () => {},
    send: async (text, index) => { if (index === 1) throw new Error('offline'); },
  }), error => {
    assert.deepEqual(error.sentParts, ['satu']);
    assert.equal(error.turnDelivered, true);
    return true;
  });
});

test('failed obsolete generation retains inputs for the new turn without an infinite retry', async () => {
  const time = clock(); const wait = deferred(); const calls = []; const errors = [];
  const queue = createTextTurnQueue({ ...time, delayMs: 3500, onError: err => errors.push(err.message),
    onTurn: async (chat, batch) => {
      calls.push(batch.map(item => item.text));
      if (calls.length === 1) { await wait.promise; throw new Error('fetch failed'); }
    },
  });
  queue.push('a', { text: 'satu' }); time.flush();
  queue.push('a', { text: 'dua' }); time.flush(); wait.resolve(); await settle();
  assert.deepEqual(calls, [['satu'], ['satu', 'dua']]);
  assert.deepEqual(errors, ['fetch failed']); queue.close();
});
