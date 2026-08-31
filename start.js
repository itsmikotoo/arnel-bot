import "dotenv/config";
import http from "node:http";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const startedAt = Date.now();

const state = {
  whatsapp: "starting",
  botProcess: "starting",
  inbound: 0,
  proactive: 0,
  errors: 0,
  lastActivity: null,
  logs: [],
};

function addLog(level, text) {
  const clean = String(text).trim();
  if (!clean) return;

  state.logs.unshift({
    time: Date.now(),
    level,
    text: clean,
  });

  state.logs = state.logs.slice(0, 120);

  if (clean.includes("WhatsApp tersambung. Arnel online.")) state.whatsapp = "online";
  if (clean.includes("Koneksi tertutup.")) state.whatsapp = "offline";
  if (clean.includes("Mencoba menyambung ulang")) state.whatsapp = "reconnecting";
  if (clean.includes("Scan QR ini")) state.whatsapp = "needs_qr";
  if (clean.includes("[masuk]")) {
    state.inbound += 1;
    state.lastActivity = Date.now();
  }
  if (clean.includes("[inisiatif]")) {
    state.proactive += 1;
    state.lastActivity = Date.now();
  }
  if (level === "error" || clean.includes("Gagal ")) state.errors += 1;
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

const bot = spawn(process.execPath, ["index.js"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

state.botProcess = "running";

attachStream(bot.stdout, "info", process.stdout);
attachStream(bot.stderr, "error", process.stderr);

bot.on("exit", (code, signal) => {
  state.botProcess = "stopped";
  state.whatsapp = "offline";
  addLog("error", `Bot berhenti code=${code ?? "?"} signal=${signal ?? "?"}`);
});

bot.on("error", (error) => {
  state.botProcess = "error";
  state.whatsapp = "offline";
  addLog("error", `Gagal menjalankan bot: ${error.message}`);
});

function bytes(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / 1024 / 1024);
}

function snapshot() {
  const cpus = os.cpus();
  return {
    whatsapp: state.whatsapp,
    botProcess: state.botProcess,
    inbound: state.inbound,
    proactive: state.proactive,
    errors: state.errors,
    lastActivity: state.lastActivity,
    uptimeMs: Date.now() - startedAt,
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpu: cpus[0]?.model || "unknown",
      cores: cpus.length,
      totalMemoryMb: bytes(os.totalmem()),
      freeMemoryMb: bytes(os.freemem()),
      loadAverage: os.loadavg(),
    },
    logs: state.logs,
  };
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arnel Dashboard</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0b0e;color:#f4f4f5;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:auto;padding:28px 18px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.title h1{margin:0;font-size:29px}.title p{margin:6px 0 0;color:#8c8c95;font-size:14px}.pill{border:1px solid #303038;background:#17171c;padding:8px 13px;border-radius:999px;font-size:13px}.online{color:#77f0a1;border-color:#245c38;background:#102619}.offline,.stopped,.error{color:#ff8585;border-color:#603030;background:#291414}.reconnecting,.starting,.needs_qr{color:#ffd277;border-color:#675126;background:#2b2412}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px}.card{background:#151519;border:1px solid #25252c;border-radius:16px;padding:18px}.label{font-size:12px;color:#85858f;margin-bottom:9px}.value{font-size:24px;font-weight:700}.section{margin-top:14px}.system{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}.mini{padding:13px;background:#101013;border-radius:11px}.mini b{display:block;margin-top:5px;font-size:13px;font-weight:600}.logs{height:390px;overflow:auto;background:#09090b;border-radius:11px;padding:13px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.line{margin-bottom:5px;word-break:break-word}.time{color:#565661}.err{color:#ff8686}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}.system{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="title"><h1>Arnel</h1><p>WhatsApp bot control dashboard</p></div><div id="status" class="pill starting">starting</div></div>
  <div class="grid">
    <div class="card"><div class="label">Uptime</div><div id="uptime" class="value">-</div></div>
    <div class="card"><div class="label">Incoming</div><div id="inbound" class="value">0</div></div>
    <div class="card"><div class="label">Proactive</div><div id="proactive" class="value">0</div></div>
    <div class="card"><div class="label">Errors</div><div id="errors" class="value">0</div></div>
  </div>
  <div class="card section"><div class="label">Debian system</div><div class="system"><div class="mini"><span class="label">Hostname</span><b id="host">-</b></div><div class="mini"><span class="label">CPU</span><b id="cpu">-</b></div><div class="mini"><span class="label">Memory</span><b id="memory">-</b></div></div></div>
  <div class="card section"><div class="label">Live logs</div><div id="logs" class="logs">belum ada log</div></div>
</div>
<script>
const $=id=>document.getElementById(id);function uptime(ms){let s=Math.floor(ms/1000),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d+'d '+h+'h '+m+'m '+(s%60)+'s'}function esc(s){let d=document.createElement('div');d.textContent=s;return d.innerHTML}async function refresh(){try{let r=await fetch('/api/status',{cache:'no-store'}),x=await r.json();$('uptime').textContent=uptime(x.uptimeMs);$('inbound').textContent=x.inbound;$('proactive').textContent=x.proactive;$('errors').textContent=x.errors;$('host').textContent=x.system.hostname;$('cpu').textContent=x.system.cpu;$('memory').textContent=(x.system.totalMemoryMb-x.system.freeMemoryMb)+' / '+x.system.totalMemoryMb+' MB';let s=$('status');s.textContent=x.whatsapp;s.className='pill '+x.whatsapp;$('logs').innerHTML=x.logs.length?x.logs.map(l=>'<div class="line '+(l.level==='error'?'err':'')+'"><span class="time">['+new Date(l.time).toLocaleTimeString()+']</span> '+esc(l.text)+'</div>').join(''):'belum ada log'}catch(e){let s=$('status');s.textContent='dashboard disconnected';s.className='pill offline'}}refresh();setInterval(refresh,2000)
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/api/status") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard aktif di http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`Menerima ${signal}, menghentikan dashboard dan bot...`);
  server.close(() => process.exit(0));
  if (!bot.killed) bot.kill("SIGINT");
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
