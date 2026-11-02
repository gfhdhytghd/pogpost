import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, publicOrigin } from './prepare-deploy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CREDENTIALS = ['OPENAI_API_KEY', 'TWITCH_EXT_CLIENT_ID', 'TWITCH_EXT_SECRET', 'TWITCH_EXT_OWNER_ID', 'TWITCH_BROADCASTER_ID', 'TWITCH_CLIENT_ID', 'TWITCH_USER_ID', 'TWITCH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'NPS_VKEY'];

// Only globally routable addresses are eligible for opt-in public HTTP checks.
export function publicAddress(address) {
  if (address.includes(':')) {
    return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address);
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

async function statusRequest(url, { address, forwarded = false } = {}) {
  return new Promise(resolve => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET', timeout: 5000, agent: false,
      headers: forwarded ? { 'X-Forwarded-For': '198.51.100.1' } : {},
      ...(address ? { lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) } : {}),
    }, response => {
      response.destroy();
      resolve({ status: response.statusCode, tls: url.protocol === 'https:' });
    });
    request.on('timeout', () => request.destroy());
    // No provider response, request URL, raw exception or response body is logged.
    request.on('error', () => resolve({ status: null, tls: false }));
    request.end();
  });
}

export async function diagnose({ root = ROOT, network = false, local = false, origin, nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, ...(detail ? { detail } : {}) });
  add('node', Number(nodeVersion.split('.')[0]) >= 24 ? 'pass' : 'fail', 'Node.js >=24 required');
  const require = createRequire(path.join(root, 'package.json'));
  for (const dependency of ['ws', 'playwright-core']) {
    try { require.resolve(dependency); add(`dependency:${dependency}`, 'pass'); }
    catch { add(`dependency:${dependency}`, 'fail', 'Run npm ci'); }
  }
  for (const command of ['flock', 'tar']) {
    try { execFileSync(command, ['--version'], { env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 3000 }); add(`command:${command}`, 'pass'); }
    catch { add(`command:${command}`, 'fail', 'Required local command is unavailable'); }
  }
  let env = {};
  let readable = false;
  try {
    const metadata = await lstat(path.join(root, '.env'));
    readable = metadata.isFile() && (metadata.mode & 0o777) === 0o600;
    add('env:private-file', readable ? 'pass' : 'fail', 'Requires a regular .env file with mode 0600');
    if (readable) {
      try { env = parseEnv(await readFile(path.join(root, '.env'), 'utf8')); add('env:parse', 'pass'); }
      catch { add('env:parse', 'fail', 'Unable to parse .env'); }
    }
  } catch { add('env:private-file', 'fail', 'Create .env from .env.example with mode 0600'); }
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', '.env'], { cwd: root, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 3000 });
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', '.env'], { cwd: root, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 3000 });
      add('env:git-excluded', 'fail', '.env is tracked');
    } catch { add('env:git-excluded', 'pass'); }
  } catch { add('env:git-excluded', 'fail', 'Verify .env is ignored and untracked'); }
  const credentialPresence = Object.fromEntries(CREDENTIALS.map(key => [key, Boolean(env[key]?.trim())]));
  const livePayments = env.PAYMENTS_LIVE === 'true';
  add('payments:simulated', livePayments ? 'fail' : 'pass', 'livePayments must remain false');
  if (env.DECISIONS_LIVE === 'true') add('credentials:decisions', credentialPresence.OPENAI_API_KEY ? 'pass' : 'fail');
  if (env.TWITCH_CONNECT === 'true') add('credentials:twitch', ['TWITCH_CLIENT_ID', 'TWITCH_USER_ID', 'TWITCH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID'].every(key => credentialPresence[key]) ? 'pass' : 'fail');
  add('credentials:extension', ['TWITCH_EXT_CLIENT_ID', 'TWITCH_EXT_SECRET', 'TWITCH_EXT_OWNER_ID', 'TWITCH_BROADCASTER_ID'].every(key => credentialPresence[key]) ? 'pass' : 'warn', 'Presence only; registration, validity and consent are unverified');

  if (network) {
    const base = new URL(publicOrigin(origin));
    let addresses;
    try { addresses = await lookup(base.hostname, { all: true }); }
    catch { addresses = []; }
    const acceptable = addresses.length > 0 && addresses.every(row => publicAddress(row.address));
    add('network:dns', acceptable ? 'pass' : 'fail', 'Public hostname resolution only');
    if (acceptable) {
      const archive = await statusRequest(new URL('/api/archive', base), { address: addresses[0] });
      add('network:tls-hostname', archive.tls ? 'pass' : 'fail', 'Default certificate trust and hostname verification; no redirects');
      add('network:public-archive', archive.status === 200 ? 'pass' : 'fail', `HTTP status ${archive.status ?? 'unavailable'}`);
      for (const route of ['/console', '/overlay', '/api/operator/bootstrap']) {
        const response = await statusRequest(new URL(route, base), { address: addresses[0] });
        add(`network:denied:${route}`, [401, 403, 404, 405].includes(response.status) ? 'pass' : 'fail', `HTTP status ${response.status ?? 'unavailable'}`);
      }
    }
  }
  if (local) {
    const base = 'http://127.0.0.1:8788';
    const archive = await statusRequest(new URL('/api/archive', base));
    add('local:public-archive', archive.status === 200 ? 'pass' : 'fail', `HTTP status ${archive.status ?? 'unavailable'}`);
    const denied = await statusRequest(new URL('/console', base), { forwarded: true });
    add('local:forwarded-console-denied', [401, 403, 404].includes(denied.status) ? 'pass' : 'fail', `HTTP status ${denied.status ?? 'unavailable'}`);
  }
  return { mode: network ? 'network-opt-in' : 'offline', localChecks: Boolean(local), ready: checks.every(check => check.status === 'pass'), livePayments, credentialPresence, checks, providerCalls: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = argumentsFor(process.argv.slice(2), ['--network', '--local', '--origin']);
    if (args['--network'] && !args['--origin']) throw Error('Origin required');
    if (args['--origin']) publicOrigin(args['--origin']);
    const report = await diagnose({ network: args['--network'], local: args['--local'], origin: args['--origin'] });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } catch {
    console.error('Doctor failed. Use no arguments for offline checks, --local for an existing loopback server, or --network --origin https://YOUR-PUBLIC-HOST. No credential values are printed.');
    process.exitCode = 1;
  }
}
