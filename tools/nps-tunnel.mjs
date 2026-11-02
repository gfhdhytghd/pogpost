import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { relayPort } from './prepare-deploy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHILD_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin' });
const PYTHON = '/usr/bin/python3';
const HELPER = path.join(ROOT, 'tools/nps-memfd.py');

function targetPort(value) {
  if (!/^[1-9][0-9]{3,4}$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) throw Error('Invalid tunnel configuration.');
  return Number(value);
}

// The returned string contains a credential. Send it only to the child's stdin.
export function buildConfig(env) {
  if (!env || typeof env.NPS_VKEY !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(env.NPS_VKEY)) throw Error('Invalid tunnel configuration.');
  let relay;
  try { relay = relayPort(env.NPS_RELAY_PORT ?? '18788'); }
  catch { throw Error('Invalid tunnel configuration.'); }
  const target = targetPort(env.NPS_TARGET_PORT ?? '8788');
  return `[common]\nserver_addr=wilflin.me:8025\nconn_type=tls\nvkey=${env.NPS_VKEY}\n\n[sealed-notes-web]\nmode=tcp\nserver_ip=127.0.0.1\nserver_port=${relay}\ntarget_addr=127.0.0.1:${target}\n`;
}

export async function readTunnelEnv({ root = ROOT } = {}) {
  let file;
  try {
    // O_NOFOLLOW and fstat apply to the file actually opened, not an earlier path check.
    file = await open(path.join(root, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid()) throw Error('Unsafe credential file.');
    execFileSync('git', ['check-ignore', '--quiet', '--', '.env'], { cwd: root, env: CHILD_ENV, stdio: 'ignore', timeout: 3000 });
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', '.env'], { cwd: root, env: CHILD_ENV, stdio: 'ignore', timeout: 3000 });
    } catch { return parseEnv(await file.readFile('utf8')); }
    throw Error('Tracked credential file.');
  } catch { throw Error('Tunnel credentials require an owned, untracked, gitignored regular .env file with mode 0600.'); }
  finally { await file?.close(); }
}

export async function startTunnel({ env, root = ROOT, spawnFn = spawn, onStatus = () => {} } = {}) {
  const config = buildConfig(env ?? await readTunnelEnv({ root }));
  let child;
  try {
    child = spawnFn(PYTHON, [HELPER], { env: { ...CHILD_ENV }, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch { throw Error('Unable to start NPC tunnel.'); }
  const completion = new Promise(resolve => {
    let settled = false;
    const finish = code => { if (!settled) { settled = true; resolve(code); } };
    child.once('spawn', () => onStatus('started'));
    child.once('error', () => { onStatus('failed'); finish(1); });
    child.once('exit', (code, signal) => finish(Number.isInteger(code) && code >= 0 ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    child.stdin.on('error', () => { child.kill('SIGTERM'); finish(1); });
    try { child.stdin.end(config); }
    catch { child.kill('SIGTERM'); finish(1); }
  });
  return { child, completion, stop: () => child.kill('SIGTERM') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 2) throw Error('No arguments supported.');
    const tunnel = await startTunnel({ onStatus: status => console.log(status === 'started' ? 'NPC tunnel process started; relay acceptance is unverified.' : 'NPC tunnel process failed.') });
    const stop = () => tunnel.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const code = await tunnel.completion;
      console.log(`NPC tunnel process exited with code ${code}.`);
      process.exitCode = code;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch {
    console.error('NPC tunnel could not start. Check the private project .env, tunnel settings, and NPC installation.');
    process.exitCode = 1;
  }
}
