import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const surfaces = ['panel.html', 'video_overlay.html', 'config.html'];
const assets = ['styles.css', 'panel.css', 'overlay.css', 'overlay.js', 'overlay-stage.js', 'rope-physics.js', 'moment-choices.js', 'common.js', 'panel.js', 'config.js', 'video_overlay.js'];
const helper = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';

test('Hosted Test ZIP loads a synchronous Twitch helper before every surface module without changing demo HTML', async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sealed-extension-package-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'tools'));
  await mkdir(path.join(fixture, 'public'));
  await copyFile(path.join(projectRoot, 'tools/package-extension.mjs'), path.join(fixture, 'tools/package-extension.mjs'));
  const originals = new Map();
  for (const file of [...surfaces, ...assets]) {
    const source = await readFile(path.join(projectRoot, 'public', file));
    originals.set(file, source);
    await writeFile(path.join(fixture, 'public', file), source);
  }
  // These files must remain outside the extension's explicit asset allowlist.
  for (const file of ['console.html', 'overlay.html', 'harness.js', 'private.txt']) {
    await writeFile(path.join(fixture, 'public', file), 'NOT_FOR_EXTENSION');
  }
  const env = { PATH: process.env.PATH };
  execFileSync(process.execPath, [path.join(fixture, 'tools/package-extension.mjs'), 'https://notes.example.test'], { env, stdio: 'pipe' });
  const archive = path.join(fixture, 'dist/extension.zip');
  const names = execFileSync('unzip', ['-Z1', archive], { env, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, [...surfaces, ...assets, 'client-config.js'].sort());
  for (const file of surfaces) {
    const html = execFileSync('unzip', ['-p', archive, file], { env, encoding: 'utf8' });
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    const helperScripts = scripts.filter(match => match[1].includes(helper));
    assert.equal(helperScripts.length, 1, `${file}: exactly one Twitch helper`);
    const injected = helperScripts[0];
    assert.doesNotMatch(injected[1], /\b(?:async|defer|type)\s*(?:=|\s|$)/i, `${file}: helper must be a synchronous classic script`);
    const module = scripts.find(match => /\btype\s*=\s*["']module["']/i.test(match[1]));
    assert.ok(module, `${file}: module script exists`);
    assert.ok(injected.index > html.toLowerCase().indexOf('<head'), `${file}: helper is in the head`);
    assert.ok(injected.index < html.toLowerCase().indexOf('</head>'), `${file}: helper precedes the head end`);
    assert.ok(injected.index < module.index, `${file}: helper precedes the module`);
    assert.deepEqual(await readFile(path.join(fixture, 'public', file)), originals.get(file), `${file}: fixture source is unchanged`);
    assert.deepEqual(await readFile(path.join(projectRoot, 'public', file)), originals.get(file), `${file}: public source is unchanged`);
    assert.ok(!originals.get(file).toString('utf8').includes(helper), `${file}: demo HTML has no Twitch helper request`);
  }
  const configuration = execFileSync('unzip', ['-p', archive, 'client-config.js'], { env, encoding: 'utf8' });
  assert.equal(configuration, 'globalThis.SEALED_EBS_BASE = "https://notes.example.test";\n');
});
