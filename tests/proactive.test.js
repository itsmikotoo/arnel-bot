import test from "node:test";
import assert from "node:assert/strict";
import { buildProactivePrompt, recentInitiatives, proactiveDecision, repeatedInitiative } from "../proactive.js";

test("rejects the repeated snack-plan paraphrase reported by the user", () => {
  const prior = [{ content: "lagi mau bikin camilan nih mau nitip sesuatu ga" }];
  assert.equal(repeatedInitiative("mau lanjut bikin camilan yang kemarin sempat tertunda", prior), true);
  assert.equal(repeatedInitiative("mau nyoba resep kue lagi", prior), true);
  assert.equal(repeatedInitiative("nemu lagu yg enak buat nemenin malem", prior), false);
});

test("blocks lexical repetition but does not equate every short greeting", () => {
  assert.equal(repeatedInitiative("masih kepikiran film ending aneh itu", [{content:"film itu ending aneh masih kepikiran"}]), true);
  assert.equal(repeatedInitiative("pagi", [{content:"pagi"}]), true);
  assert.equal(repeatedInitiative("pagi", [{content:"malem"}]), false);
});

test("skip sentinel and new incoming activity never become proactive sends", () => {
  assert.equal(proactiveDecision("__SKIP__", [], 1, 1), "skip");
  assert.equal(proactiveDecision("", [], 1, 1), "skip");
  assert.equal(proactiveDecision("halo", [], 1, 2), "new_activity");
  assert.equal(proactiveDecision("halo", [], 1, 1), "send");
});

test("recent proactive records persist across days, expire after 24 hours and recover legacy state", () => {
  const now = Date.UTC(2026, 8, 10, 0);
  const state = {lastProactiveAt:now-3600000,recentMessages:[{content:"lama",createdAt:now-25*3600000}]};
  const history = [{role:"assistant",content:"bikin camilan",createdAt:now-3600000+1000}];
  assert.deepEqual(recentInitiatives(state, history, now).map((item)=>item.content), ["bikin camilan"]);
  assert.deepEqual(recentInitiatives({}, history, now), []);
});

test("proactive prompt includes dates, distinguishes plans from facts and permits silence", () => {
  const now = Date.UTC(2026, 8, 10);
  const prompt = buildProactivePrompt([{role:"assistant",content:"mau bikin kue",createdAt:now-86400000}], [], now);
  assert.ok(prompt.includes("2026-09-09T00:00:00.000Z"));
  assert.ok(prompt.includes("2026-09-10T00:00:00.000Z"));
  assert.ok(prompt.includes("Jangan mengubah rencana menjadi kejadian"));
  assert.ok(prompt.includes("__SKIP__"));
});
