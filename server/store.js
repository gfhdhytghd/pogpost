import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class MemoryStore {
  constructor(initial = null) { this.state = initial ? structuredClone(initial) : null; }
  read() { return this.state ? structuredClone(this.state) : null; }
  replace(state) { this.state = structuredClone(state); }
}

/** Small-store atomic snapshots. The engine serializes all asynchronous mutations. */
export class JsonStore extends MemoryStore {
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { file: options } : options;
    const file = opts.file;
    if (!file) throw new Error('JsonStore requires a file path.');
    let initial = opts.initial;
    let metadata;
    try { metadata = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata?.isSymbolicLink()) throw new Error('Store path must not be a symbolic link.');
    if (metadata && !metadata.isFile()) throw new Error('Store path must be a regular file.');
    if (metadata) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(fd).isFile()) throw new Error('Store path must be a regular file.');
        initial = JSON.parse(fs.readFileSync(fd, 'utf8'));
        fs.fchmodSync(fd, 0o600);
      } finally { fs.closeSync(fd); }
    }
    super(initial);
    this.file = path.resolve(file);
  }
  replace(state) {
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Store path must not be a symbolic link.');
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      super.replace(state);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }
}
