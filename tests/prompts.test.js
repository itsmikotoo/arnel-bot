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
  db.saveArnelStory("owner", "gw lagi nyiapin camilan fiksi kemarin sore");
  db.saveConversationNote("owner", "user", "besok ujian fisika", { at: Date.now() });
  db.saveConversationNote("other", "user", "besok ujian kimia rahasia", { at: Date.now() });
  const prompt = buildSystemInstruction("owner", "udh pulang ini");
  const proactive = buildSystemInstruction("owner", "udh pulang ini", { proactive: true });
  assert.ok(prompt.includes("gw lagi nyiapin camilan fiksi kemarin sore"));
  assert.ok(!proactive.includes("gw lagi nyiapin camilan fiksi kemarin sore"));
  assert.ok(proactive.includes('"pesan_sebelumnya":"udh pulang ini"'));
  assert.ok(prompt.includes('"pesan_sebelumnya":"udh pulang ini"'));
  assert.ok(prompt.includes('"gaya_saja_tanpa_konteks":"contoh ritme lama"'));
  assert.ok(prompt.includes("arnel: oalah"));
  assert.ok(prompt.includes("jangan paksa pertanyaan"));
  assert.ok(prompt.includes("Beberapa balasan terakhir sudah bertanya"));
  assert.ok(!prompt.includes("other chat private example"));
  for (const rendered of [prompt, proactive]) {
    assert.ok(rendered.includes('"status":"planned"'));
    assert.ok(rendered.includes('besok ujian fisika'));
    assert.ok(!rendered.includes('ujian kimia rahasia'));
  }
  db.saveTrainingExample("owner", "pagi nel", "pagi juga || tumben udah bangun jam segini", "teach");
  const greeting = buildSystemInstruction("owner", "pagi nel", { now: Date.parse("2026-09-13T06:03:00Z") });
  assert.ok(greeting.includes("Pesan ini hanya sapaan"));
  assert.ok(!greeting.includes("arnel: pagi juga || tumben udah bangun jam segini"));
  assert.ok(greeting.includes("Waktu lokal sekarang"));
  const initiated = buildSystemInstruction("owner", "pagi nel", { proactive: true });
  assert.ok(!initiated.includes("Pesan ini hanya sapaan"));
  db.saveTrainingExample("owner", "udah kelar nunggu eps baru", "wah cepet juga udah kelar", "teach");
  db.saveTrainingExample("owner", "udah kelar nunggu eps baru", "seru ya ngikutin dua itu sekaligus", "good");
  db.saveBehaviorRule("owner", "pakai wah sebagai pembuka");
  for (const proactive of [false, true]) {
    const revised = buildSystemInstruction("owner", "udah kelar nunggu eps baru", { proactive });
    assert.ok(!revised.includes("arnel: wah cepet juga udah kelar"));
    assert.ok(!revised.includes("arnel: seru ya ngikutin dua itu sekaligus"));
    assert.ok(revised.indexOf("Preferensi terbaru pemilik") > revised.indexOf("pakai wah sebagai pembuka"));
    assert.ok(revised.includes("Sudah selesai menonton tidak berarti cepat selesai"));
  }
  assert.equal(fs.readFileSync(stylePath, "utf8"), styleData);
});
