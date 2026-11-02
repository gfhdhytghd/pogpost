import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DebugRecorder } from '../server/debug-recorder.js';
import { Judgements } from '../server/judgements.js';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';
import { EventWatcher } from '../server/event-watcher.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
const event = { id: 'test-flash', label: 'Test flash', description: 'An explicit visible flash.', mode: 'instant', min_confidence: 0.85 };

test('mocked application records every capture, exact screen/review frames, raw provider output and candidate decisions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sealed-debug-pipeline-'));
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', (callback, interval) => { const timer = { unref() {} }; intervals.push({ callback, interval }); return timer; });
  let clock = 100000, sequence = 0;
  const recorder = await DebugRecorder.open({ directory: dir, now: () => clock });
  await recorder.setEnabled(true);
  const sent = [];
  const judge = new Judgements({ debugRecorder: recorder, keyReader: () => 'synthetic-private-key', fetchFn: async (_url, options) => {
    const body = JSON.parse(options.body);
    const images = Array.isArray(body.input[0].content) ? body.input[0].content.filter(part => part.type === 'input_image').length : 0;
    sent.push(images);
    return { ok: true, json: async () => ({ answers: body.questions.map(question => ({ name: question.name,
      type: 'choice', choice: question.name === 'scene' ? 'gameplay' : question.name === 'continuity' ? 'same' : question.name ? 'yes' : 'ready', confidence: 0.97 })),
      usage: { input_tokens: 123, output_tokens: 0, total_tokens: 123 } }) };
  } });
  const app = await createApplication({ store: new MemoryStore(), debugRecorder: recorder, decisions: judge, now: () => clock,
    env: { OBS_FRAME_WATCHER: 'true', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Synthetic Source', OBS_REVIEW_MODE: 'screened' },
    obsSourceFactory: () => ({ readObservation: async () => ({ id: String(++sequence), at: clock, dataUrl: PNG }), close() {} }) });
  try {
    await app.engine.importEventDefinitions([event]);
    const capture = intervals.find(item => item.interval === 200).callback;
    for (let i = 0; i < 6; i++) { clock += 200; capture(); await new Promise(resolve => setImmediate(resolve)); }
    await recorder.flush();
    const data = recorder.query({ limit: 100 });
    assert.equal(data.frames.length, 6, 'the profile-sync discarded capture is still recorded');
    assert.equal(data.requests.length, 2);
    const screen = data.requests.find(row => row.stage === 'screen');
    const review = data.requests.find(row => row.stage === 'review');
    assert.equal(screen.frame_ids.length, 1);
    assert.equal(review.frame_ids.length, 5);
    assert.equal(screen.frame_ids[0], review.frame_ids.at(-1));
    assert.equal(new Set(review.frame_ids).size, 5);
    const ordered = review.frame_ids.map(id => data.frames.find(frame => frame.id === id).captured_at);
    assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
    assert.equal(ordered.at(-1) - ordered[0], 800);
    assert.equal(screen.normalized.events[event.id].confidence, 0.97);
    assert.equal(review.normalized.events[event.id], 'yes');
    assert.equal(screen.raw.answers.find(answer => answer.name === 'event:' + event.id).confidence, 0.97);
    assert.equal(review.usage.input_tokens, 123);
    assert.equal(screen.status, 'ok');
    assert.equal(review.status, 'ok');
    assert.ok(data.decisions.some(row => row.reason === 'positive_screen_threshold'));
    assert.ok(data.decisions.some(row => row.reason === 'candidate_accepted'));
    assert.equal(app.engine.state.event_runtime.candidates.length, 1);
    assert.equal(app.engine.state.occurrences.length, 0);
    assert.ok(sent.includes(1) && sent.includes(5));
    const encoded = JSON.stringify(data);
    assert.equal(encoded.includes('synthetic-private-key'), false);
    assert.equal(encoded.includes('data:image'), false);
    for (const frame of data.frames) assert.ok((await recorder.image(frame.id))?.data);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('provider debug outcomes distinguish timeout, HTTP failure and malformed output without error text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sealed-debug-outcome-'));
  const recorder = await DebugRecorder.open({ directory: dir });
  await recorder.setEnabled(true);
  const frame = { id: '1', at: Date.now(), dataUrl: PNG };
  recorder.recordFrame(frame);
  try {
    const cases = [
      ['timeout', async () => new Promise(() => {})],
      ['http_error', async () => ({ ok: false })],
      ['malformed_response', async () => ({ ok: true, json: async () => ({ private: 'synthetic-private-error' }) })],
      ['transport_error', async () => { throw Error('synthetic-private-error'); }],
    ];
    for (const [outcome, fetchFn] of cases) {
      const judge = new Judgements({ debugRecorder: recorder, keyReader: () => 'synthetic-private-key', fetchFn, deadlines: { frameMs: 5 } });
      const requestId = recorder.beginRequest({ stage: 'screen', frames: [frame], definitions: [event] });
      const normalized = await judge.eventScreen(frame, [event], { debugRequestId: requestId });
      recorder.finishRequest(requestId, { normalized });
      const row = recorder.request(requestId);
      assert.equal(row.status, outcome);
      assert.equal(row.normalized.valid, false);
      assert.equal(row.raw, null);
      judge.close();
    }
    await recorder.flush();
    const value = JSON.stringify(recorder.query());
    assert.equal(value.includes('synthetic-private-error'), false);
    assert.equal(value.includes('synthetic-private-key'), false);
  } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
});

test('debug failures cannot prevent an instant candidate or application shutdown', async t => {
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', (callback, interval) => { const timer = { unref() {} }; intervals.push({ callback, interval }); return timer; });
  let clock = 0, seq = 0;
  const broken = new Proxy({}, { get() { return () => { throw Error('Synthetic disk failure'); }; } });
  const app = await createApplication({ store: new MemoryStore(), debugRecorder: broken, now: () => clock,
    env: { OBS_FRAME_WATCHER: 'true', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Mock' },
    decisions: { warmup() {}, close() {}, eventScreen: async () => ({ valid: true, scene: 'gameplay', events: { [event.id]: { choice: 'yes', confidence: 1 } } }),
      eventFrames: async () => ({ scene: 'gameplay', continuity: 'same', events: { [event.id]: 'yes' } }) },
    obsSourceFactory: () => ({ close() {}, readObservation: async () => ({ id: String(++seq), at: clock, dataUrl: PNG }) }) });
  await app.engine.importEventDefinitions([event]);
  const tick = intervals.find(row => row.interval === 200).callback;
  for (let i = 0; i < 6; i++) { clock += 200; tick(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(app.engine.state.event_runtime.candidates.length, 1);
  await app.close();
});

test('screen and review completions discarded by reset retain a request-linked diagnostic reason', async () => {
  for (const stage of ['screen', 'review']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sealed-debug-fence-'));
    let clock = 100000, resolveGate, entered;
    const gate = new Promise(resolve => { resolveGate = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const recorder = await DebugRecorder.open({ directory: dir, now: () => clock });
    await recorder.setEnabled(true);
    const screen = { valid: true, scene: 'gameplay', events: { [event.id]: { choice: 'yes', confidence: 0.99 } } };
    const review = { scene: 'gameplay', continuity: 'same', events: { [event.id]: 'yes' } };
    const watcher = new EventWatcher({ adaptive: true, definitions: [event], now: () => clock, debugRecorder: recorder,
      judgements: { eventScreen: async () => { if (stage === 'screen') { entered(); await gate; } return screen; },
        eventFrames: async () => { if (stage === 'review') { entered(); await gate; } return review; } } });
    try {
      for (let i = 0; i < 4; i++) {
        clock += 200; const frame = { id: String(i), at: clock, dataUrl: PNG };
        recorder.recordFrame(frame); await watcher.observe(frame);
      }
      clock += 200; const frame = { id: '4', at: clock, dataUrl: PNG };
      recorder.recordFrame(frame); const pending = watcher.observe(frame);
      await started;
      watcher.reset(); resolveGate(); await pending; await recorder.flush();
      const request = recorder.query().requests.find(row => row.stage === stage);
      const detail = recorder.query({ request_id: request.id });
      assert.ok(detail.decisions.some(row => row.kind === 'discard' && row.reason === 'epoch_changed' && row.request_id === request.id));
      assert.deepEqual(watcher.prompts(), []);
    } finally { resolveGate(); watcher.close(); await recorder.close(); await rm(dir, { recursive: true, force: true }); }
  }
});
