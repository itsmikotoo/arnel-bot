import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("production prompt loads old and paired imports together with owner corrections and recent history", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arnel-prompt-test-"));
  const previousDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stylePath = path.join(dir, "style_examples.json");
  const styleData = JSON.stringify({ samples: [
    { content: "contoh ritme lama", importedAt: 123 },
    { input: "udh pulang ini", content: "oalah udh balik toh", importedAt: 456 },
  ] });
  fs.writeFileSync(stylePath, styleData);
  const db = await import("../db.js");
  db.saveMessage("owner", "user", "lagi main");
  db.saveMessage("owner", "assistant", "main apaan");
  db.saveMessage("owner", "user", "biasa aja");
  db.saveMessage("owner", "assistant", "udah makan belum");
  db.saveTrainingExample("owner", "udh pulang ini", "oalah", "teach");
  db.saveTrainingExample("other", "udh pulang ini", "other chat private example", "teach");
  db.saveBehaviorRule("owner", "jangan paksa pertanyaan");
  const { buildSystemInstruction } = await import("../prompts.js");
  const prompt = buildSystemInstruction("owner", "udh pulang ini");
  assert.ok(prompt.includes('"pesan_sebelumnya":"udh pulang ini"'));
  assert.ok(prompt.includes('"gaya_saja_tanpa_konteks":"contoh ritme lama"'));
  assert.ok(prompt.includes("arnel: oalah"));
  assert.ok(prompt.includes("jangan paksa pertanyaan"));
  assert.ok(prompt.includes("Beberapa balasan terakhir sudah bertanya"));
  assert.ok(!prompt.includes("other chat private example"));
  assert.equal(fs.readFileSync(stylePath, "utf8"), styleData);
});
