import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';
import { KSP_MOMENTS } from '../server/ksp-perception.js';

test('disabled KSP configuration neither registers moments nor starts capture or providers', async () => {
  let calls = 0;
  const app = await createApplication({ env: { OBS_GAME_PROFILE: 'ksp' }, store: new MemoryStore(),
    decisions: { frame() { calls++; }, kspFrames() { calls++; }, warmup() { calls++; }, close() {} } });
  try {
    assert.equal(calls, 0);
    assert.ok(!app.engine.config.moments.some(moment => moment.id.startsWith('ksp-')));
  } finally { await app.close(); }
});

test('explicit KSP startup adds its moments, exposes profile privately and permits observation reset', async () => {
  let frameCalls = 0;
  const app = await createApplication({ env: { OBS_FRAME_WATCHER: 'true', OBS_GAME_PROFILE: 'ksp', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Synthetic game source' },
    obsSourceFactory:()=>({readObservation:async()=>null,close(){}}),
    store: new MemoryStore(), decisions: { async warmup() {}, state: () => ({ status: 'ready' }), kspFrames() { frameCalls++; }, close() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    assert.deepEqual(app.engine.config.moments.filter(m => m.id.startsWith('ksp-')), KSP_MOMENTS);
    assert.ok(!app.engine.config.moments.some(m => m.id === 'ai-victory'));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const bootstrap = await fetch(base + '/api/operator/bootstrap');
    const Cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(base + '/api/operator/state', { headers: { Cookie } })).json();
    assert.equal(state.integrations.perception.profile, 'ksp');
    assert.equal(state.integrations.perception.enabled, true);
    const action = { method: 'POST', headers: { Cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_perception' }) };
    assert.equal((await fetch(base + '/api/operator/action', action)).status, 200);
    assert.equal((await fetch(base + '/api/operator/action', { ...action, headers: { ...action.headers, 'X-Forwarded-For': '198.51.100.1' } })).status, 403);
    // The interval has not run: this test opens no OBS socket and invokes no inference.
    assert.equal(frameCalls, 0);
  } finally { await app.close(); }
});

test('unknown perception profiles and missing prerequisites fail before model or OBS access', async () => {
  for (const env of [
    { OBS_FRAME_WATCHER: 'true', OBS_GAME_PROFILE: 'ksp' },
    { OBS_FRAME_WATCHER: 'true', OBS_GAME_PROFILE: 'unsupported', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Synthetic' },
  ]) {
    await assert.rejects(createApplication({ env, store: new MemoryStore() }), /explicit source|Unknown OBS game profile/);
  }
});
