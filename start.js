import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { saveTrainingExample } from "./db.js";

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const HISTORY_FILE = path.join(DATA_DIR, "chat_history.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");
const TRAINING_FILE = path.join(DATA_DIR, "training_examples.json");
const startedAt = Date.now();

const state = {
  whatsapp: "starting",
  botProcess: "starting",
  inboundSession: 0,
  proactiveSession: 0,
  errorsSession: 0,
  lastActivity: null,
  logs: [],
  restartCount: 0,
};

let bot;
let botGeneration = 0;
let restarting = false;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function addLog(level, text) {
  const clean = String(text).trim();
  if (!clean) return;
  state.logs.unshift({ time: Date.now(), level, text: clean });
  state.logs = state.logs.slice(0, 160);

  if (clean.includes("WhatsApp tersambung. Arnel online.")) state.whatsapp = "online";
  if (clean.includes("Koneksi tertutup.")) state.whatsapp = "offline";
  if (clean.includes("Mencoba menyambung ulang")) state.whatsapp = "reconnecting";
  if (clean.includes("Scan QR ini")) state.whatsapp = "needs_qr";
  if (clean.includes("[masuk]")) {
    state.inboundSession += 1;
    state.lastActivity = Date.now();
  }
  if (clean.includes("[inisiatif]")) {
    state.proactiveSession += 1;
    state.lastActivity = Date.now();
  }
  if (level === "error" || clean.includes("Gagal ")) state.errorsSession += 1;
}

function attachStream(stream, level, writer) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    writer.write(chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) addLog(level, line);
  });
  stream.on("end", () => {
    if (buffer) addLog(level, buffer);
  });
}

function spawnBot() {
  const generation = ++botGeneration;
  state.botProcess = "starting";
  state.whatsapp = "starting";

  const child = spawn(process.execPath, ["index.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  bot = child;
  state.botProcess = "running";
  attachStream(child.stdout, "info", process.stdout);
  attachStream(child.stderr, "error", process.stderr);

  child.on("exit", (code, signal) => {
    if (generation !== botGeneration) return;
    state.botProcess = "stopped";
    state.whatsapp = "offline";
    addLog("error", `Bot berhenti code=${code ?? "?"} signal=${signal ?? "?"}`);
  });

  child.on("error", (error) => {
    if (generation !== botGeneration) return;
    state.botProcess = "error";
    state.whatsapp = "offline";
    addLog("error", `Gagal menjalankan bot: ${error.message}`);
  });
}

async function restartBot() {
  if (restarting) return false;
  restarting = true;
  state.restartCount += 1;
  addLog("info", "Restart Arnel diminta dari dashboard");

  const previous = bot;
  if (previous && !previous.killed && previous.exitCode === null) {
    previous.kill("SIGINT");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1800);
      previous.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (previous.exitCode === null && !previous.killed) previous.kill("SIGTERM");
  }

  spawnBot();
  restarting = false;
  return true;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function persistentStats() {
  const history = loadJson(HISTORY_FILE, {});
  const since = startOfToday();
  let incomingToday = 0;
  let outgoingToday = 0;
  let totalMessages = 0;

  for (const messages of Object.values(history)) {
    if (!Array.isArray(messages)) continue;
    totalMessages += messages.length;
    for (const item of messages) {
      if (!item?.createdAt || item.createdAt < since) continue;
      if (item.role === "user") incomingToday += 1;
      if (item.role === "assistant") outgoingToday += 1;
    }
  }
  return { incomingToday, outgoingToday, totalMessages };
}

function memorySnapshot(limit = 8) {
  const data = loadJson(MEMORY_FILE, {});
  const rows = [];
  for (const [chatId, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      rows.push({
        chatId,
        content: item.content || "",
        uses: item.uses || 1,
        updatedAt: item.updatedAt || item.createdAt || 0,
      });
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function trainingSnapshot(limit = 8) {
  const rows = loadJson(TRAINING_FILE, []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((item) => ({
      input: item.input || "",
      output: item.output || "",
      source: item.source || "unknown",
      uses: item.uses || 1,
      createdAt: item.updatedAt || item.createdAt || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function historySnapshot(limit = 18) {
  const data = loadJson(HISTORY_FILE, {});
  const rows = [];

  for (const [chatId, messages] of Object.entries(data)) {
    if (!Array.isArray(messages)) continue;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== "assistant") continue;
      let userIndex = i - 1;
      while (userIndex >= 0 && messages[userIndex]?.role !== "user") userIndex -= 1;
      if (userIndex < 0) continue;
      rows.push({
        chatId,
        input: messages[userIndex].content || "",
        output: messages[i].content || "",
        createdAt: messages[i].createdAt || messages[userIndex].createdAt || 0,
      });
      i = userIndex;
    }
  }

  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function snapshot() {
  const cpus = os.cpus();
  const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024);
  return {
    whatsapp: state.whatsapp,
    proactiveSession: state.proactiveSession,
    uptimeMs: Date.now() - startedAt,
    stats: persistentStats(),
    system: {
      hostname: os.hostname(),
      cpu: cpus[0]?.model || "unknown",
      totalMemoryMb,
      freeMemoryMb,
    },
    memories: memorySnapshot(),
    training: trainingSnapshot(),
    history: historySnapshot(),
    logs: state.logs,
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) throw new Error("request terlalu besar");
  }
  return body ? JSON.parse(body) : {};
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arnel Dashboard</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#17181b;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:auto;padding:28px 18px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.topright{display:flex;align-items:center;gap:10px}.title h1{margin:0;font-size:29px}.title p{margin:6px 0 0;color:#6d7178;font-size:14px}.pill{border:1px solid #d4d7dc;background:#fff;padding:8px 13px;border-radius:999px;font-size:13px;font-weight:650}.online{color:#087a37;border-color:#a8ddbd;background:#eaf8ef}.offline,.stopped,.error{color:#a22626;border-color:#efbaba;background:#fff0f0}.reconnecting,.starting,.needs_qr{color:#8a5a00;border-color:#ead39b;background:#fff8df}.btn{border:1px solid #c7cbd1;background:#fff;color:#1b1c20;padding:8px 13px;border-radius:10px;cursor:pointer;font-weight:650}.btn:hover{background:#f0f1f3}.btn.good{color:#087a37;border-color:#a8ddbd;background:#f2fbf5}.btn.teach{color:#245fb5;border-color:#b8cae8;background:#f3f7fd}.btn.small{font-size:11px;padding:6px 9px}.btn:disabled{opacity:.5;cursor:not-allowed}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px}.card{background:#fff;border:1px solid #dfe2e6;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,.03)}.label{font-size:12px;color:#777c84;margin-bottom:9px}.value{font-size:24px;font-weight:750}.section{margin-top:14px}.system{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}.mini{padding:13px;background:#f6f7f8;border:1px solid #eceef0;border-radius:11px}.mini b{display:block;margin-top:5px;font-size:13px;font-weight:650}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.list{max-height:330px;overflow:auto}.item{padding:12px 0;border-bottom:1px solid #eceef0}.item:last-child{border-bottom:0}.itemmeta{font-size:11px;color:#8a8f96;margin-bottom:5px}.itemtext{font-size:13px;line-height:1.45;word-break:break-word}.arrow{color:#969aa0;padding:4px 0}.history{max-height:560px;overflow:auto}.exchange{padding:14px;border:1px solid #e3e6ea;background:#fafbfc;border-radius:12px;margin-bottom:10px}.bubble{padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word}.user{background:#edf3ff;border:1px solid #dce7fa}.arnel{background:#f2f7f3;border:1px solid #dce9df;margin-top:7px}.who{font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;color:#747981;margin-bottom:4px}.actions{display:flex;gap:7px;margin-top:9px}.logs{height:300px;overflow:auto;background:#f7f8f9;border:1px solid #e5e7ea;border-radius:11px;padding:13px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.line{margin-bottom:5px;word-break:break-word}.time{color:#91959b}.err{color:#b42323}.empty{color:#8b9097;font-size:13px;padding:6px 0}.toast{position:fixed;right:20px;bottom:20px;background:#202225;color:white;padding:11px 15px;border-radius:10px;opacity:0;pointer-events:none;transition:.2s}.toast.show{opacity:1}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}.system,.twocol{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.topright{width:100%;justify-content:space-between}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title"><h1>Arnel</h1><p>WhatsApp bot control dashboard</p></div>
    <div class="topright"><button id="restart" class="btn">Restart Arnel</button><div id="status" class="pill starting">starting</div></div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Uptime dashboard</div><div id="uptime" class="value">-</div></div>
    <div class="card"><div class="label">Incoming today</div><div id="todayIn" class="value">0</div></div>
    <div class="card"><div class="label">Outgoing today</div><div id="todayOut" class="value">0</div></div>
    <div class="card"><div class="label">Proactive this session</div><div id="proactive" class="value">0</div></div>
  </div>

  <div class="card section"><div class="label">Debian system</div><div class="system">
    <div class="mini"><span class="label">Hostname</span><b id="host">-</b></div>
    <div class="mini"><span class="label">CPU</span><b id="cpu">-</b></div>
    <div class="mini"><span class="label">Memory</span><b id="memory">-</b></div>
  </div></div>

  <div class="card section"><div class="label">Chat history trainer</div><div id="history" class="history"></div></div>

  <div class="twocol">
    <div class="card"><div class="label">Recent memories</div><div id="memories" class="list"></div></div>
    <div class="card"><div class="label">Recent training</div><div id="training" class="list"></div></div>
  </div>

  <div class="card section"><div class="label">Live logs</div><div id="logs" class="logs">belum ada log</div></div>
</div>
<div id="toast" class="toast"></div>
<script>
const $=id=>document.getElementById(id);
function uptime(ms){let s=Math.floor(ms/1000),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d+'d '+h+'h '+m+'m '+(s%60)+'s'}
function esc(s){let d=document.createElement('div');d.textContent=s??'';return d.innerHTML}
function when(ms){return ms?new Date(ms).toLocaleString():'-'}
function toast(text){let t=$('toast');t.textContent=text;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}
function memoryHtml(rows){if(!rows.length)return '<div class="empty">belum ada memory</div>';return rows.map(x=>'<div class="item"><div class="itemmeta">uses '+x.uses+' · '+esc(when(x.updatedAt))+'</div><div class="itemtext">'+esc(x.content)+'</div></div>').join('')}
function trainingHtml(rows){if(!rows.length)return '<div class="empty">belum ada training</div>';return rows.map(x=>'<div class="item"><div class="itemmeta">'+esc(x.source)+' · uses '+x.uses+'</div><div class="itemtext">'+esc(x.input)+'</div><div class="arrow">↓</div><div class="itemtext">'+esc(x.output)+'</div></div>').join('')}
function historyHtml(rows){if(!rows.length)return '<div class="empty">belum ada chat history</div>';return rows.map((x,i)=>'<div class="exchange"><div class="itemmeta">'+esc(when(x.createdAt))+'</div><div class="bubble user"><div class="who">You</div>'+esc(x.input)+'</div><div class="bubble arnel"><div class="who">Arnel</div>'+esc(x.output)+'</div><div class="actions"><button class="btn good small" onclick="trainGood('+i+')">Good</button><button class="btn teach small" onclick="trainTeach('+i+')">Teach</button></div></div>').join('')}
let lastData={history:[]};
async function train(row,output,source){let r=await fetch('/api/train',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:row.chatId,input:row.input,output,source})});let x=await r.json();if(!r.ok)throw new Error(x.error||'gagal training');toast(source==='good'?'disimpan sebagai good':'jawaban baru disimpan');await refresh()}
async function trainGood(i){try{let x=lastData.history[i];if(x)await train(x,x.output,'good')}catch(e){alert(e.message)}}
async function trainTeach(i){let x=lastData.history[i];if(!x)return;let desired=prompt('Arnel seharusnya jawab apa?',x.output);if(!desired||!desired.trim())return;try{await train(x,desired.trim(),'teach')}catch(e){alert(e.message)}}
async function refresh(){try{let r=await fetch('/api/status',{cache:'no-store'}),x=await r.json();lastData=x;$('uptime').textContent=uptime(x.uptimeMs);$('todayIn').textContent=x.stats.incomingToday;$('todayOut').textContent=x.stats.outgoingToday;$('proactive').textContent=x.proactiveSession;$('host').textContent=x.system.hostname;$('cpu').textContent=x.system.cpu;$('memory').textContent=(x.system.totalMemoryMb-x.system.freeMemoryMb)+' / '+x.system.totalMemoryMb+' MB';$('history').innerHTML=historyHtml(x.history);$('memories').innerHTML=memoryHtml(x.memories);$('training').innerHTML=trainingHtml(x.training);let s=$('status');s.textContent=x.whatsapp;s.className='pill '+x.whatsapp;$('logs').innerHTML=x.logs.length?x.logs.map(l=>'<div class="line '+(l.level==='error'?'err':'')+'"><span class="time">['+new Date(l.time).toLocaleTimeString()+']</span> '+esc(l.text)+'</div>').join(''):'belum ada log'}catch(e){let s=$('status');s.textContent='dashboard disconnected';s.className='pill offline'}}
$('restart').addEventListener('click',async()=>{if(!confirm('Restart Arnel sekarang?'))return;let b=$('restart');b.disabled=true;b.textContent='Restarting...';try{await fetch('/api/restart',{method:'POST'});setTimeout(refresh,500)}finally{setTimeout(()=>{b.disabled=false;b.textContent='Restart Arnel'},1800)}});
refresh();setInterval(refresh,2500);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (req.url === "/api/restart" && req.method === "POST") {
    try {
      const restarted = await restartBot();
      res.writeHead(restarted ? 200 : 409, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: restarted }));
    } catch (error) {
      addLog("error", `Gagal restart dari dashboard: ${error.message}`);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.url === "/api/train" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const chatId = String(body.chatId || "").trim();
      const input = String(body.input || "").trim();
      const output = String(body.output || "").trim();
      const source = body.source === "good" ? "good" : "teach";
      if (!chatId || !input || !output) throw new Error("data training tidak lengkap");
      saveTrainingExample(chatId, input, output, source);
      addLog("info", `[dashboard trainer] ${source}: ${input.slice(0, 60)}`);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

spawnBot();
server.listen(PORT, HOST, () => console.log(`Dashboard aktif di http://localhost:${PORT}`));

function shutdown(signal) {
  console.log(`Menerima ${signal}, menghentikan dashboard dan bot...`);
  server.close(() => process.exit(0));
  if (bot && !bot.killed) bot.kill("SIGINT");
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
