import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const UNIT = 'arnel-bot.service';
const MARKER = '# Managed by arnel-bot scripts/service.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function quoteUnit(value, exec = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('Path berisi karakter yang tidak didukung');
  let escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (exec) escaped = escaped.replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}
export function serviceUnit(repo = REPO, node = process.execPath) {
  if (!path.isAbsolute(repo) || /[\r\n\0]|\s$/.test(repo)) throw new Error("Folder repo harus absolut tanpa karakter akhir kosong");
  return `${MARKER}
[Unit]
Description=Arnel WhatsApp bot and dashboard
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${repo.replace(/%/g, "%%")}
ExecStart=${quoteUnit(node, true)} ${quoteUnit(path.join(repo, 'start.js'), true)}
Environment=ARNEL_MANAGED_SERVICE=1
Environment=${quoteUnit(`PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`)}
Restart=always
RestartSec=15
KillSignal=SIGINT
KillMode=control-group
TimeoutStopSec=15
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}
export function commandEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` };
}
export function run(bin, args, options = {}) {
  return execFileSync(bin, args, { cwd: REPO, env: commandEnv(), stdio: 'inherit', ...options });
}
export function capture(bin, args, options = {}) {
  return run(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options }).trim();
}
export function unitPath() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user', UNIT); }
export function requireUserService() {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Jalankan sebagai user Debian biasa (mikoto), tanpa sudo npm.');
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
}
export function requireInstalled() {
  requireUserService();
  const file = unitPath();
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== serviceUnit()) {
    throw new Error('Jalankan npm run service:install dulu untuk memasang service dari folder dan Node ini.');
  }
}
function repoNodeProcess(pid) {
  try {
    if (Number(pid) === process.pid || fs.statSync(`/proc/${pid}`).uid !== process.getuid()) return null;
    if (fs.realpathSync(`/proc/${pid}/cwd`) !== fs.realpathSync(REPO)) return null;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (!/^node(?:js)?$/.test(path.basename(args[0] || ''))) return null;
    const entry = args[1] && path.resolve(REPO, args[1]);
    if (![path.join(REPO, 'start.js'), path.join(REPO, 'index.js')].includes(entry)) return null;
    return { pid: Number(pid), entry };
  } catch { return null; }
}
function interruptProcess(pid) {
  try { process.kill(pid, 'SIGINT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stopLegacy() {
  const matches = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(repoNodeProcess).filter(Boolean);
  // Stop only node start.js/index.js owned by this user in this checkout.
  for (const match of matches.filter(p => p.entry.endsWith('/start.js'))) {
    if (repoNodeProcess(match.pid)) interruptProcess(match.pid);
  }
  await pause(500);
  for (const match of matches) if (repoNodeProcess(match.pid)) interruptProcess(match.pid);
  for (let n = 0; n < 50; n++) {
    if (!matches.some(p => repoNodeProcess(p.pid))) return;
    await pause(100);
  }
  throw new Error('Proses Arnel lama belum berhenti. Tidak memulai bot kedua; periksa proses lama.');
}
export async function checkActive() {
  await pause(1500);
  run('systemctl', ['--user', 'is-active', '--quiet', UNIT]);
  console.log('Service Arnel aktif. Cek koneksi WhatsApp dengan npm run service:logs.');
}
async function install() {
  requireUserService();
  run('npm', ['run', 'check']);
  const file = unitPath();
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(MARKER)) {
    throw new Error(`Service custom sudah ada di ${file}; file tersebut tidak ditimpa.`);
  }
  const user = os.userInfo().username;
  if (capture('loginctl', ['show-user', user, '-p', 'Linger', '--value']) !== 'yes') {
    console.log('Mengaktifkan linger agar service tetap hidup tanpa login dan mulai saat boot.');
    run('sudo', ['loginctl', 'enable-linger', user]);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, serviceUnit(), { mode: 0o600 });
  fs.renameSync(temp, file);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'stop', UNIT]);
  await stopLegacy();
  run('systemctl', ['--user', 'enable', '--now', UNIT]);
  await checkActive();
}
async function main() {
  const action = process.argv[2];
  if (action === 'install') return install();
  requireInstalled();
  if (action === 'logs') return run('journalctl', ['--user', '-u', UNIT, '-n', '40', '--no-pager']);
  if (action === 'status') return run('systemctl', ['--user', 'status', UNIT, '--no-pager']);
  if (action === 'restart') { run('systemctl', ['--user', 'restart', UNIT]); return checkActive(); }
  if (action === 'stop') return run('systemctl', ['--user', 'stop', UNIT]);
  throw new Error('Aksi service tidak dikenal');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
