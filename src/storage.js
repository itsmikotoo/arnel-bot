import fs from 'node:fs';
import path from 'node:path';

// Satu proses penulis. Setiap perubahan disimpan atomik sebelum fungsi kembali.
export class Store {
  constructor(dir, logger) {
    this.dir = dir;
    this.logger = logger;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  file(name) { return path.join(this.dir, `${name}.json`); }
  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    try { value = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.error({ error: error.message, name }, 'data rusak; startup dihentikan agar tidak tertimpa');
        throw error;
      }
    }
    this.cache.set(name, value);
    return value;
  }
  write(name, value) {
    const file = this.file(name);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
      this.cache.set(name, value);
    } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
    return value;
  }
  update(name, fallback, mutate) {
    const value = structuredClone(this.read(name, fallback));
    mutate(value);
    return this.write(name, value);
  }
  flush() { /* write() bersifat sinkron; semua perubahan sudah berada di disk */ }
}
