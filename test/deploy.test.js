import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { publicOrigin, relayPort, renderDeployment, prepareDeployment, argumentsFor } from '../tools/prepare-deploy.mjs';
import { bundleSource, sourceFiles } from '../tools/bundle-source.mjs';
import { diagnose, publicAddress } from '../tools/doctor.mjs';

const template = 'server_name NOTES_DOMAIN;\nproxy_pass http://127.0.0.1:NEW_NPS_RELAY_PORT;\n';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sealed-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('deployment input rejects origin, port and service-file injection', () => {
  for (const origin of ['http://notes.wilflin.me', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://notes.local', 'https://notes.example.test', 'https://example.com', 'https://api.openai.com', 'https://api.twitch.tv', 'https://user:secret@notes.wilflin.me', 'https://notes.wilflin.me:443', 'https://notes.wilflin.me/path', 'https://notes.wilflin.me\nserver_name evil;', 'https://notes.wilflin.me?secret=yes', 'https://-notes.wilflin.me']) assert.throws(() => publicOrigin(origin));
  assert.equal(publicOrigin('https://notes.wilflin.me/'), 'https://notes.wilflin.me');
  for (const port of ['80', '8788', '18787', '65536', '18788;touch /tmp/file', '18788\n', '1e4']) assert.throws(() => relayPort(port));
  assert.equal(relayPort('18788'), 18788);
  for (const workdir of ['/tmp/a\nExecStart=/bin/sh', '/tmp/%h', '/tmp/a b', '/tmp/../secret', 'relative']) assert.throws(() => renderDeployment({ origin: 'https://notes.wilflin.me', port: '18788', workdir, nginxTemplate: template }));
  assert.throws(() => argumentsFor(['--network', '--network'], ['--network']));
});

test('staging renders isolated vhost, loopback app and secret-free NPC template', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'deploy'));
  await writeFile(path.join(root, 'deploy/nginx.conf.example'), template);
  const files = await prepareDeployment({ origin: 'https://notes.wilflin.me', port: 18788, workdir: '/srv/sealed-notes', node: '/usr/bin/node' }, { root });
  assert.equal(files.length, 3);
  const nginx = await readFile(path.join(root, 'dist/deploy/nginx.conf'), 'utf8');
  assert.match(nginx, /server_name notes\.wilflin\.me/);
  assert.match(nginx, /127\.0\.0\.1:18788/);
  const service = await readFile(path.join(root, 'dist/deploy/sealed-notes.service'), 'utf8');
  assert.match(service, /WorkingDirectory=\/srv\/sealed-notes\n/);
  assert.match(service, /ExecStart=\/usr\/bin\/node \/srv\/sealed-notes\/server\/index\.js --port=8788/);
  assert.doesNotMatch(service, /EnvironmentFile|OPENAI_API_KEY|TWITCH_TOKEN/);
  const npc = await readFile(path.join(root, 'dist/deploy/npc.conf.template'), 'utf8');
  assert.match(npc, /vkey=\$\{NPS_VKEY\}/);
  assert.match(npc, /^server_ip=127\.0\.0\.1$/m);
  assert.match(npc, /target_addr=127\.0\.0\.1:8788/);
});

test('source archive excludes secrets, private state, symlinks and generated archives', async t => {
  const root = await fixture(t);
  const content = {
    'package.json': '{"private":true}', '.env.example': 'TOKEN=\n', 'README.md': 'source',
    'server/index.js': 'export {};', 'public/panel.html': '<p>source</p>', 'docs/readiness.md': 'source',
    '.env': 'SECRET_SENTINEL', '.env.backup': 'SECRET_SENTINEL',
    'server/.env': 'SECRET_SENTINEL', 'server/private/body.json': 'SECRET_SENTINEL',
    'server/secrets/key.json': 'SECRET_SENTINEL', 'data/notes.json': 'SECRET_SENTINEL',
    'runs/auth.jsonl': 'SECRET_SENTINEL', 'node_modules/pkg/index.js': 'SECRET_SENTINEL',
    '.git/config': 'SECRET_SENTINEL', 'dist/source.tar.gz': 'SECRET_SENTINEL',
  };
  for (const [name, body] of Object.entries(content)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  await symlink('../.env', path.join(root, 'server/leak.js'));
  await bundleSource({ root });
  const artifact = path.join(root, 'dist/source.tar.gz');
  const listing = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' });
  assert.match(listing, /\.\/\.env\.example\n/);
  assert.match(listing, /\.\/server\/index\.js\n/);
  assert.doesNotMatch(listing, /(?:\.env\n|\.env\.backup|private|secrets|data\/|runs\/|node_modules|\.git\/|dist\/|leak\.js)/);
  const extracted = path.join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', artifact, '-C', extracted]);
  assert.equal(await readFile(path.join(extracted, 'server/index.js'), 'utf8'), 'export {};');
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  assert.equal(await readFile(artifact + '.sha256', 'utf8'), `${digest}  source.tar.gz\n`);
  await bundleSource({ root });
  assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'), digest);
});

test('offline doctor redacts credentials, refuses unsafe env and detects live payments', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, '.gitignore'), '.env\n');
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  await writeFile(path.join(root, '.env'), 'OPENAI_API_KEY=SECRET_SENTINEL\nTWITCH_TOKEN=SECRET_SENTINEL\nPAYMENTS_LIVE=true\n', { mode: 0o600 });
  const report = await diagnose({ root });
  assert.equal(report.mode, 'offline');
  assert.equal(report.providerCalls, false);
  assert.equal(report.livePayments, true);
  assert.equal(report.credentialPresence.OPENAI_API_KEY, true);
  assert.equal(report.checks.find(row => row.name === 'payments:simulated').status, 'fail');
  assert.equal(report.checks.find(row => row.name === 'env:git-excluded').status, 'pass');
  assert.doesNotMatch(JSON.stringify(report), /SECRET_SENTINEL/);
  await chmod(path.join(root, '.env'), 0o644);
  const unsafe = await diagnose({ root });
  assert.equal(unsafe.checks.find(row => row.name === 'env:private-file').status, 'fail');
  assert.equal(unsafe.credentialPresence.OPENAI_API_KEY, false);
  assert.doesNotMatch(JSON.stringify(unsafe), /SECRET_SENTINEL/);
});

test('clean extracted source starts a loopback demo with explicitly supplied installed dependencies', async t => {
  const root = await fixture(t);
  const project = path.resolve(import.meta.dirname, '..');
  for (const file of await sourceFiles(project)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(project, file), path.join(root, file));
  }
  await bundleSource({ root });
  const extracted = path.join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', path.join(root, 'dist/source.tar.gz'), '-C', extracted]);
  assert.ok((await readFile(path.join(extracted, 'engine/content.js'), 'utf8')).length);
  assert.ok((await readFile(path.join(extracted, 'engine/ingress.js'), 'utf8')).length);
  // Offline test fixture only: the shipped archive still excludes node_modules.
  await symlink(path.join(project, 'node_modules'), path.join(extracted, 'node_modules'));
  const script = `
    import assert from 'node:assert/strict';
    import { createApplication } from ${JSON.stringify(new URL('server/index.js', 'file://' + extracted + '/').href)};
    const app = await createApplication({ demo: true });
    try {
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/archive');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { notes: [] });
    } finally { await app.close(); }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: extracted, env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 10000 });
});

test('network checks exclude private, loopback, link-local and documentation addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('47.90.217.99'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
