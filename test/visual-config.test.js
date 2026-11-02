import test from 'node:test';
import assert from 'node:assert/strict';
import { visualConfig } from '../server/visual-config.js';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';

test('visual defaults select 360p, 5 Hz capture and an independent screening threshold', () => {
  assert.deepEqual(visualConfig(), { width: 640, height: 360, intervalMs: 200, adaptive: true, reviewMode: 'window', reviewConfidence: 0.6 });
  assert.deepEqual(visualConfig({ OBS_FRAME_WIDTH: '1280', OBS_FRAME_HEIGHT: '720', OBS_REVIEW_CONFIDENCE: '0.75' }),
    { width: 1280, height: 720, intervalMs: 200, adaptive: true, reviewMode: 'window', reviewConfidence: 0.75 });
  for (const env of [{ OBS_FRAME_WIDTH: '0' }, { OBS_FRAME_WIDTH: '640.5' }, { OBS_FRAME_HEIGHT: '1081' },
    { OBS_REVIEW_MODE: 'invalid' }, { OBS_FRAME_WIDTH: 'NaN' }, { OBS_REVIEW_CONFIDENCE: '0.49' }, { OBS_REVIEW_CONFIDENCE: '1.01' }, { OBS_REVIEW_CONFIDENCE: 'NaN' }]) {
    assert.throws(() => visualConfig(env), /Invalid OBS_/);
  }
});

test('enabled application wires adaptive dimensions and private diagnostics without connecting mocked sources', async () => {
  let options;
  const app = await createApplication({ store: new MemoryStore(),
    env: { OBS_FRAME_WATCHER: 'true', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Synthetic Source' },
    decisions: { warmup() {}, state: () => ({ status: 'mock' }), close() {} },
    obsSourceFactory(value) { options = value; return { readObservation: async () => null, state: () => ({ status: 'mock', interval_ms: value.intervalMs }), close() {} }; } });
  try {
    assert.deepEqual(options, { url: 'ws://127.0.0.1:4455', password: '', sourceName: 'Synthetic Source', width: 640, height: 360, intervalMs: 200, scheduleToleranceMs: 20 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const Cookie = (await fetch(base + '/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(base + '/api/operator/state', { headers: { Cookie } })).json();
    assert.equal(state.integrations.perception.watcher.strategy, 'direct_window');
    assert.equal(state.integrations.perception.watcher.review_confidence, 0.6);
    assert.equal(state.integrations.perception.watcher.screen_interval_ms, 1000);
    assert.equal(state.integrations.perception.watcher.review_frames, 5);
    assert.equal((await fetch(base + '/api/operator/state')).status, 401);
    assert.equal((await fetch(base + '/api/operator/state', { headers: { Cookie, 'X-Forwarded-For': '198.51.100.2' } })).status, 403);
  } finally { await app.close(); }
});

test('screened mode remains an explicit cost-saving option', () => {
  assert.equal(visualConfig({OBS_REVIEW_MODE:'screened'}).reviewMode, 'screened');
});
