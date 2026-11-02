import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { decodeSecret } from './extension/auth.js';
import { saveEnv } from './env-store.js';
import { withFileLock } from './file-lock.js';

const execute = promisify(execFile);
export const CREDENTIAL_KEYS = Object.freeze([
  'TWITCH_EXT_CLIENT_ID', 'TWITCH_EXT_SECRET',
  'TWITCH_EXT_OWNER_ID', 'TWITCH_BROADCASTER_ID',
]);
const DISABLED = Object.freeze(Object.fromEntries([
  'PAYMENTS_LIVE', 'DECISIONS_LIVE', 'TWITCH_CONNECT', 'TWITCH_SIGNALS',
  'TWITCH_POLLS', 'TWITCH_SUBSCRIPTIONS', 'TWITCH_AUTO_SESSION',
  'OBS_FRAME_WATCHER', 'ASTRA_CONDITIONS', 'SPEECH_WATCHER',
].map(key => [key, 'false'])));
const failure = (status, code) => Object.assign(new Error(code), { status, code });

function valid(key, value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return false;
  if (key === 'TWITCH_EXT_SECRET') {
    try { decodeSecret(value); return true; } catch { return false; }
  }
  return key === 'TWITCH_EXT_CLIENT_ID'
    ? /^[A-Za-z0-9]{1,128}$/.test(value)
    : /^[0-9]{1,30}$/.test(value);
}
const projection = env => ({ present: Object.fromEntries(
  CREDENTIAL_KEYS.map(key => [key, valid(key, env[key])]),
) });

/** Local operator storage only. HTTP callers must enforce the loopback cookie guard. */
export class CredentialSetup {
  constructor({ root } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root))
      throw failure(503, 'credentials_unavailable');
    this.root = path.resolve(root);
    this.file = path.join(this.root, '.env');
  }

  async assertStorage() {
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error();
    // Never inherit provider credentials or caller-supplied Git configuration.
    const options = { cwd: this.root, env: { PATH: process.env.PATH },
      timeout: 5000, maxBuffer: 1024, encoding: 'utf8' };
    await execute('git', ['check-ignore', '--quiet', '--', '.env'], options);
    const tracked = await execute('git', ['ls-files', '-z', '--', '.env'], options);
    if (tracked.stdout.length) throw Error();
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
          (info.mode & 0o7777) !== 0o600) throw Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async readPrivate() {
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 ||
          info.size > 65536) throw Error();
      return await handle.readFile('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    } finally { await handle?.close(); }
  }

  async status() {
    try {
      await this.assertStorage();
      return projection(parseEnv(await this.readPrivate()));
    } catch { throw failure(503, 'credentials_unavailable'); }
  }

  async save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Object.keys(input).some(key => !CREDENTIAL_KEYS.includes(key)))
      throw failure(400, 'invalid_credentials');
    const values = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === '') continue;
      if (!valid(key, value)) throw failure(400, 'invalid_credentials');
      values[key] = value;
    }
    try {
      await this.assertStorage();
      return await withFileLock(this.file, async lease => {
        await this.assertStorage();
        const content = await this.readPrivate();
        const additions = { ...values, ...DISABLED };
        const extraBytes = Object.entries(additions).reduce((size, [key, value]) =>
          size + Buffer.byteLength(key + '=' + JSON.stringify(value) + '\n'), 0);
        if (Buffer.byteLength(content) + extraBytes > 65536) throw Error();
        // saveEnv replaces canonical assignments. Reject ambiguous forms before writing.
        for (const key of [...Object.keys(values), ...Object.keys(DISABLED)]) {
          const assignments = [...content.matchAll(new RegExp('^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=', 'gm'))];
          if (assignments.length > 1 || assignments.some(match => match[0] !== key + '=')) throw Error();
        }
        await saveEnv(this.file, additions, { lease });
        return { ok: true, restart_required: true,
          ...projection(parseEnv(await this.readPrivate())) };
      });
    } catch { throw failure(503, 'credentials_unavailable'); }
  }
}
