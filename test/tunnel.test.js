import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { buildConfig, readTunnelEnv, startTunnel } from '../tools/nps-tunnel.mjs';

const secret = 'SYNTHETIC_TEST_KEY_123';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sealed-tunnel-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  await writeFile(path.join(root, '.gitignore'), '.env\n');
  await writeFile(path.join(root, '.env'), `NPS_VKEY=${secret}\n`, { mode: 0o600 });
  return root;
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = value => { child.received = value; };
  child.kill = signal => { child.killed = signal; return true; };
  return child;
}

test('NPC config binds relay and target to loopback with bounded ports', () => {
  const config = buildConfig({ NPS_VKEY: secret });
  assert.match(config, /^server_addr=wilflin\.me:8025$/m);
  assert.match(config, /^conn_type=tls$/m);
  assert.match(config, /^\[sealed-notes-web\]$/m);
  assert.match(config, /^server_ip=127\.0\.0\.1$/m);
  assert.match(config, /^server_port=18788$/m);
  assert.match(config, /^target_addr=127\.0\.0\.1:8788$/m);
  assert.doesNotMatch(config, /verify.*false|insecure/i);
  for (const value of ['', '1023', '65536', '18787', '18788\nserver_ip=0.0.0.0', '1e4']) assert.throws(() => buildConfig({ NPS_VKEY: secret, NPS_RELAY_PORT: value }), /Invalid tunnel configuration/);
  for (const value of ['', '80', '65536', '8788\nvkey=bad', '0x2254']) assert.throws(() => buildConfig({ NPS_VKEY: secret, NPS_TARGET_PORT: value }), /Invalid tunnel configuration/);
  for (const value of ['', 'key\nserver_ip=0.0.0.0', 'key #comment', 'key;comment', 'x'.repeat(257)]) assert.throws(() => buildConfig({ NPS_VKEY: value }), /Invalid tunnel configuration/);
});

test('launcher sends key only through stdin and disables NPC logs', async () => {
  const child = fakeChild();
  let captured;
  const statuses = [];
  const tunnel = await startTunnel({ env: { NPS_VKEY: secret, OPENAI_API_KEY: secret, PATH: secret }, onStatus: value => statuses.push(value), spawnFn: (...args) => { captured = args; return child; } });
  const [binary, args, options] = captured;
  assert.equal(binary, '/usr/bin/python3');
  assert.deepEqual(args, [path.resolve(import.meta.dirname, '../tools/nps-memfd.py')]);
  assert.deepEqual(options, { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
  assert.doesNotMatch(JSON.stringify({ args, options }), new RegExp(secret));
  const helper = await readFile(args[0], 'utf8');
  assert.match(helper, /os\.memfd_create/);
  assert.match(helper, /os\.fchmod\(descriptor, 0o600\)/);
  assert.match(helper, /"--log", "off", "--log_level", "off", "--log_path", "off"/);
  assert.match(helper, /"--debug=false"/);
  assert.match(child.received, new RegExp(`^vkey=${secret}$`, 'm'));
  child.emit('spawn');
  assert.deepEqual(statuses, ['started']);
  assert.equal(tunnel.stop(), true);
  assert.equal(child.killed, 'SIGTERM');
  child.emit('exit', null, 'SIGTERM');
  assert.equal(await tunnel.completion, 143);
});

test('installed NPC loads anonymous-memory config and reaches only a synthetic loopback peer', { timeout: 10000 }, async t => {
  try { await access('/usr/local/bin/npc'); await access('/usr/bin/python3'); }
  catch { t.skip('Optional installed NPC/Python integration dependencies are unavailable'); return; }
  const root = await fixture(t);
  const before = await readdir(root);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let connected = false;
  let connection;
  const observed = new Promise(resolve => { connection = resolve; });
  let tunnel;
  server.on('connection', socket => {
    connected = true;
    socket.destroy();
    tunnel?.stop();
    connection();
  });
  t.after(() => { tunnel?.stop(); server.close(); });
  tunnel = await startTunnel({ env: { NPS_VKEY: secret }, spawnFn: (binary, args, options) => {
    const child = spawn(binary, args, { ...options, cwd: root });
    const end = child.stdin.end.bind(child.stdin);
    // Test-only endpoint substitution: never send the synthetic key to the broker.
    child.stdin.end = config => end(config.replace('server_addr=wilflin.me:8025', `server_addr=127.0.0.1:${server.address().port}`));
    return child;
  } });
  const timer = setTimeout(() => { tunnel.stop(); connection(); }, 3000);
  try { await Promise.race([observed, tunnel.completion]); }
  finally { clearTimeout(timer); tunnel.stop(); }
  await tunnel.completion;
  assert.equal(connected, true, 'The installed NPC must load the memfd configuration and attempt the local TLS connection');
  assert.deepEqual(await readdir(root), before, 'NPC must not create log or configuration files');
});

test('launcher reads only owned private ignored env and creates no secret file', async t => {
  const root = await fixture(t);
  const before = await readdir(root);
  assert.equal((await readTunnelEnv({ root })).NPS_VKEY, secret);
  const child = fakeChild();
  const tunnel = await startTunnel({ root, spawnFn: () => child });
  child.emit('exit', 0, null);
  assert.equal(await tunnel.completion, 0);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), `NPS_VKEY=${secret}\n`);
  await chmod(path.join(root, '.env'), 0o644);
  await assert.rejects(readTunnelEnv({ root }), error => !error.message.includes(secret));
  await rm(path.join(root, '.env'));
  await writeFile(path.join(root, 'other.env'), `NPS_VKEY=${secret}`, { mode: 0o600 });
  await symlink('other.env', path.join(root, '.env'));
  await assert.rejects(readTunnelEnv({ root }), /owned, untracked, gitignored regular/);
});

test('launcher fails closed for tracked env, invalid input and child errors', async t => {
  const root = await fixture(t);
  execFileSync('git', ['-C', root, 'add', '--force', '.env'], { stdio: 'ignore' });
  await assert.rejects(readTunnelEnv({ root }), /owned, untracked, gitignored regular/);
  let spawned = false;
  await assert.rejects(startTunnel({ env: { NPS_VKEY: secret, NPS_TARGET_PORT: '1' }, spawnFn: () => { spawned = true; } }), /Invalid tunnel configuration/);
  assert.equal(spawned, false);
  await assert.rejects(startTunnel({ env: { NPS_VKEY: secret }, spawnFn: () => { throw Error(secret); } }), error => error.message === 'Unable to start NPC tunnel.');
  const child = fakeChild();
  const statuses = [];
  const tunnel = await startTunnel({ env: { NPS_VKEY: secret }, spawnFn: () => child, onStatus: value => statuses.push(value) });
  child.emit('error', Error(secret));
  assert.equal(await tunnel.completion, 1);
  assert.deepEqual(statuses, ['failed']);
});
