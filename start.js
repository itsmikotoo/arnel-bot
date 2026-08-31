import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const HISTORY_FILE = path.join(DATA_DIR, "chat_history.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");
const TRAINING_FILE = path.join(DATA_DIR, "training_examples.json");
const RELATIONSHIP_FILE = path.join(DATA_DIR, "relationship_state.json");
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

function historyData() {
  return loadJson(HISTORY_FILE, {});
}

function primaryChatId() {
  const history = historyData();
  let best = null;
  let latest = 0;
  for (const [chatId, rows] of Object.entries(history)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const time = rows.at(-1)?.createdAt || 0;
    if (time >= latest) {
      latest = time;
      best = chatId;
    }
  }
  return best;
}

function persistentStats() {
  const history = historyData();
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

function chatSnapshot(limit = 80) {
  const history = historyData();
  const rows = [];
  for (const [chatId, messages] of Object.entries(history)) {
    if (!Array.isArray(messages)) continue;
    for (const item of messages) {
      rows.push({ chatId, role: item.role, content: item.content || "", createdAt: item.createdAt || 0 });
    }
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt).slice(-limit);
}

function exchangeSnapshot(limit = 30) {
  const history = historyData();
  const exchanges = [];
  for (const [chatId, rows] of Object.entries(history)) {
    if (!Array.isArray(rows)) continue;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i]?.role !== "assistant") continue;
      let user = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (rows[j]?.role === "user") { user = rows[j]; break; }
        if (rows[j]?.role === "assistant") break;
      }
      if (!user) continue;
      exchanges.push({
        chatId,
        input: user.content || "",
        output: rows[i].content || "",
        createdAt: rows[i].createdAt || 0,
      });
    }
  }
  return exchanges.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

function memorySnapshot(limit = 20) {
  const data = loadJson(MEMORY_FILE, {});
  const rows = [];
  for (const [chatId, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      rows.push({
        chatId,
        id: item.id,
        content: item.content || "",
        uses: item.uses || 1,
        updatedAt: item.updatedAt || item.createdAt || 0,
      });
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function trainingSnapshot(limit = 20) {
  const rows = loadJson(TRAINING_FILE, []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((item, index) => ({
      index,
      chatId: item.chatId,
      input: item.input || "",
      output: item.output || "",
      source: item.source || "unknown",
      uses: item.uses || 1,
      createdAt: item.updatedAt || item.createdAt || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function relationshipSnapshot() {
  const chatId = primaryChatId();
  if (!chatId) return null;
  const all = loadJson(RELATIONSHIP_FILE, {});
  const row = all[chatId];
  if (!row) return { chatId, closeness: 20, interactions: 0, goodCount: 0, taughtCount: 0, mood: "hangat" };
  return {
    chatId,
    closeness: row.closeness ?? 20,
    interactions: row.interactions ?? 0,
    goodCount: row.goodCount ?? 0,
    taughtCount: row.taughtCount ?? 0,
    mood: row.mood || "hangat",
  };
}

function snapshot() {
  const cpus = os.cpus();
  return {
    whatsapp: state.whatsapp,
    botProcess: state.botProcess,
    proactiveSession: state.proactiveSession,
    errorsSession: state.errorsSession,
    restartCount: state.restartCount,
    lastActivity: state.lastActivity,
    uptimeMs: Date.now() - startedAt,
    stats: persistentStats(),
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpu: cpus[0]?.model || "unknown",
      cores: cpus.length,
      totalMemoryMb: bytes(os.totalmem()),
      freeMemoryMb: bytes(os.freemem()),
    },
    settings: currentSettings(),
    relationship: relationshipSnapshot(),
    memories: memorySnapshot(),
    training: trainingSnapshot(),
    exchanges: exchangeSnapshot(),
    chats: chatSnapshot(),
    logs: state.logs,
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function trainExample({ chatId, input, output, source }) {
  if (!chatId || !input?.trim() || !output?.trim()) throw new Error("data training tidak lengkap");
  const rows = loadJson(TRAINING_FILE, []);
  const normalizedInput = input.trim().toLowerCase();
  const normalizedOutput = output.trim().toLowerCase();
  const existing = rows.find((item) => item.chatId === chatId && item.input?.trim().toLowerCase() === normalizedInput && item.output?.trim().toLowerCase() === normalizedOutput);
  if (existing) {
    existing.uses = (existing.uses || 1) + 1;
    existing.updatedAt = Date.now();
    if (source === "teach") existing.source = "teach";
  } else {
    rows.push({ chatId, input: input.trim(), output: output.trim(), source, uses: 1, createdAt: Date.now() });
  }
  saveJson(TRAINING_FILE, rows.slice(-500));

  const rel = loadJson(RELATIONSHIP_FILE, {});
  const r = rel[chatId] || { closeness: 20, interactions: 0, goodCount: 0, taughtCount: 0, mood: "hangat" };
  if (source === "good") { r.goodCount = (r.goodCount || 0) + 1; r.closeness = Math.min(100, (r.closeness || 20) + 2); }
  else { r.taughtCount = (r.taughtCount || 0) + 1; r.closeness = Math.min(100, (r.closeness || 20) + 1); }
  r.updatedAt = Date.now();
  rel[chatId] = r;
  saveJson(RELATIONSHIP_FILE, rel);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arnel Control Center</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17181b;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:auto;padding:26px 18px 50px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.topright{display:flex;gap:9px;align-items:center}.title h1{margin:0;font-size:29px}.title p{margin:5px 0 0;color:#727780;font-size:13px}.card{background:#fff;border:1px solid #dfe3e8;border-radius:15px;padding:17px;box-shadow:0 2px 8px rgba(0,0,0,.035)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.label{font-size:12px;color:#777d86;margin-bottom:8px}.value{font-size:23px;font-weight:750}.pill{padding:8px 12px;border-radius:999px;font-size:13px;border:1px solid #d8dde3;background:#fff}.online{color:#08783f;background:#eaf8f0;border-color:#b9e7cc}.offline,.error,.stopped{color:#ad2727;background:#fff0f0;border-color:#f0caca}.starting,.reconnecting,.needs_qr{color:#8b6200;background:#fff8df;border-color:#eedb99}.btn{border:1px solid #ccd2d9;background:#fff;color:#22272d;padding:8px 12px;border-radius:9px;cursor:pointer;font-weight:650}.btn:hover{background:#f1f3f5}.btn.primary{background:#22272d;color:#fff;border-color:#22272d}.btn.danger{color:#ad2727}.btn.small{padding:5px 9px;font-size:12px}.section{margin-top:13px}.system{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.mini{padding:12px;background:#f5f7f9;border-radius:10px}.mini b{display:block;margin-top:4px;font-size:13px}.three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:13px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:13px}.list{max-height:340px;overflow:auto}.item{padding:11px 0;border-bottom:1px solid #e8ebee}.item:last-child{border-bottom:0}.meta{font-size:11px;color:#8a9098;margin-bottom:5px}.text{font-size:13px;line-height:1.45;word-break:break-word}.actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.brain{display:grid;grid-template-columns:repeat(5,1fr);gap:9px}.brain .mini{text-align:center}.brain .mini b{font-size:17px}.controls{display:grid;grid-template-columns:auto 1fr 120px auto;gap:9px;align-items:end}.field label{display:block;font-size:11px;color:#777d86;margin-bottom:5px}.field input{width:100%;padding:8px 9px;border:1px solid #ccd2d9;border-radius:8px;background:#fff;color:#20242a}.switch{display:flex;align-items:center;gap:7px;padding-bottom:7px}.search{width:100%;padding:9px 11px;border:1px solid #ccd2d9;border-radius:9px;margin-bottom:10px}.chatlist{max-height:560px;overflow:auto;padding:4px}.bubble{max-width:78%;padding:9px 11px;border-radius:12px;margin:7px 0;font-size:13px;line-height:1.45;white-space:pre-wrap}.user{margin-left:auto;background:#dff1ff}.assistant{margin-right:auto;background:#edf0f3}.bubblemeta{font-size:10px;color:#7f858d;margin-bottom:3px}.logs{height:260px;overflow:auto;background:#f6f7f9;border:1px solid #e1e5e9;border-radius:10px;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.err{color:#b42318}.empty{color:#8a9098;font-size:13px;padding:5px 0}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}.three,.two,.system,.brain{grid-template-columns:1fr}.controls{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.topright{width:100%;justify-content:space-between}.bubble{max-width:92%}}
</style></head><body><div class="wrap">
<div class="top"><div class="title"><h1>Arnel Control Center</h1><p>WhatsApp bot dashboard + trainer</p></div><div class="topright"><button id="restart" class="btn">Restart Arnel</button><div id="status" class="pill starting">starting</div></div></div>
<div class="grid"><div class="card"><div class="label">Uptime dashboard</div><div id="uptime" class="value">-</div></div><div class="card"><div class="label">Incoming today</div><div id="todayIn" class="value">0</div></div><div class="card"><div class="label">Outgoing today</div><div id="todayOut" class="value">0</div></div><div class="card"><div class="label">Proactive this session</div><div id="proactive" class="value">0</div></div></div>
<div class="card section"><div class="label">Relationship state</div><div id="brain" class="brain"></div></div>
<div class="card section"><div class="label">Proactive controls</div><div class="controls"><div class="switch"><input id="proEnabled" type="checkbox"><label for="proEnabled">Enabled</label></div><div class="field"><label>Times (HH:MM, comma separated)</label><input id="proTimes" placeholder="08:00,12:30,19:30"></div><div class="field"><label>Daily max</label><input id="proMax" type="number" min="0" max="20"></div><button id="savePro" class="btn primary">Save & Restart</button></div></div>
<div class="card section"><div class="label">Debian system</div><div class="system"><div class="mini"><span class="label">Hostname</span><b id="host">-</b></div><div class="mini"><span class="label">CPU</span><b id="cpu">-</b></div><div class="mini"><span class="label">Memory</span><b id="memory">-</b></div></div></div>
<div class="two"><div class="card"><div class="label">Memory manager</div><div class="actions"><input id="newMemory" class="search" placeholder="Tambah hal yang harus Arnel ingat..."><button id="addMemory" class="btn primary small">Add memory</button></div><div id="memories" class="list"></div></div><div class="card"><div class="label">Recent training</div><div id="training" class="list"></div></div></div>
<div class="card section"><div class="label">Chat history</div><input id="chatSearch" class="search" placeholder="Cari chat..."><div id="chatHistory" class="chatlist"></div></div>
<div class="card section"><div class="label">Trainer from history</div><div id="exchanges" class="list"></div></div>
<div class="card section"><div class="label">Live logs</div><div id="logs" class="logs">belum ada log</div></div>
</div><script>
const $=id=>document.getElementById(id);let last=null;
function esc(s){let d=document.createElement('div');d.textContent=s??'';return d.innerHTML}function up(ms){let s=Math.floor(ms/1000),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d+'d '+h+'h '+m+'m '+(s%60)+'s'}function time(ms){return ms?new Date(ms).toLocaleString():'-'}
function brain(x){if(!x)return '<div class="empty">belum ada relationship state</div>';return [['Closeness',x.closeness+'/100'],['Mood',x.mood],['Interactions',x.interactions],['Good',x.goodCount],['Teach',x.taughtCount]].map(a=>'<div class="mini"><span class="label">'+esc(a[0])+'</span><b>'+esc(String(a[1]))+'</b></div>').join('')}
function mem(rows){if(!rows.length)return '<div class="empty">belum ada memory</div>';return rows.map(x=>'<div class="item"><div class="meta">uses '+x.uses+' · '+esc(time(x.updatedAt))+'</div><div class="text">'+esc(x.content)+'</div><div class="actions"><button class="btn danger small" onclick="delMemory('+JSON.stringify(x.chatId)+','+JSON.stringify(x.id)+')">Delete</button></div></div>').join('')}
function training(rows){if(!rows.length)return '<div class="empty">belum ada training</div>';return rows.map(x=>'<div class="item"><div class="meta">'+esc(x.source)+' · uses '+x.uses+'</div><div class="text">'+esc(x.input)+'</div><div class="text">↓ '+esc(x.output)+'</div></div>').join('')}
function exchanges(rows){return rows.map((x,i)=>'<div class="item"><div class="meta">'+esc(time(x.createdAt))+'</div><div class="text"><b>You:</b> '+esc(x.input)+'</div><div class="text"><b>Arnel:</b> '+esc(x.output)+'</div><div class="actions"><button class="btn small" onclick="good('+i+')">Good</button><button class="btn primary small" onclick="teach('+i+')">Teach</button></div></div>').join('')||'<div class="empty">belum ada exchange</div>'}
function chats(rows,q=''){q=q.trim().toLowerCase();let show=q?rows.filter(x=>x.content.toLowerCase().includes(q)):rows;return show.map(x=>'<div class="bubble '+(x.role==='user'?'user':'assistant')+'"><div class="bubblemeta">'+(x.role==='user'?'YOU':'ARNEL')+' · '+esc(time(x.createdAt))+'</div>'+esc(x.content)+'</div>').join('')||'<div class="empty">chat tidak ditemukan</div>'}
async function post(url,data){let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});let x=await r.json();if(!r.ok)throw new Error(x.error||'request gagal');return x}
async function refresh(){try{let r=await fetch('/api/status',{cache:'no-store'});last=await r.json();$('uptime').textContent=up(last.uptimeMs);$('todayIn').textContent=last.stats.incomingToday;$('todayOut').textContent=last.stats.outgoingToday;$('proactive').textContent=last.proactiveSession;$('host').textContent=last.system.hostname;$('cpu').textContent=last.system.cpu;$('memory').textContent=(last.system.totalMemoryMb-last.system.freeMemoryMb)+' / '+last.system.totalMemoryMb+' MB';$('brain').innerHTML=brain(last.relationship);$('memories').innerHTML=mem(last.memories);$('training').innerHTML=training(last.training);$('exchanges').innerHTML=exchanges(last.exchanges);$('chatHistory').innerHTML=chats(last.chats,$('chatSearch').value);$('proEnabled').checked=last.settings.proactiveEnabled;$('proTimes').value=last.settings.proactiveTimes;$('proMax').value=last.settings.proactiveDailyMax;let s=$('status');s.textContent=last.whatsapp;s.className='pill '+last.whatsapp;$('logs').innerHTML=last.logs.length?last.logs.map(l=>'<div class="'+(l.level==='error'?'err':'')+'">['+new Date(l.time).toLocaleTimeString()+'] '+esc(l.text)+'</div>').join(''):'belum ada log'}catch(e){$('status').textContent='dashboard disconnected';$('status').className='pill offline'}}
$('chatSearch').addEventListener('input',()=>{if(last)$('chatHistory').innerHTML=chats(last.chats,$('chatSearch').value)});
$('restart').onclick=async()=>{if(confirm('Restart Arnel sekarang?')){await post('/api/restart',{});setTimeout(refresh,700)}};
$('savePro').onclick=async()=>{let times=$('proTimes').value.trim();let max=Number($('proMax').value);if(!/^\d{2}:\d{2}(,\d{2}:\d{2})*$/.test(times)){alert('Format jadwal contoh: 08:00,12:30,19:30');return}await post('/api/proactive',{proactiveEnabled:$('proEnabled').checked,proactiveTimes:times,proactiveDailyMax:max});setTimeout(refresh,900)};
$('addMemory').onclick=async()=>{let content=$('newMemory').value.trim();if(!content)return;await post('/api/memory',{action:'add',content});$('newMemory').value='';refresh()};
async function delMemory(chatId,id){if(!confirm('Hapus memory ini?'))return;await post('/api/memory',{action:'delete',chatId,id});refresh()}window.delMemory=delMemory;
async function good(i){let x=last.exchanges[i];await post('/api/train',{chatId:x.chatId,input:x.input,output:x.output,source:'good'});refresh()}window.good=good;
async function teach(i){let x=last.exchanges[i],out=prompt('Jawaban Arnel yang seharusnya:',x.output);if(!out||!out.trim())return;await post('/api/train',{chatId:x.chatId,input:x.input,output:out.trim(),source:'teach'});refresh()}window.teach=teach;
refresh();setInterval(refresh,2500);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/status" && req.method === "GET") return sendJson(res, 200, snapshot());
    if (req.url === "/api/restart" && req.method === "POST") return sendJson(res, (await restartBot()) ? 200 : 409, { ok: true });

    if (req.url === "/api/train" && req.method === "POST") {
      const body = await readBody(req);
      trainExample(body);
      addLog("info", `Training ${body.source} ditambahkan dari dashboard`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.url === "/api/memory" && req.method === "POST") {
      const body = await readBody(req);
      const data = loadJson(MEMORY_FILE, {});
      if (body.action === "add") {
        const chatId = body.chatId || primaryChatId();
        const content = String(body.content || "").trim().replace(/\s+/g, " ");
        if (!chatId || !content) throw new Error("chat atau memory kosong");
        data[chatId] ||= [];
        const same = data[chatId].find((x) => x.content?.toLowerCase() === content.toLowerCase());
        if (same) { same.uses = (same.uses || 1) + 1; same.updatedAt = Date.now(); }
        else data[chatId].push({ id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, content, uses: 1, createdAt: Date.now() });
        data[chatId] = data[chatId].slice(-60);
        saveJson(MEMORY_FILE, data);
        addLog("info", `Memory ditambahkan dari dashboard: ${content}`);
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === "delete") {
        if (!body.chatId || !body.id) throw new Error("memory id tidak lengkap");
        data[body.chatId] = (data[body.chatId] || []).filter((x) => x.id !== body.id);
        saveJson(MEMORY_FILE, data);
        addLog("info", "Memory dihapus dari dashboard");
        return sendJson(res, 200, { ok: true });
      }
      throw new Error("action memory tidak dikenal");
    }

    if (req.url === "/api/proactive" && req.method === "POST") {
      const body = await readBody(req);
      const times = String(body.proactiveTimes || "").trim();
      const dailyMax = Number(body.proactiveDailyMax);
      if (!/^\d{2}:\d{2}(,\d{2}:\d{2})*$/.test(times)) throw new Error("format jadwal tidak valid");
      if (!Number.isFinite(dailyMax) || dailyMax < 0 || dailyMax > 20) throw new Error("daily max harus 0-20");
      saveJson(SETTINGS_FILE, { proactiveEnabled: Boolean(body.proactiveEnabled), proactiveTimes: times, proactiveDailyMax: Math.floor(dailyMax) });
      addLog("info", `Proactive setting disimpan: enabled=${Boolean(body.proactiveEnabled)} times=${times} max=${dailyMax}`);
      await restartBot();
      return sendJson(res, 200, { ok: true });
    }

    if (req.url === "/" && req.method === "GET") {
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
