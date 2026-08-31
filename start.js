import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  deleteMemory,
  getDashboardExchanges,
  getDashboardHistory,
  getDashboardMemories,
  getDashboardRelationship,
  getDashboardStats,
  getDashboardTraining,
  getDatabaseInfo,
  getPrimaryChatId,
  recordFeedback,
  saveMemory,
  saveTrainingExample,
} from "./db.js";

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SETTINGS_FILE = path.join(DATA_DIR, "dashboard_settings.json");
const startedAt = Date.now();

fs.mkdirSync(DATA_DIR, { recursive: true });

const state = {
  whatsapp: "starting",
  botProcess: "starting",
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

function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function currentSettings() {
  const saved = loadJson(SETTINGS_FILE, {});
  return {
    proactiveEnabled: saved.proactiveEnabled ?? process.env.PROACTIVE_ENABLED === "true",
    proactiveTimes: saved.proactiveTimes || process.env.PROACTIVE_TIMES || "08:00,12:30,19:30",
    proactiveDailyMax: Number(saved.proactiveDailyMax ?? process.env.PROACTIVE_DAILY_MAX ?? 5),
  };
}

function childEnv() {
  const settings = currentSettings();
  return {
    ...process.env,
    PROACTIVE_ENABLED: String(settings.proactiveEnabled),
    PROACTIVE_TIMES: settings.proactiveTimes,
    PROACTIVE_DAILY_MAX: String(settings.proactiveDailyMax),
  };
}

function addLog(level, text) {
  const clean = String(text).trim();
  if (!clean) return;
  state.logs.unshift({ time: Date.now(), level, text: clean });
  state.logs = state.logs.slice(0, 180);

  if (clean.includes("WhatsApp tersambung. Arnel online.")) state.whatsapp = "online";
  if (clean.includes("Koneksi tertutup.")) state.whatsapp = "offline";
  if (clean.includes("Mencoba menyambung ulang")) state.whatsapp = "reconnecting";
  if (clean.includes("Scan QR ini")) state.whatsapp = "needs_qr";
  if (clean.includes("[masuk]") || clean.includes("[inisiatif]")) state.lastActivity = Date.now();
  if (clean.includes("[inisiatif]")) state.proactiveSession += 1;
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
    env: childEnv(),
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

  if (previous && previous.exitCode === null) {
    previous.kill("SIGINT");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1800);
      previous.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (previous.exitCode === null) previous.kill("SIGTERM");
  }

  spawnBot();
  restarting = false;
  return true;
}

function bytes(value) {
  return Number.isFinite(value) ? Math.round(value / 1024 / 1024) : 0;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function statusSnapshot() {
  const cpus = os.cpus();
  return {
    whatsapp: state.whatsapp,
    botProcess: state.botProcess,
    proactiveSession: state.proactiveSession,
    errorsSession: state.errorsSession,
    restartCount: state.restartCount,
    lastActivity: state.lastActivity,
    uptimeMs: Date.now() - startedAt,
    stats: getDashboardStats(startOfToday()),
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpu: cpus[0]?.model || "unknown",
      cores: cpus.length,
      totalMemoryMb: bytes(os.totalmem()),
      freeMemoryMb: bytes(os.freemem()),
    },
    settings: currentSettings(),
    relationship: getDashboardRelationship(),
    database: getDatabaseInfo(),
    logs: state.logs,
  };
}

function brainSnapshot() {
  return {
    memories: getDashboardMemories(30),
    training: getDashboardTraining(30),
    exchanges: getDashboardExchanges(30),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error("request terlalu besar"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("JSON tidak valid")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arnel Control Center</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17181b;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:auto;padding:26px 18px 50px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.topright{display:flex;gap:9px;align-items:center}.title h1{margin:0;font-size:29px}.title p{margin:5px 0 0;color:#727780;font-size:13px}.card{background:#fff;border:1px solid #dfe3e8;border-radius:15px;padding:17px;box-shadow:0 2px 8px rgba(0,0,0,.035)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.label{font-size:12px;color:#777d86;margin-bottom:8px}.value{font-size:23px;font-weight:750}.pill{padding:8px 12px;border-radius:999px;font-size:13px;border:1px solid #d8dde3;background:#fff}.online{color:#08783f;background:#eaf8f0;border-color:#b9e7cc}.offline,.error,.stopped{color:#ad2727;background:#fff0f0;border-color:#f0caca}.starting,.reconnecting,.needs_qr{color:#8b6200;background:#fff8df;border-color:#eedb99}.btn{border:1px solid #ccd2d9;background:#fff;color:#22272d;padding:8px 12px;border-radius:9px;cursor:pointer;font-weight:650}.btn:hover{background:#f1f3f5}.btn.primary{background:#22272d;color:#fff;border-color:#22272d}.btn.danger{color:#ad2727}.btn.small{padding:5px 9px;font-size:12px}.btn:disabled{opacity:.45;cursor:not-allowed}.section{margin-top:13px}.system{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.mini{padding:12px;background:#f5f7f9;border-radius:10px}.mini b{display:block;margin-top:4px;font-size:13px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:13px}.list{max-height:340px;overflow:auto}.item{padding:11px 0;border-bottom:1px solid #e8ebee}.item:last-child{border-bottom:0}.meta{font-size:11px;color:#8a9098;margin-bottom:5px}.text{font-size:13px;line-height:1.45;word-break:break-word}.actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.brain{display:grid;grid-template-columns:repeat(5,1fr);gap:9px}.brain .mini{text-align:center}.brain .mini b{font-size:17px}.controls{display:grid;grid-template-columns:auto 1fr 120px auto;gap:9px;align-items:end}.field label{display:block;font-size:11px;color:#777d86;margin-bottom:5px}.field input{width:100%;padding:8px 9px;border:1px solid #ccd2d9;border-radius:8px;background:#fff;color:#20242a}.switch{display:flex;align-items:center;gap:7px;padding-bottom:7px}.searchrow{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;margin-bottom:10px}.search{width:100%;padding:9px 11px;border:1px solid #ccd2d9;border-radius:9px}.chatlist{max-height:580px;overflow:auto;padding:4px}.bubble{max-width:78%;padding:9px 11px;border-radius:12px;margin:7px 0;font-size:13px;line-height:1.45;white-space:pre-wrap}.user{margin-left:auto;background:#dff1ff}.assistant{margin-right:auto;background:#edf0f3}.bubblemeta{font-size:10px;color:#7f858d;margin-bottom:3px}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px}.logs{height:260px;overflow:auto;background:#f6f7f9;border:1px solid #e1e5e9;border-radius:10px;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.err{color:#b42318}.empty{color:#8a9098;font-size:13px;padding:5px 0}.dbbadge{font-size:11px;color:#626971}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}.two,.system,.brain{grid-template-columns:1fr}.controls{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.topright{width:100%;justify-content:space-between}.bubble{max-width:92%}.searchrow{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="title"><h1>Arnel Control Center</h1><p>SQLite dashboard + trainer</p></div><div class="topright"><button id="restart" class="btn">Restart Arnel</button><div id="status" class="pill starting">starting</div></div></div>

  <div class="grid"><div class="card"><div class="label">Uptime dashboard</div><div id="uptime" class="value">-</div></div><div class="card"><div class="label">Incoming today</div><div id="todayIn" class="value">0</div></div><div class="card"><div class="label">Outgoing today</div><div id="todayOut" class="value">0</div></div><div class="card"><div class="label">Total stored</div><div id="totalMessages" class="value">0</div></div></div>

  <div class="card section"><div class="label">Relationship state</div><div id="brain" class="brain"></div></div>

  <div class="card section"><div class="label">Proactive controls</div><div class="controls"><div class="switch"><input id="proEnabled" type="checkbox"><label for="proEnabled">Enabled</label></div><div class="field"><label>Times (HH:MM, comma separated)</label><input id="proTimes" placeholder="08:00,12:30,19:30"></div><div class="field"><label>Daily max</label><input id="proMax" type="number" min="0" max="20"></div><button id="savePro" class="btn primary">Save & Restart</button></div></div>

  <div class="card section"><div class="label">Debian system</div><div class="system"><div class="mini"><span class="label">Hostname</span><b id="host">-</b></div><div class="mini"><span class="label">CPU</span><b id="cpu">-</b></div><div class="mini"><span class="label">Memory</span><b id="memory">-</b></div><div class="mini"><span class="label">Database</span><b id="database">-</b><span id="dbsize" class="dbbadge"></span></div></div></div>

  <div class="two"><div class="card"><div class="label">Memory manager</div><div class="actions"><input id="newMemory" class="search" placeholder="Tambah hal yang harus Arnel ingat..."><button id="addMemory" class="btn primary small">Add memory</button></div><div id="memories" class="list"></div></div><div class="card"><div class="label">Recent training</div><div id="training" class="list"></div></div></div>

  <div class="card section"><div class="label">Chat history · 40 pesan per halaman</div><div class="searchrow"><input id="chatSearch" class="search" placeholder="Cari chat di database..."><button id="searchBtn" class="btn">Search</button><button id="clearSearch" class="btn">Clear</button></div><div id="chatHistory" class="chatlist"></div><div class="pager"><button id="newer" class="btn">Newer</button><span id="pageInfo" class="meta">latest</span><button id="older" class="btn">Older</button></div></div>

  <div class="card section"><div class="label">Trainer from recent history</div><div id="exchanges" class="list"></div></div>
  <div class="card section"><div class="label">Live logs</div><div id="logs" class="logs">belum ada log</div></div>
</div>
<script>
const $=id=>document.getElementById(id);let statusData=null;let brainData={memories:[],training:[],exchanges:[]};let historyStack=[null];let historyIndex=0;let historyPage={rows:[],hasMore:false,nextBeforeId:null};
function esc(s){let d=document.createElement('div');d.textContent=s??'';return d.innerHTML}function up(ms){let s=Math.floor(ms/1000),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d+'d '+h+'h '+m+'m '+(s%60)+'s'}function time(ms){return ms?new Date(ms).toLocaleString():'-'}function size(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB'}
function relationship(x){if(!x)return '<div class="empty">belum ada relationship state</div>';return [['Closeness',x.closeness+'/100'],['Mood',x.mood],['Interactions',x.interactions],['Good',x.goodCount],['Teach',x.taughtCount]].map(a=>'<div class="mini"><span class="label">'+esc(a[0])+'</span><b>'+esc(String(a[1]))+'</b></div>').join('')}
function memories(rows){if(!rows.length)return '<div class="empty">belum ada memory</div>';return rows.map(x=>'<div class="item"><div class="meta">uses '+x.uses+' · '+esc(time(x.updatedAt))+'</div><div class="text">'+esc(x.content)+'</div><div class="actions"><button class="btn danger small" onclick="delMemory('+JSON.stringify(x.chatId)+','+JSON.stringify(x.id)+')">Delete</button></div></div>').join('')}
function training(rows){if(!rows.length)return '<div class="empty">belum ada training</div>';return rows.map(x=>'<div class="item"><div class="meta">'+esc(x.source)+' · uses '+x.uses+'</div><div class="text">'+esc(x.input)+'</div><div class="text">↓ '+esc(x.output)+'</div></div>').join('')}
function exchanges(rows){return rows.map((x,i)=>'<div class="item"><div class="meta">'+esc(time(x.createdAt))+'</div><div class="text"><b>You:</b> '+esc(x.input)+'</div><div class="text"><b>Arnel:</b> '+esc(x.output)+'</div><div class="actions"><button class="btn small" onclick="good('+i+')">Good</button><button class="btn primary small" onclick="teach('+i+')">Teach</button></div></div>').join('')||'<div class="empty">belum ada exchange</div>'}
function chats(rows){return rows.map(x=>'<div class="bubble '+(x.role==='user'?'user':'assistant')+'"><div class="bubblemeta">'+(x.role==='user'?'YOU':'ARNEL')+' · '+esc(time(x.createdAt))+'</div>'+esc(x.content)+'</div>').join('')||'<div class="empty">chat tidak ditemukan</div>'}
async function post(url,data){let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});let x=await r.json();if(!r.ok)throw new Error(x.error||'request gagal');return x}
async function refreshStatus(){try{let r=await fetch('/api/status',{cache:'no-store'});statusData=await r.json();$('uptime').textContent=up(statusData.uptimeMs);$('todayIn').textContent=statusData.stats.incomingToday;$('todayOut').textContent=statusData.stats.outgoingToday;$('totalMessages').textContent=statusData.stats.totalMessages;$('host').textContent=statusData.system.hostname;$('cpu').textContent=statusData.system.cpu;$('memory').textContent=(statusData.system.totalMemoryMb-statusData.system.freeMemoryMb)+' / '+statusData.system.totalMemoryMb+' MB';$('database').textContent=statusData.database.engine;$('dbsize').textContent=size(statusData.database.sizeBytes);$('brain').innerHTML=relationship(statusData.relationship);$('proEnabled').checked=statusData.settings.proactiveEnabled;$('proTimes').value=statusData.settings.proactiveTimes;$('proMax').value=statusData.settings.proactiveDailyMax;let s=$('status');s.textContent=statusData.whatsapp;s.className='pill '+statusData.whatsapp;$('logs').innerHTML=statusData.logs.length?statusData.logs.map(l=>'<div class="'+(l.level==='error'?'err':'')+'">['+new Date(l.time).toLocaleTimeString()+'] '+esc(l.text)+'</div>').join(''):'belum ada log'}catch(e){$('status').textContent='dashboard disconnected';$('status').className='pill offline'}}
async function refreshBrain(){let r=await fetch('/api/brain',{cache:'no-store'});brainData=await r.json();$('memories').innerHTML=memories(brainData.memories);$('training').innerHTML=training(brainData.training);$('exchanges').innerHTML=exchanges(brainData.exchanges)}
async function loadHistory(reset=false){if(reset){historyStack=[null];historyIndex=0}let before=historyStack[historyIndex];let q=$('chatSearch').value.trim();let url='/api/history?limit=40'+(before?'&before='+encodeURIComponent(before):'')+(q?'&q='+encodeURIComponent(q):'');let r=await fetch(url,{cache:'no-store'});historyPage=await r.json();$('chatHistory').innerHTML=chats(historyPage.rows);$('newer').disabled=historyIndex===0;$('older').disabled=!historyPage.hasMore;$('pageInfo').textContent=(q?'search · ':'')+'page '+(historyIndex+1)}
$('older').onclick=async()=>{if(!historyPage.hasMore||!historyPage.nextBeforeId)return;historyStack=historyStack.slice(0,historyIndex+1);historyStack.push(historyPage.nextBeforeId);historyIndex++;await loadHistory(false)};
$('newer').onclick=async()=>{if(historyIndex<=0)return;historyIndex--;await loadHistory(false)};
$('searchBtn').onclick=()=>loadHistory(true);$('clearSearch').onclick=()=>{$('chatSearch').value='';loadHistory(true)};$('chatSearch').addEventListener('keydown',e=>{if(e.key==='Enter')loadHistory(true)});
$('restart').onclick=async()=>{if(confirm('Restart Arnel sekarang?')){await post('/api/restart',{});setTimeout(refreshStatus,700)}};
$('savePro').onclick=async()=>{let times=$('proTimes').value.trim();let max=Number($('proMax').value);if(!/^\d{2}:\d{2}(,\d{2}:\d{2})*$/.test(times)){alert('Format jadwal contoh: 08:00,12:30,19:30');return}await post('/api/proactive',{proactiveEnabled:$('proEnabled').checked,proactiveTimes:times,proactiveDailyMax:max});setTimeout(refreshStatus,900)};
$('addMemory').onclick=async()=>{let content=$('newMemory').value.trim();if(!content)return;await post('/api/memory',{action:'add',content});$('newMemory').value='';await refreshBrain()};
async function delMemory(chatId,id){if(!confirm('Hapus memory ini?'))return;await post('/api/memory',{action:'delete',chatId,id});await refreshBrain()}window.delMemory=delMemory;
async function good(i){let x=brainData.exchanges[i];await post('/api/train',{chatId:x.chatId,input:x.input,output:x.output,source:'good'});await Promise.all([refreshBrain(),refreshStatus()])}window.good=good;
async function teach(i){let x=brainData.exchanges[i],out=prompt('Jawaban Arnel yang seharusnya:',x.output);if(!out||!out.trim())return;await post('/api/train',{chatId:x.chatId,input:x.input,output:out.trim(),source:'teach'});await Promise.all([refreshBrain(),refreshStatus()])}window.teach=teach;
Promise.all([refreshStatus(),refreshBrain(),loadHistory(true)]);setInterval(refreshStatus,2500);setInterval(refreshBrain,10000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, statusSnapshot());
    }

    if (url.pathname === "/api/brain" && req.method === "GET") {
      return sendJson(res, 200, brainSnapshot());
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 40);
      const beforeRaw = url.searchParams.get("before");
      const beforeId = beforeRaw ? Number(beforeRaw) : null;
      const search = url.searchParams.get("q") || "";
      return sendJson(res, 200, getDashboardHistory({ limit, beforeId, search }));
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      const ok = await restartBot();
      return sendJson(res, ok ? 200 : 409, { ok });
    }

    if (url.pathname === "/api/train" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.chatId || !String(body.input || "").trim() || !String(body.output || "").trim()) {
        throw new Error("data training tidak lengkap");
      }
      const source = body.source === "good" ? "good" : "teach";
      saveTrainingExample(body.chatId, String(body.input), String(body.output), source);
      recordFeedback(body.chatId, source);
      addLog("info", `Training ${source} ditambahkan dari dashboard`);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/memory" && req.method === "POST") {
      const body = await readBody(req);
      if (body.action === "add") {
        const chatId = body.chatId || getPrimaryChatId();
        const content = String(body.content || "").trim();
        if (!chatId || !content) throw new Error("chat atau memory kosong");
        saveMemory(chatId, content);
        addLog("info", `Memory ditambahkan dari dashboard: ${content}`);
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === "delete") {
        if (!body.chatId || !body.id) throw new Error("memory id tidak lengkap");
        deleteMemory(body.chatId, body.id);
        addLog("info", "Memory dihapus dari dashboard");
        return sendJson(res, 200, { ok: true });
      }
      throw new Error("action memory tidak dikenal");
    }

    if (url.pathname === "/api/proactive" && req.method === "POST") {
      const body = await readBody(req);
      const times = String(body.proactiveTimes || "").trim();
      const dailyMax = Number(body.proactiveDailyMax);
      if (!/^\d{2}:\d{2}(,\d{2}:\d{2})*$/.test(times)) throw new Error("format jadwal tidak valid");
      if (!Number.isFinite(dailyMax) || dailyMax < 0 || dailyMax > 20) throw new Error("daily max harus 0-20");
      saveJson(SETTINGS_FILE, {
        proactiveEnabled: Boolean(body.proactiveEnabled),
        proactiveTimes: times,
        proactiveDailyMax: Math.floor(dailyMax),
      });
      addLog("info", `Proactive setting disimpan: enabled=${Boolean(body.proactiveEnabled)} times=${times} max=${dailyMax}`);
      await restartBot();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (error) {
    addLog("error", `Dashboard API error: ${error.message}`);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

spawnBot();
server.listen(PORT, HOST, () => console.log(`Dashboard aktif di http://localhost:${PORT}`));

function shutdown(signal) {
  console.log(`Menerima ${signal}, menghentikan dashboard dan bot...`);
  server.close(() => process.exit(0));
  if (bot && bot.exitCode === null) bot.kill("SIGINT");
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
