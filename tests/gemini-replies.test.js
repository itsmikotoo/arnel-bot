import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { hasRejectedChatPattern } from "../style.js";

const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

function fixture(t, replies, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arnel-reply-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const messages = [];
  // Evaluate the actual request functions without starting WhatsApp or loading the database.
  const context = vm.createContext({
    fs, path, DATA_DIR: dir, GEMINI_MODEL: "test-model",
    process: { env }, hasRejectedChatPattern,
    getHistory: () => [], cleanHistory: value => value, MAX_HISTORY: 20,
    buildSystemInstruction: () => "test instruction",
    console: { log: message => messages.push(message) },
    fetchGeminiWithRetry: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      assert.ok(requests.length <= replies.length, "unexpected extra generation");
      return { ok: true, json: async () => ({
        candidates: [{ content: { parts: [{ text: replies[requests.length - 1] }] } }],
      }) };
    },
  });
  vm.runInContext(source.match(/^const GEMINI_TEMPERATURE = .*;$/m)[0], context);
  vm.runInContext(source.slice(source.indexOf("async function requestGemini("), source.indexOf("async function downloadImage(")), context);
  return {
    context, requests, messages,
    logs: () => fs.readFileSync(path.join(dir, "reply_log.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("clean reply is generated once and logged with multiline input and default temperature", async t => {
  const f = fixture(t, ["aku salah nangkep\nmaaf ya"]);
  assert.equal(await f.context.askGemini("chat-a", "bukan\naku di rumah"), "aku salah nangkep\nmaaf ya");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].generationConfig.temperature, 0.95);
  assert.deepEqual(f.messages, []);
  const [entry] = f.logs();
  assert.deepEqual(Object.keys(entry), ["timestamp", "chatId", "input", "output", "flaggedPattern"]);
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  assert.equal(entry.chatId, "chat-a");
  assert.equal(entry.input, "bukan\naku di rumah");
  assert.equal(entry.output, "aku salah nangkep\nmaaf ya");
  assert.equal(entry.flaggedPattern, false);
});

for (const retry of ["aku salah nangkep", "semoga besok lancar"]) {
  test(`flagged reply retries only once and returns retry unchanged: ${retry}`, async t => {
    const f = fixture(t, ["wah cepet juga", retry], { GEMINI_TEMPERATURE: "0.7" });
    assert.equal(await f.context.askGemini("chat-b", "udah kelar"), retry);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0], f.requests[1]);
    assert.equal(f.requests[1].generationConfig.temperature, 0.7);
    assert.deepEqual(f.messages, ["[gaya] reply kena filter, regenerate sekali"]);
    assert.deepEqual(f.logs().map(entry => [entry.output, entry.flaggedPattern]), [
      ["wah cepet juga", true], [retry, hasRejectedChatPattern(retry)],
    ]);
  });
}

test("shared request logging covers image and proactive responses without image bytes", async t => {
  const f = fixture(t, ["REACTION: 👀\nREPLY: itu kucing kamu", "udah selesai ujiannya"]);
  await f.context.requestGemini("chat-c", [{ text: "lihat foto" }, { inline_data: { data: "image-bytes" } }]);
  await f.context.requestGemini("chat-c", [{ text: "tindak lanjuti ujian" }], "ujian", { proactive: true });
  assert.deepEqual(f.logs().map(entry => entry.input), ["lihat foto", "tindak lanjuti ujian"]);
  assert.ok(!JSON.stringify(f.logs()).includes("image-bytes"));
});

test("additional stock phrases match normalized words without partial-word false positives", () => {
  for (const text of ["semangat ya", "yg penting kamu sehat", "aku di sini kok", "GPP, santai aja", "iya || semoga lancar", "iya\nSEMOGA lancar"]) {
    assert.equal(hasRejectedChatPattern(text), true, text);
  }
  for (const text of ["semangatin aku", "aku di sini", "yang penting filenya ketemu", "semogaku", "wahyu"]) {
    assert.equal(hasRejectedChatPattern(text), false, text);
  }
});
