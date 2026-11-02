import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { TwitchDeviceFlow } from '../server/twitch-device-flow.js';
import { readEnv } from '../server/env-store.js';
const exec = promisify(execFile);
const scopes = ['user:read:chat', 'moderator:read:followers'];
async function fixture(t, values = 'TWITCH_EXT_CLIENT_ID=newextension123\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sealed-device-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, '.gitignore'), '.env\n.env.*\nruns/\n');
  await writeFile(path.join(root, '.env'), values, { mode: 0o600 });
  return root;
}
function provider({ login = 'wilf_lin', pending = 0, denial = false, uri = 'https://www.twitch.tv/activate',
  deviceStatus = 200, invalidScopes = false, fail = false } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, client: init.body?.get('client_id'), grant: init.body?.get('grant_type') });
    if (fail) throw Error('MOCK-PRIVATE-PROVIDER-FRAGMENT');
    init.signal?.throwIfAborted();
    if (url.endsWith('/device')) return Response.json(deviceStatus === 200 ? {
      device_code: 'MOCK-PRIVATE-DEVICE', user_code: 'MOCK-CODE', verification_uri: uri, expires_in: 600, interval: 1,
    } : { message: 'MOCK-PRIVATE-PROVIDER-FRAGMENT' }, { status: deviceStatus });
    if (url.endsWith('/token')) {
      if (pending-- > 0) return Response.json({ message: 'authorization_pending' }, { status: 400 });
      if (denial) return Response.json({ message: 'access_denied' }, { status: 400 });
      return Response.json({ access_token: 'MOCK-PRIVATE-ACCESS', refresh_token: 'MOCK-PRIVATE-REFRESH', scope: invalidScopes ? [] : scopes });
    }
    return Response.json({ client_id: 'newextension123', user_id: '456', login, scopes, expires_in: 3600 });
  };
  return { fetcher, calls };
}
const drain = async flow => { if (flow.task) await flow.task; };
const noOAuth = value => {
  const text = JSON.stringify(value);
  for (const secret of ['MOCK-PRIVATE-DEVICE', 'MOCK-PRIVATE-ACCESS', 'MOCK-PRIVATE-REFRESH', 'MOCK-PRIVATE-PROVIDER-FRAGMENT'])
    assert.ok(!text.includes(secret));
};

test('device flow reads private storage only on explicit start, coalesces and durably binds the expected account', async t => {
  const root = await fixture(t, 'TWITCH_EXT_CLIENT_ID=newextension123\nTWITCH_CONNECT=true\nPAYMENTS_LIVE=true\n');
  const p = provider({ pending: 1 });
  const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher,
    env: { TWITCH_TOKEN: 'OLD-ACCESS-DO-NOT-ADOPT', TWITCH_REFRESH_TOKEN: 'OLD-REFRESH-DO-NOT-ADOPT' } });
  t.after(() => flow.close());
  assert.deepEqual(flow.status(), { stage: 'idle' }); assert.equal(p.calls.length, 0);
  const first = flow.start(), second = flow.start(); assert.equal(first, second);
  const waiting = await first;
  assert.equal(waiting.stage, 'waiting'); assert.equal(waiting.user_code, 'MOCK-CODE'); noOAuth(waiting);
  assert.equal((await flow.start()).stage, 'waiting');
  assert.equal(p.calls.filter(call => call.url.endsWith('/device')).length, 1);
  await drain(flow);
  const result = flow.status(); assert.equal(result.stage, 'authorized'); assert.equal(result.userId, '456');
  assert.ok(!('user_code' in result)); noOAuth(result);
  const saved = await readEnv(path.join(root, '.env'));
  assert.equal(saved.TWITCH_CLIENT_ID, 'newextension123'); assert.equal(saved.TWITCH_TOKEN, 'MOCK-PRIVATE-ACCESS');
  assert.equal(saved.TWITCH_REFRESH_TOKEN, 'MOCK-PRIVATE-REFRESH'); assert.equal(saved.TWITCH_EXT_OWNER_ID, '456');
  assert.equal(saved.TWITCH_BROADCASTER_ID, '456');
  for (const key of ['TWITCH_CONNECT', 'PAYMENTS_LIVE', 'TWITCH_SIGNALS', 'DECISIONS_LIVE', 'TWITCH_POLLS', 'TWITCH_SUBSCRIPTIONS', 'TWITCH_AUTO_SESSION', 'OBS_FRAME_WATCHER', 'ASTRA_CONDITIONS', 'SPEECH_WATCHER'])
    assert.equal(saved[key], 'false');
  assert.equal((await stat(path.join(root, '.env'))).mode & 0o777, 0o600);
  noOAuth(await readFile(path.join(root, 'runs/twitch-auth.jsonl'), 'utf8'));
  const count = p.calls.length; await flow.start(); assert.equal(p.calls.length, count);
});

test('device flow rejects a different old OAuth client before any network request', async t => {
  const root = await fixture(t, 'TWITCH_EXT_CLIENT_ID=newextension123\nTWITCH_CLIENT_ID=oldoauth123\n');
  const p = provider(); const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher });
  assert.deepEqual(await flow.start(), { stage: 'failed', reason: 'client_mismatch' });
  await drain(flow); assert.equal(p.calls.length, 0);
});

test('wrong account is rejected before tokens or owner identity are persisted', async t => {
  const root = await fixture(t); const p = provider({ login: 'someone_else' });
  const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher });
  await flow.start(); await drain(flow);
  assert.equal(flow.status().stage, 'failed'); assert.equal(flow.status().reason, 'account_mismatch');
  const saved = await readEnv(path.join(root, '.env'));
  assert.equal(saved.TWITCH_TOKEN, undefined); assert.equal(saved.TWITCH_EXT_OWNER_ID, undefined); noOAuth(flow.status());
});

test('access denial and missing scopes expose fixed reasons without provider content', async t => {
  for (const [options, reason] of [[{ denial: true }, 'access_denied'], [{ invalidScopes: true }, 'missing_scopes']]) {
    const root = await fixture(t); const p = provider(options);
    const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher }); await flow.start(); await drain(flow);
    assert.equal(flow.status().reason, reason); noOAuth(flow.status());
    assert.equal((await readEnv(path.join(root, '.env'))).TWITCH_TOKEN, undefined);
  }
});

test('device HTTP rejection returns a status code and enum only', async t => {
  const root = await fixture(t); const p = provider({ deviceStatus: 400 });
  const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher });
  assert.deepEqual(await flow.start(), { stage: 'failed', reason: 'provider_rejected', http_status: 400 });
  await drain(flow); noOAuth(flow.status());
});

test('network errors never expose raw exception content', async t => {
  const root = await fixture(t); const p = provider({ fail: true });
  const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher }); await flow.start(); await drain(flow);
  assert.deepEqual(flow.status(), { stage: 'failed', reason: 'authorization_failed' }); noOAuth(flow.status());
});

test('verification URLs and user codes stay on the private Twitch activation path', async t => {
  for (const uri of ['http://www.twitch.tv/activate', 'https://attacker.invalid/activate',
    'https://user:pass@www.twitch.tv/activate', 'https://www.twitch.tv/activate?device_code=private',
    'https://www.twitch.tv/activate#private', 'https://www.twitch.tv/unrelated']) {
    const root = await fixture(t); const p = provider({ uri });
    const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher }); await flow.start(); await drain(flow);
    assert.equal(flow.status().reason, 'invalid_device_response');
    assert.equal(p.calls.length, 1); assert.ok(!('user_code' in flow.status()));
  }
});

test('expired and closed flows remove the user code and cannot persist late tokens', async t => {
  for (const action of ['expire', 'stop', 'close']) {
    const root = await fixture(t); const p = provider(); let clock = 100000;
    const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher, now: () => clock });
    const waiting = await flow.start(); assert.equal(waiting.stage, 'waiting');
    if (action === 'expire') { clock = waiting.expires_at; flow.status(); }
    else flow[action]();
    await drain(flow);
    assert.equal(flow.status().stage, 'failed');
    assert.equal(flow.status().reason, action === 'expire' ? 'expired' : action === 'stop' ? 'cancelled' : 'closed');
    assert.ok(!('user_code' in flow.status())); assert.equal(p.calls.length, 1);
    assert.equal((await readEnv(path.join(root, '.env'))).TWITCH_TOKEN, undefined);
    if (action === 'close') assert.deepEqual(await flow.start(), { stage: 'failed', reason: 'closed' });
  }
});

test('storage rejects public modes, symlinks, tracked credentials and non-ignored files', async t => {
  for (const mode of ['public', 'symlink', 'tracked', 'not-ignored']) {
    const root = await fixture(t); const file = path.join(root, '.env');
    if (mode === 'public') await chmod(file, 0o644);
    if (mode === 'symlink') { await writeFile(path.join(root, 'target'), 'TWITCH_EXT_CLIENT_ID=newextension123\n', { mode: 0o600 }); await rm(file); await symlink(path.join(root, 'target'), file); }
    if (mode === 'tracked') await exec('git', ['-C', root, 'add', '--force', '.env']);
    if (mode === 'not-ignored') await writeFile(path.join(root, '.gitignore'), '');
    const p = provider(); const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher });
    assert.deepEqual(await flow.start(), { stage: 'failed', reason: 'storage_unavailable' });
    await drain(flow); assert.equal(p.calls.length, 0);
  }
});


test('documented Twitch verification URI is accepted but its embedded code is removed', async t => {
  const root = await fixture(t);
  const p = provider({ uri: 'https://www.twitch.tv/activate?public=true&device-code=MOCK-CODE' });
  const flow = new TwitchDeviceFlow({ root, fetcher: p.fetcher });
  const waiting = await flow.start();
  assert.equal(waiting.stage, 'waiting');
  assert.equal(waiting.verification_uri, 'https://www.twitch.tv/activate');
  assert.equal(waiting.user_code, 'MOCK-CODE');
  flow.stop(); await drain(flow);
  assert.ok(!('user_code' in flow.status()));
});

test('closing before start never reads storage or calls the provider', async () => {
  const flow = new TwitchDeviceFlow({ root: '/this/path/is/not/read', fetcher() { throw Error('Unexpected request'); } });
  flow.close();
  assert.deepEqual(await flow.start(), { stage: 'failed', reason: 'closed' });
});
