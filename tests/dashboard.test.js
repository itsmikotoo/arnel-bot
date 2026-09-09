import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arnel-dashboard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(dir, name, value) { fs.writeFileSync(path.join(dir, name), JSON.stringify(value)); }
function readDb(dir) {
  const code = `import * as d from './db.js'; console.log(JSON.stringify({history:d.getHistory('owner'),memories:d.getDashboardMemories(),training:d.getDashboardTraining(),relationship:d.getDashboardRelationship('owner')}));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" }));
}
async function server(t, dir, dashboardOnly = true) {
  const child = spawn(process.execPath, ["start.js", ...(dashboardOnly ? ["--dashboard-only"] : [])], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dir, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_PORT: "0", GEMINI_API_KEY: "", CONNECTION_ONLY: "false", PROACTIVE_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error(`Dashboard timeout: ${output}`)), 15000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/Dashboard aktif di http:\/\/localhost:(\d+)/);
    if (match) resolveReady(`http://127.0.0.1:${match[1]}`);
  });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("error", rejectReady);
  child.once("exit", () => rejectReady(new Error(`Dashboard exited: ${output}`)));
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(killTimer);
    }
  });
  const url = await ready;
  clearTimeout(timer);
  return url;
}

test("dashboard JSON migration is idempotent and preserves original files", (t) => {
  const dir = temporary(t);
  const history = { owner: [{ role: "user", content: "halo", createdAt: 100 }, { role: "assistant", content: "woi", createdAt: 200 }] };
  json(dir, "chat_history.json", history);
  json(dir, "memories.json", { owner: [{ id: "old", content: "suka cookies", createdAt: 100 }] });
  json(dir, "training_examples.json", [{ chatId: "owner", input: "halo", output: "woi", createdAt: 100 }]);
  const first = readDb(dir);
  const second = readDb(dir);
  assert.equal(first.history.length, 2);
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "chat_history.json"))), history);
});

test("reconcile new JSON chats with existing dashboard SQLite without undoing newer state or old deletions", (t) => {
  const dir = temporary(t);
  json(dir, "chat_history.json", { owner: [{ role: "user", content: "lama", createdAt: 100 }] });
  readDb(dir);
  const db = new Database(path.join(dir, "arnel.sqlite3"));
  db.prepare("DELETE FROM meta WHERE key = 'legacy_json_reconciled_v2'").run();
  db.prepare("UPDATE meta SET value = '150' WHERE key = 'legacy_json_migrated_v1'").run();
  db.prepare("INSERT INTO messages(chat_id,role,content,created_at) VALUES ('owner','assistant','dari dashboard',250)").run();
  db.prepare("INSERT INTO relationships(chat_id,closeness,updated_at) VALUES ('owner',80,300)").run();
  db.close();
  json(dir, "chat_history.json", { owner: [{ role: "user", content: "lama", createdAt: 100 }, { role: "user", content: "dari natural chat", createdAt: 200 }] });
  json(dir, "relationship_state.json", { owner: { closeness: 25, updatedAt: 200 } });
  json(dir, "memories.json", { owner: [{ id: "deleted-old", content: "sudah dihapus di dashboard", createdAt: 100 }, { id: "new", content: "memori baru", createdAt: 200 }] });
  const result = readDb(dir);
  assert.equal(result.history.length, 3);
  assert.deepEqual(result.history.map((item) => item.createdAt), [100, 200, 250]);
  assert.ok(result.history.some((item) => item.content === "dari natural chat"));
  assert.ok(result.history.some((item) => item.content === "dari dashboard"));
  assert.equal(result.relationship.closeness, 80);
  assert.deepEqual(result.memories.map((item) => item.content), ["memori baru"]);
  assert.equal(readDb(dir).history.length, 3);
});

test("dashboard serves UI, history, shared memories and Teach; client script remains valid", { timeout: 25000 }, async (t) => {
  const dir = temporary(t);
  json(dir, "chat_history.json", { owner: [{ role: "user", content: "udh pulang", createdAt: 100 }, { role: "assistant", content: "langsung rebahan pasti", createdAt: 200 }] });
  json(dir, "style_examples.json", { samples: [{ input: "udh pulang", content: "oalah" }, { content: "lama" }] });
  const url = await server(t, dir);
  const html = await (await fetch(url)).text();
  assert.ok(html.includes("Arnel Control Center"));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes('/^\\d{2}:\\d{2}'));
  assert.ok(!script.includes('JSON.stringify(x.chatId)'));
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.database.engine, "SQLite (WAL)");
  assert.deepEqual(status.style, { total: 2, paired: 1 });
  const post = (route, body) => fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/memory", { action: "add", content: "suka cookies" })).status, 200);
  let brain = await (await fetch(`${url}/api/brain`)).json();
  assert.equal(brain.memories[0].content, "suka cookies");
  const exchange = brain.exchanges[0];
  assert.equal((await post("/api/train", { chatId: "owner", exchangeId: exchange.id, input: exchange.input, output: "oalah udh balik toh", source: "teach" })).status, 200);
  const history = await (await fetch(`${url}/api/history?q=oalah`)).json();
  assert.equal(history.rows[0].content, "oalah udh balik toh");
  const stored = readDb(dir);
  assert.equal(stored.training[0].output, "oalah udh balik toh");
  assert.equal(stored.memories[0].content, "suka cookies");
  assert.equal(stored.history.at(-1).content, "oalah udh balik toh");
  assert.equal((await post("/api/proactive", { proactiveEnabled: true, proactiveTimes: "99:99", proactiveDailyMax: 5 })).status, 500);
  const denied = await fetch(`${url}/api/memory`, { method: "POST", headers: { origin: "http://other.invalid", "content-type": "application/json" }, body: JSON.stringify({ action: "add", content: "foreign" }) });
  assert.equal(denied.status, 403);
  const memory = brain.memories[0];
  assert.equal((await post("/api/memory", { action: "delete", chatId: memory.chatId, id: memory.id })).status, 200);
  assert.equal(readDb(dir).memories.length, 0);
});

test("dashboard remains available when launched bot exits for missing API key", { timeout: 25000 }, async (t) => {
  const dir = temporary(t);
  const url = await server(t, dir, false);
  let status;
  for (let index = 0; index < 100; index += 1) {
    status = await (await fetch(`${url}/api/status`)).json();
    if (status.botProcess === "stopped") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.botProcess, "stopped");
  assert.ok(status.logs.some((item) => item.text.includes("GEMINI_API_KEY belum diisi")));
  assert.equal((await fetch(url)).status, 200);
});

test("history pagination follows timestamps after migration even when insertion order differs", (t) => {
  const dir = temporary(t);
  json(dir, "chat_history.json", { owner: Array.from({ length: 25 }, (_, index) => ({ role: "user", content: `pesan ${index}`, createdAt: 100 + (24 - index) })) });
  const code = `import {getDashboardHistory} from './db.js'; let pages=[],beforeId=null; do {let p=getDashboardHistory({limit:10,beforeId}); pages.push(p.rows.map(x=>x.createdAt)); beforeId=p.nextBeforeId; if(!p.hasMore)break;}while(beforeId); console.log(JSON.stringify(pages));`;
  const pages = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" }));
  assert.deepEqual(pages.map((page) => page.length), [10, 10, 5]);
  assert.deepEqual(pages.flat().sort((a,b)=>a-b), Array.from({length:25}, (_,index)=>100+index));
  assert.equal(pages[0].at(-1),124);
  assert.equal(pages[1].at(-1),114);
});
