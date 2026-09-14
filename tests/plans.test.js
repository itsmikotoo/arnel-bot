import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { asksForSpace, buildPlanLedger, followupCandidate, initiativeGate, localDay } from '../plans.js';
import { buildProactivePrompt } from '../proactive.js';

const previousTZ = process.env.TZ;
process.env.TZ = 'Asia/Jakarta';
test.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });

const start = Date.parse('2026-09-12T13:00:00Z'); // 20:00 Jakarta
const note = (id, content, role = 'user', createdAt = start) => ({ id, content, role, createdAt });

test('plans never become completed or delayed just because tomorrow arrived', () => {
  const ledger = buildPlanLedger([note(1, 'aku mau bikin camilan')], start + 8 * 86400000);
  assert.equal(ledger[0].status, 'past_unconfirmed');
  assert.equal(followupCandidate(ledger, start + 8 * 86400000), null);
});

test('explicit updates supersede only the same speaker and matching plan', () => {
  const notes = [note(1, 'aku mau bikin camilan'), note(2, 'aku udah bikin camilan', 'assistant', start + 1000)];
  assert.equal(buildPlanLedger(notes, start + 3000)[0].status, 'planned');
  notes.push(note(3, 'aku udah bikin tugas', 'user', start + 2000));
  assert.equal(buildPlanLedger(notes, start + 3000)[0].status, 'planned');
  notes.push(note(4, 'aku udah bikin camilan', 'user', start + 3000));
  const ledger = buildPlanLedger(notes, start + 3000);
  assert.equal(ledger[0].status, 'superseded');
  assert.equal(ledger.at(-1).status, 'reported_done');
});

test('questions, hypothetical plans and work preparing for an event are not completion evidence', () => {
  const notes = [note(1, 'besok ujian fisika'), note(2, 'aku udah belajar ujian fisika', 'user', start + 1000),
    note(3, 'udah ujian fisika?', 'user', start + 2000), note(4, 'kalau besok ujian matematika', 'user', start + 3000)];
  const ledger = buildPlanLedger(notes, start + 3000);
  assert.equal(ledger[0].status, 'planned');
  assert.equal(ledger.length, 2);
  for (const content of ['temenku besok ujian', 'kata rani besok ujian', 'kamu besok ujian']) {
    assert.equal(followupCandidate(buildPlanLedger([note(1, content)], start), start + 86400000), null);
  }
  assert.equal(buildPlanLedger([note(1, 'aku udah mau bikin camilan')], start)[0].status, 'planned');
  assert.equal(buildPlanLedger([note(1, 'aku udah mulai bikin camilan')], start)[0].status, 'reported_ongoing');
});

test('cancellations, postponements, negation and uncertain corrections do not become followups', () => {
  for (const update of ['ujian fisika gak jadi', 'besok ujian fisika tapi diundur', 'ujian fisika belum selesai']) {
    const ledger = buildPlanLedger([note(1, 'besok ujian fisika'), note(2, update, 'user', start + 1000)], start + 86400000);
    assert.equal(followupCandidate(ledger, start + 86400000), null, update);
  }
  const ledger = buildPlanLedger([note(1, 'aku mau bikin camilan'), note(2, 'aku mau bikin tugas', 'user', start + 1000), note(3, 'gak jadi', 'user', start + 2000)], start + 2000);
  assert.equal(ledger[0].status, 'uncertain_update'); // do not chase either ambiguous plan
  assert.equal(ledger[1].status, 'uncertain_update');
});

test('followups respect Jakarta day boundaries, evening threshold, expiry and consumption', () => {
  assert.equal(localDay(Date.parse('2026-09-12T18:00:00Z')), '2026-09-13');
  const ledger = buildPlanLedger([note(1, 'besok ujian fisika')], start);
  assert.equal(ledger[0].targetDay, '2026-09-13');
  assert.equal(followupCandidate(buildPlanLedger([note(2, 'hari ini ada ujian')], start), start)?.id, 2);
  assert.equal(followupCandidate(ledger, Date.parse('2026-09-13T01:00:00Z')), null);
  const evening = Date.parse('2026-09-13T12:00:00Z');
  assert.equal(followupCandidate(ledger, evening)?.id, 1);
  assert.equal(followupCandidate(ledger, start + 3 * 86400000), null);
  assert.equal(followupCandidate([{ ...ledger[0], followedAt: evening }], evening), null);
  const prompt = buildProactivePrompt([], [], evening, ledger[0]);
  assert.ok(prompt.includes('besok ujian fisika'));
  assert.ok(prompt.includes('Jangan menganggap acara selesai'));
});

test('waiting promises and unanswered initiative guard allow space until user returns', () => {
  for (const text of ['nanti aku kabarin', 'ntar gw kabarin', 'aku kabarin nanti', 'jangan chat dulu']) assert.equal(asksForSpace(text), true, text);
  for (const text of ['jangan tunggu aku kabarin', 'nanti kabarin aku', 'ujian besok']) assert.equal(asksForSpace(text), false, text);
  assert.equal(initiativeGate({ waitingForUser: 1 }), 'waiting_for_user');
  assert.equal(initiativeGate({ lastInitiativeAt: start, lastUserAt: start - 1 }, start + 86400000), 'unanswered_initiative');
  assert.equal(initiativeGate({ lastInitiativeAt: start, lastUserAt: start + 1 }, start + 7200000), null);
});

test('raw notes survive restart, stay chat-scoped, deduplicate and exclude forwarded plans', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-plans-'));
  const old = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const db = await import('../db.js');
  db.saveConversationNote('owner', 'user', 'besok ujian fisika', { at: start, sourceKey: 'one' });
  db.saveConversationNote('owner', 'user', 'besok ujian fisika', { at: start, sourceKey: 'one' });
  db.saveConversationNote('owner', 'user', 'besok ujian matematika', { at: start, sourceKey: 'forward', forwarded: true });
  db.saveConversationNote('other', 'user', 'besok ujian ekonomi', { at: start });
  db.saveConversationNote('owner', 'user', 'nanti aku kabarin', { at: start + 1000, sourceKey: 'pause' });
  assert.equal(db.getInitiativeContext('owner').waitingForUser, 1);
  db.saveConversationNote('owner', 'user', '!ingatan', { at: start + 2000 });
  assert.equal(db.getInitiativeContext('owner').waitingForUser, 1);
  const ledger = db.getConversationLedger('owner', start + 86400000);
  assert.equal(ledger.filter(n => /ujian/.test(n.content)).length, 1);
  const candidate = followupCandidate(ledger, start + 86400000);
  db.recordInitiativeSent('owner', candidate.id, start + 86400000);
  const script = `import {getConversationLedger,getInitiativeContext} from './db.js'; console.log(JSON.stringify({ledger:getConversationLedger('owner',${start + 86400000}),state:getInitiativeContext('owner')}));`;
  const persisted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' }));
  assert.equal(persisted.state.waitingForUser, 1);
  assert.equal(followupCandidate(persisted.ledger, start + 86400000), null);
  db.saveConversationNote('owner', 'user', 'udah balik nih', { at: start + 86400001, sourceKey: 'return' });
  assert.equal(db.getInitiativeContext('owner').waitingForUser, 0);
  db.saveConversationNote('owner', 'user', 'nanti aku kabarin', { at: start + 1000, sourceKey: 'pause' });
  assert.equal(db.getInitiativeContext('owner').waitingForUser, 0); // redelivery cannot re-arm pause
});
