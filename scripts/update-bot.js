import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, run, capture, requireInstalled, checkActive } from './service.js';

export async function updateBot({ checkInstalled = requireInstalled, execute = run, read = capture, verifyActive = checkActive } = {}) {
  let staging;
  let lock;
  let locked = false;
  let deploymentStarted = false;
  let completed = false;
  try {
    checkInstalled();
    const gitDir = path.resolve(REPO, read('git', ['rev-parse', '--git-common-dir']));
    lock = path.join(gitDir, 'arnel-update.lock');
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    locked = true;
    if (read('git', ['status', '--porcelain'])) throw new Error('Ada perubahan lokal. Update dihentikan tanpa menghapus atau stash perubahanmu.');
    const branch = read('git', ['branch', '--show-current']);
    if (branch !== 'feat/natural-chat') throw new Error('Update ini untuk branch feat/natural-chat. Branch aktif tidak diubah otomatis.');
    const oldHead = read('git', ['rev-parse', 'HEAD']);
    execute('git', ['fetch', 'origin', branch]);
    const target = read('git', ['rev-parse', 'FETCH_HEAD']);
    execute('git', ['merge-base', '--is-ancestor', oldHead, target]);
    if (oldHead === target) {
      console.log('Kode sudah terbaru. Memastikan service berjalan.');
      execute('systemctl', ['--user', 'start', 'arnel-bot.service']);
      await verifyActive();
    } else {
      staging = fs.mkdtempSync(path.join(gitDir, 'arnel-stage-'));
      execute('git', ['worktree', 'add', '--detach', staging, target]);
      console.log('Memasang dependency dan menguji update di checkout sementara; bot lama masih berjalan.');
      const options = { cwd: staging };
      execute('npm', ['ci', '--no-audit', '--no-fund'], options);
      execute('npm', ['run', 'check'], options);
      execute('npm', ['test'], options);
      if (read('git', ['rev-parse', 'HEAD']) !== oldHead || read('git', ['status', '--porcelain'])) {
        throw new Error('Checkout berubah selama pengecekan. Versi berjalan tidak diganti.');
      }
      // All validation passed; stop the whole cgroup before switching code/dependencies.
      deploymentStarted = true;
      execute('systemctl', ['--user', 'stop', 'arnel-bot.service']);
      execute('git', ['merge', '--ff-only', target]);
      const modules = path.join(REPO, 'node_modules');
      if (fs.existsSync(modules)) fs.renameSync(modules, path.join(staging, 'previous-node_modules'));
      fs.renameSync(path.join(staging, 'node_modules'), modules);
      execute('systemctl', ['--user', 'start', 'arnel-bot.service']);
      await verifyActive();
      completed = true;
      console.log(`Update terpasang: ${target.slice(0, 7)}. Versi sebelumnya: ${oldHead.slice(0, 7)}.`);
    }
  } catch (error) {
    console.error(`Update gagal: ${error.message}`);
    if (deploymentStarted) console.error(`Periksa npm run service:logs. Checkout sementara dan dependency sebelumnya disimpan di ${staging}. Tidak ada reset otomatis pada Git atau data.`);
    process.exitCode = 1;
  } finally {
    if (staging && (!deploymentStarted || completed)) {
      try { execute('git', ['worktree', 'remove', '--force', staging]); } catch { console.error(`Checkout sementara belum terhapus: ${staging}`); }
    }
    if (locked) fs.unlinkSync(lock);
  }

}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await updateBot();
