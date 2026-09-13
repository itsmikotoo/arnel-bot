import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { serviceUnit, quoteUnit } from '../scripts/service.js';
const repo = path.resolve(import.meta.dirname, '..');
function git(cwd, ...args) { return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-service-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const node = process.execPath;
  const source = path.join(temp, 'source'); const local = path.join(temp, 'local'); const bin = path.join(temp, 'bin');
  fs.mkdirSync(source); fs.mkdirSync(bin); fs.mkdirSync(path.join(source, 'scripts'));
  for (const file of ['service.js', 'update-bot.js']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(source, 'scripts', file));
  fs.writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\ndata/\n.env\n');
  fs.writeFileSync(path.join(source, 'version.txt'), 'old');
  git(source, 'init', '-b', 'feat/natural-chat');
  git(source, 'add', '.');
  const commit = () => git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  commit(); git(temp, 'clone', source, local);
  fs.mkdirSync(path.join(local, 'node_modules')); fs.writeFileSync(path.join(local, 'node_modules', 'stamp'), 'old modules');
  fs.mkdirSync(path.join(local, 'data')); fs.writeFileSync(path.join(local, 'data', 'keep'), 'history');
  fs.writeFileSync(path.join(local, '.env'), 'DUMMY=keep');
  fs.writeFileSync(path.join(source, 'version.txt'), 'new'); git(source, 'add', '.'); commit();
  const config = path.join(temp, 'config'); fs.mkdirSync(path.join(config, 'systemd/user'), { recursive: true });
  fs.writeFileSync(path.join(config, 'systemd/user/arnel-bot.service'), serviceUnit(local, node));
  const log = path.join(temp, 'calls'); const state = path.join(temp, 'state'); fs.writeFileSync(state, 'active');
  const fake = `#!${node}
const fs=require('fs'), path=require('path'); const args=process.argv.slice(2), tool=path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({tool,args,cwd:process.cwd()})+'\\n');
if(tool==='npm') {
 if(args[0]==='ci'){fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/stamp','new modules');}
 if(args[0]==='test' && process.env.TEST_FAIL==='1')process.exit(1);
}
if(tool==='systemctl'){
 if(args.includes('stop'))fs.writeFileSync(process.env.TEST_STATE,'inactive');
 if(args.includes('start'))fs.writeFileSync(process.env.TEST_STATE,'active');
 if(args.includes('is-active') && fs.readFileSync(process.env.TEST_STATE,'utf8')!=='active')process.exit(1);
}
`;
  for (const tool of ['systemctl', 'npm']) fs.writeFileSync(path.join(bin, tool), fake, { mode: 0o755 });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: log, TEST_STATE: state, TEST_BIN: bin };
  const update = extra => spawnSync(node, ['--input-type=module', '-e', "import path from 'node:path'; import {run} from './scripts/service.js'; import {updateBot} from './scripts/update-bot.js'; const execute = (bin,args,options) => run(['systemctl','npm'].includes(bin) ? path.join(process.env.TEST_BIN,bin) : bin,args,options); await updateBot({checkInstalled: () => {}, execute, verifyActive: async () => execute('systemctl',['--user','is-active','--quiet','arnel-bot.service'])});"], { cwd: local, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  return { temp, source, local, log, state, update };
}

test('unit renders boot persistence and cgroup recovery without exposing environment secrets', () => {
  const unit = serviceUnit('/tmp/arnel bot', '/opt/node/bin/node');
  assert.ok(unit.includes('WorkingDirectory=/tmp/arnel bot'));
  assert.ok(unit.includes('Restart=always'));
  assert.ok(unit.includes('KillMode=control-group'));
  assert.ok(unit.includes('ARNEL_MANAGED_SERVICE=1'));
  assert.ok(unit.includes('WantedBy=default.target'));
  assert.ok(!unit.includes('GEMINI_API_KEY'));
  assert.equal(quoteUnit('/tmp/50%/$var', true), '"/tmp/50%%/$$var"');
  assert.throws(() => quoteUnit('/tmp/new\nExecStart=oops'));
});

test('update validates isolated code before stopping, promotes dependencies, preserves data and supports no-op', (t) => {
  const f = setup(t); const result = f.update();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.readFileSync(path.join(f.local, 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(f.local, 'node_modules/stamp'), 'utf8'), 'new modules');
  assert.equal(fs.readFileSync(path.join(f.local, 'data/keep'), 'utf8'), 'history');
  assert.equal(fs.readFileSync(path.join(f.local, '.env'), 'utf8'), 'DUMMY=keep');
  assert.equal(git(f.local, 'status', '--porcelain'), '');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  const checked = calls.findIndex(c => c.tool === 'npm' && c.args[0] === 'test');
  const stopped = calls.findIndex(c => c.tool === 'systemctl' && c.args.includes('stop'));
  assert.ok(checked >= 0 && stopped > checked);
  assert.notEqual(calls[checked].cwd, f.local);
  assert.equal(f.update().status, 0);
});

test('failed validation leaves the old service, checkout and dependencies running', (t) => {
  const f = setup(t); const head = git(f.local, 'rev-parse', 'HEAD'); const result = f.update({ TEST_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.local, 'node_modules/stamp'), 'utf8'), 'old modules');
  assert.equal(fs.readFileSync(f.state, 'utf8'), 'active');
  assert.ok(!fs.readFileSync(f.log, 'utf8').includes('"stop"'));
});

test('dirty checkout and concurrent update lock are not discarded', (t) => {
  const f = setup(t); fs.writeFileSync(path.join(f.local, 'version.txt'), 'my edits');
  assert.notEqual(f.update().status, 0);
  assert.equal(fs.readFileSync(path.join(f.local, 'version.txt'), 'utf8'), 'my edits');
  const lock = path.join(f.local, '.git/arnel-update.lock'); fs.writeFileSync(lock, 'another updater');
  assert.notEqual(f.update().status, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another updater');
});

test('managed supervisor exits when bot child dies so systemd can restart the whole service', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arnel-managed-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['start.js'], { cwd: repo, timeout: 10000, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: temp, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', GEMINI_API_KEY: '', CONNECTION_ONLY: 'false', ARNEL_MANAGED_SERVICE: '1' } });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.ok(child.stderr.includes('service akan memulai ulang'));
});
