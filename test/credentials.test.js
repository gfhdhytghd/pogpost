import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';
import vm from 'node:vm';
import { CREDENTIAL_KEYS, CredentialSetup } from '../server/credential-setup.js';

const execute = promisify(execFile);
const sampleSecret = Buffer.alloc(32, 71).toString('base64');
const complete = { TWITCH_EXT_CLIENT_ID: 'NewExtension123', TWITCH_EXT_SECRET: sampleSecret,
  TWITCH_EXT_OWNER_ID: '12345', TWITCH_BROADCASTER_ID: '67890' };
const providerFlags = ['PAYMENTS_LIVE', 'DECISIONS_LIVE', 'TWITCH_CONNECT', 'TWITCH_SIGNALS',
  'TWITCH_POLLS', 'TWITCH_SUBSCRIPTIONS', 'TWITCH_AUTO_SESSION', 'OBS_FRAME_WATCHER',
  'ASTRA_CONDITIONS', 'SPEECH_WATCHER'];

async function fixture(t, initial) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sealed-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute('git', ['init', '--quiet', root], { env: { PATH: process.env.PATH } });
  await writeFile(path.join(root, '.gitignore'), '.env\n.env.*\n');
  if (initial !== undefined) await writeFile(path.join(root, '.env'), initial, { mode: 0o600 });
  return { root, file: path.join(root, '.env'), setup: new CredentialSetup({ root }) };
}
const absent = Object.fromEntries(CREDENTIAL_KEYS.map(key => [key, false]));
const present = Object.fromEntries(CREDENTIAL_KEYS.map(key => [key, true]));
const safeError = (status, code) => error => {
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error), new RegExp(sampleSecret));
  return true;
};

test('credential setup returns only presence and writes private disabled configuration', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.setup.status(), { present: absent });
  assert.deepEqual(await f.setup.save(complete), { ok: true, restart_required: true, present });
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  const env = parseEnv(await readFile(f.file, 'utf8'));
  assert.equal(env.TWITCH_EXT_SECRET, sampleSecret);
  for (const key of providerFlags) assert.equal(env[key], 'false');
  assert.deepEqual(await f.setup.status(), { present });
  assert.doesNotMatch(JSON.stringify(await f.setup.status()), /NewExtension123|12345|67890|R0dH/);
});

test('partial and blank credentials preserve saved values and unrelated settings', async t => {
  const f = await fixture(t, 'PORT=8788\nTWITCH_EXT_CLIENT_ID=ExistingClient\nDECISIONS_LIVE=true\n');
  const result = await f.setup.save({ TWITCH_EXT_SECRET: sampleSecret, TWITCH_EXT_CLIENT_ID: '' });
  assert.deepEqual(result.present, { ...absent, TWITCH_EXT_CLIENT_ID: true, TWITCH_EXT_SECRET: true });
  const env = parseEnv(await readFile(f.file, 'utf8'));
  assert.equal(env.PORT, '8788');
  assert.equal(env.TWITCH_EXT_CLIENT_ID, 'ExistingClient');
  assert.equal(env.DECISIONS_LIVE, 'false');
  await f.setup.save({});
  assert.equal(parseEnv(await readFile(f.file, 'utf8')).TWITCH_EXT_SECRET, sampleSecret);
});

test('invalid credentials fail without changes or unsafe error text', async t => {
  const f = await fixture(t, 'PORT=8788\n');
  const invalid = [null, [], 'text', { PAYMENTS_LIVE: 'true' }, { TWITCH_TOKEN: 'sentinel' },
    { TWITCH_EXT_CLIENT_ID: 'client\nPAYMENTS_LIVE=true' },
    { TWITCH_EXT_CLIENT_ID: 'client-id' }, { TWITCH_EXT_OWNER_ID: 'owner' },
    { TWITCH_BROADCASTER_ID: 123 }, { TWITCH_EXT_OWNER_ID: '1'.repeat(31) },
    { TWITCH_EXT_SECRET: Buffer.alloc(31).toString('base64') },
    { TWITCH_EXT_SECRET: sampleSecret + '\r' }, { TWITCH_EXT_SECRET: 'x'.repeat(4097) },
    { TWITCH_EXT_SECRET: sampleSecret + '??' }];
  for (const value of invalid)
    await assert.rejects(f.setup.save(value), safeError(400, 'invalid_credentials'));
  assert.equal(await readFile(f.file, 'utf8'), 'PORT=8788\n');
});

test('unsafe permissions, symlinks, directories, and tracked env files fail closed', async t => {
  const f = await fixture(t, 'PORT=8788\n');
  await chmod(f.file, 0o644);
  await assert.rejects(f.setup.status(), safeError(503, 'credentials_unavailable'));
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  await chmod(f.file, 0o600);
  const target = path.join(f.root, 'private-target');
  await writeFile(target, 'UNCHANGED\n', { mode: 0o600 });
  await rm(f.file);
  await symlink(target, f.file);
  await assert.rejects(f.setup.status(), safeError(503, 'credentials_unavailable'));
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  assert.equal(await readFile(target, 'utf8'), 'UNCHANGED\n');
  await rm(f.file);
  await mkdir(f.file);
  await assert.rejects(f.setup.status(), safeError(503, 'credentials_unavailable'));
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  await rm(f.file, { recursive: true });
  await writeFile(f.file, 'PORT=8788\n', { mode: 0o600 });
  await execute('git', ['add', '-f', '--', '.env'], { cwd: f.root, env: { PATH: process.env.PATH } });
  await assert.rejects(f.setup.status(), safeError(503, 'credentials_unavailable'));
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
});

test('oversized existing env files fail before credential writes', async t => {
  const original = '#'.repeat(65500);
  const f = await fixture(t, original);
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  assert.equal(await readFile(f.file, 'utf8'), original);
  await writeFile(f.file, '#'.repeat(65537));
  await assert.rejects(f.setup.status(), safeError(503, 'credentials_unavailable'));
});

test('an env file must be ignored; duplicate and noncanonical flags cannot bypass disabled settings', async t => {
  const f = await fixture(t, 'PAYMENTS_LIVE=false\nPAYMENTS_LIVE=true\n');
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  await writeFile(f.file, 'export TWITCH_CONNECT=true\n');
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
  await writeFile(path.join(f.root, '.gitignore'), '');
  await assert.rejects(f.setup.save(complete), safeError(503, 'credentials_unavailable'));
});

test('concurrent partial writes retain each credential under the existing atomic lock', async t => {
  const f = await fixture(t);
  await Promise.all(Object.entries(complete).map(([key, value]) => f.setup.save({ [key]: value })));
  assert.deepEqual(await f.setup.status(), { present });
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
});

async function browserFixture({ failSave = false, authStart = { stage: 'idle' },
  authPoll = { stage: 'authorized', userId: '67890' }, failCopy = false } = {}) {
  const nodes = new Map();
  for (const selector of ['#credentials-form', '#credentials-fields', '#extension-secret', '#setup-status',
    '#present-client', '#present-secret', '#present-owner', '#present-broadcaster',
    '#start-twitch-auth', '#device-auth-details', '#device-user-code', '#copy-device-code', '#toggle-device-code', '#twitch-activation-link', '#twitch-auth-status'])
    nodes.set(selector, { value: '', textContent: '', disabled: true,
      type: 'password', setAttribute(name, value) { this[name] = value; },
      hidden: true, removeAttribute(name) { delete this[name]; },
      classList: { toggle() {} }, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } });
  const form = nodes.get('#credentials-form');
  const inputs = Object.fromEntries(CREDENTIAL_KEYS.map(key => [key, key === 'TWITCH_EXT_SECRET'
    ? nodes.get('#extension-secret') : { value: '' }]));
  form.elements = { namedItem: key => inputs[key] };
  const calls = [];
  const copied = [];
  const timers = new Map();
  const windowListeners = {};
  let timerId = 0;
  let authStarted = false;
  const context = vm.createContext({ document: { querySelector: selector => nodes.get(selector) },
    window: { addEventListener(type, handler) { windowListeners[type] = handler; } },
    navigator: { clipboard: { async writeText(value) {
      if (failCopy) throw Error('Private browser error');
      copied.push(value);
    } } },
    URL, setTimeout: (handler, delay) => { timers.set(++timerId, { handler, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/operator/auth') {
        if (options.method === 'POST') authStarted = true;
        const result = options.method === 'POST' ? authStart : authStarted ? authPoll : { stage: 'idle' };
        return { ok: true, json: async () => result };
      }
      if (options.method === 'POST') return { ok: !failSave,
        json: async () => ({ ok: true, present, untrusted: sampleSecret }) };
      return { ok: true, json: async () => ({ present, TWITCH_EXT_SECRET: sampleSecret }) };
    } });
  vm.runInContext(await readFile(new URL('../public/setup.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, inputs, form, calls, timers, windowListeners, copied };
}

test('setup UI never prefills saved values and submits only four whitelisted inputs', async () => {
  const b = await browserFixture();
  assert.deepEqual(b.calls.map(call => call.url), ['/api/operator/bootstrap', '/api/operator/credentials', '/api/operator/auth']);
  for (const input of Object.values(b.inputs)) assert.equal(input.value, '');
  for (const [key, value] of Object.entries(complete)) b.inputs[key].value = value;
  await b.form.listeners.submit({ preventDefault() {} });
  const request = b.calls.at(-1);
  assert.equal(request.options.headers['X-Sealed-Action'], '1');
  assert.deepEqual(JSON.parse(request.options.body), complete);
  assert.equal(b.inputs.TWITCH_EXT_SECRET.value, '');
  assert.match(b.nodes.get('#setup-status').textContent, /Restart the server/);
  for (const node of b.nodes.values()) assert.ok(!node.textContent.includes(sampleSecret));
});

test('setup UI clears secret on server failure and native validation failure', async () => {
  const b = await browserFixture({ failSave: true });
  b.inputs.TWITCH_EXT_SECRET.value = sampleSecret;
  const pending = b.form.listeners.submit({ preventDefault() {} });
  assert.equal(b.inputs.TWITCH_EXT_SECRET.value, '');
  await pending;
  assert.equal(b.inputs.TWITCH_EXT_SECRET.value, '');
  assert.match(b.nodes.get('#setup-status').textContent, /not confirmed/);
  assert.equal(b.nodes.get('#credentials-fields').disabled, false);
  b.inputs.TWITCH_EXT_SECRET.value = sampleSecret;
  b.form.listeners.invalid();
  assert.equal(b.inputs.TWITCH_EXT_SECRET.value, '');
});

test('setup HTML uses a password input and relative local assets', async () => {
  const html = await readFile(new URL('../public/setup.html', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/setup\.js"/);
  assert.match(html, /id="extension-secret"[^>]*type="password"[^>]*autocomplete="off"/);
  assert.match(html, /id="device-user-code"[^>]*type="password"[^>]*readonly[^>]*autocomplete="off"/);
  assert.doesNotMatch(html, /https?:\/\/|value="/);
});

test('authorization starts only on click and keeps the activation code masked and out of status', async () => {
  const userCode = 'PRIVATE-ACTIVATE';
  const b = await browserFixture({ authStart: { stage: 'waiting', user_code: userCode,
    verification_uri: 'https://www.twitch.tv/activate?user_code=' + userCode,
    expires_at: Date.now() + 60000 } });
  assert.equal(b.calls.some(call => call.options.method === 'POST'), false);
  assert.equal(b.timers.size, 0);
  await b.nodes.get('#start-twitch-auth').listeners.click();
  const request = b.calls.at(-1);
  assert.equal(request.url, '/api/operator/auth');
  assert.equal(request.options.headers['X-Sealed-Action'], '1');
  assert.deepEqual(JSON.parse(request.options.body), {});
  assert.equal(b.nodes.get('#device-user-code').value, userCode);
  assert.equal(b.nodes.get('#twitch-activation-link').href, 'https://www.twitch.tv/activate');
  for (const node of b.nodes.values()) assert.ok(!node.textContent.includes(userCode));
  const polling = [...b.timers.values()].find(timer => timer.delay === 2000);
  assert.ok(polling);
  await polling.handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.nodes.get('#device-user-code').value, '');
  assert.equal(b.timers.size, 0);
  assert.match(b.nodes.get('#twitch-auth-status').textContent, /67890/);
});

test('authorization clears code on failure, expiry, and page exit', async () => {
  const waiting = { stage: 'waiting', user_code: 'PRIVATE-CODE',
    verification_uri: 'https://www.twitch.tv/activate', expires_at: Date.now() + 60000 };
  const b = await browserFixture({ authStart: waiting, authPoll: { stage: 'failed', reason: 'PRIVATE-CODE' } });
  await b.nodes.get('#start-twitch-auth').listeners.click();
  await [...b.timers.values()].find(timer => timer.delay === 2000).handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.nodes.get('#device-user-code').value, '');
  assert.ok(!b.nodes.get('#twitch-auth-status').textContent.includes('PRIVATE-CODE'));
  await b.nodes.get('#start-twitch-auth').listeners.click();
  const expiry = [...b.timers.values()].find(timer => timer.delay > 2000);
  assert.ok(expiry);
  expiry.handler();
  assert.equal(b.nodes.get('#device-user-code').value, '');
  assert.equal(b.timers.size, 0);
  assert.match(b.nodes.get('#twitch-auth-status').textContent, /expired/);
  await b.nodes.get('#start-twitch-auth').listeners.click();
  b.windowListeners.pagehide();
  assert.equal(b.nodes.get('#device-user-code').value, '');
  assert.equal(b.timers.size, 0);
});

test('authorization rejects activation URLs outside the exact Twitch activation hosts', async () => {
  for (const verification_uri of ['https://www.twitch.tv.evil.test/activate',
    'https://www.twitch.tv@evil.test/activate', 'http://www.twitch.tv/activate',
    'https://www.twitch.tv:444/activate', 'https://www.twitch.tv/unrelated']) {
    const b = await browserFixture({ authStart: { stage: 'waiting', user_code: 'PRIVATE-CODE', verification_uri } });
    await b.nodes.get('#start-twitch-auth').listeners.click();
    assert.equal(b.nodes.get('#twitch-activation-link').href, undefined);
    assert.equal(b.nodes.get('#twitch-activation-link').hidden, true);
    assert.equal(b.nodes.get('#device-user-code').value, '');
    b.windowListeners.pagehide();
  }
});

test('activation code copies only after an explicit click and never enters status text', async () => {
  const userCode = 'PRIVATE-COPY-CODE';
  const b = await browserFixture({ authStart: { stage: 'waiting', user_code: userCode,
    verification_uri: 'https://www.twitch.tv/activate', expires_at: Date.now() + 60000 } });
  const copy = b.nodes.get('#copy-device-code');
  assert.equal(copy.disabled, true);
  await copy.listeners.click();
  assert.deepEqual(b.copied, []);
  await b.nodes.get('#start-twitch-auth').listeners.click();
  assert.equal(copy.disabled, false);
  assert.deepEqual(b.copied, []);
  await copy.listeners.click();
  assert.deepEqual(b.copied, [userCode]);
  assert.equal(b.nodes.get('#twitch-auth-status').textContent,
    'Activation code copied. Paste it only on the Twitch activation page.');
  for (const node of b.nodes.values()) assert.ok(!node.textContent.includes(userCode));
  b.windowListeners.pagehide();
  assert.equal(copy.disabled, true);
  assert.equal(b.nodes.get('#device-user-code').value, '');
  await copy.listeners.click();
  assert.deepEqual(b.copied, [userCode]);
});

test('clipboard failure displays only a generic message and terminal auth disables copying', async () => {
  const userCode = 'PRIVATE-COPY-FAILURE';
  const b = await browserFixture({ failCopy: true, authStart: { stage: 'waiting', user_code: userCode,
    verification_uri: 'https://www.twitch.tv/activate' } });
  await b.nodes.get('#start-twitch-auth').listeners.click();
  await b.nodes.get('#copy-device-code').listeners.click();
  assert.match(b.nodes.get('#twitch-auth-status').textContent, /Copy was not confirmed/);
  for (const node of b.nodes.values()) assert.ok(!node.textContent.includes(userCode));
  await [...b.timers.values()].find(timer => timer.delay === 2000).handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.nodes.get('#copy-device-code').disabled, true);
  assert.equal(b.nodes.get('#device-user-code').value, '');
});

test('activation code is masked until an explicit toggle and remasked on terminal state or exit', async () => {
  const b = await browserFixture({ authStart: { stage: 'waiting', user_code: 'PRIVATE-SHOW-CODE',
    verification_uri: 'https://www.twitch.tv/activate' } });
  const input = b.nodes.get('#device-user-code');
  const toggle = b.nodes.get('#toggle-device-code');
  assert.equal(input.type, 'password');
  assert.equal(toggle.disabled, true);
  await b.nodes.get('#start-twitch-auth').listeners.click();
  assert.equal(input.type, 'password');
  assert.equal(toggle.disabled, false);
  toggle.listeners.click();
  assert.equal(input.type, 'text');
  assert.equal(toggle.textContent, 'Hide activation code');
  toggle.listeners.click();
  assert.equal(input.type, 'password');
  toggle.listeners.click();
  await [...b.timers.values()].find(timer => timer.delay === 2000).handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.type, 'password');
  assert.equal(input.value, '');
  assert.equal(toggle.disabled, true);
  await b.nodes.get('#start-twitch-auth').listeners.click();
  toggle.listeners.click();
  b.windowListeners.pagehide();
  assert.equal(input.type, 'password');
  assert.equal(input.value, '');
  assert.equal(toggle.disabled, true);
});

test('same-code polling preserves an explicit reveal for at most ten seconds', async () => {
  const waiting = { stage: 'waiting', user_code: 'PRIVATE-STABLE-CODE',
    verification_uri: 'https://www.twitch.tv/activate' };
  const b = await browserFixture({ authStart: waiting, authPoll: waiting });
  const input = b.nodes.get('#device-user-code');
  const toggle = b.nodes.get('#toggle-device-code');
  await b.nodes.get('#start-twitch-auth').listeners.click();
  toggle.listeners.click();
  await [...b.timers.values()].find(timer => timer.delay === 2000).handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.type, 'text');
  assert.equal(input.value, waiting.user_code);
  assert.equal(toggle.textContent, 'Hide activation code');
  const automaticHide = [...b.timers.values()].find(timer => timer.delay === 10000);
  assert.ok(automaticHide);
  automaticHide.handler();
  assert.equal(input.type, 'password');
  assert.equal(toggle.textContent, 'Show activation code');
  b.windowListeners.pagehide();
  assert.equal(b.timers.size, 0);
});

test('polling a different activation code resets an explicit reveal immediately', async () => {
  const b = await browserFixture({ authStart: { stage: 'waiting', user_code: 'FIRST-PRIVATE-CODE',
    verification_uri: 'https://www.twitch.tv/activate' }, authPoll: { stage: 'waiting',
    user_code: 'SECOND-PRIVATE-CODE', verification_uri: 'https://www.twitch.tv/activate' } });
  await b.nodes.get('#start-twitch-auth').listeners.click();
  b.nodes.get('#toggle-device-code').listeners.click();
  await [...b.timers.values()].find(timer => timer.delay === 2000).handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.nodes.get('#device-user-code').type, 'password');
  assert.equal(b.nodes.get('#device-user-code').value, 'SECOND-PRIVATE-CODE');
  assert.equal([...b.timers.values()].some(timer => timer.delay === 10000), false);
  b.windowListeners.pagehide();
});
