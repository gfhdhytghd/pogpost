import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';
import { eventProfileContext } from '../server/event-profiles.js';
import { createApplication } from '../server/index.js';
import { createHTTP } from '../server/http.js';
import generic from '../presets/generic.json' with { type: 'json' };

// State, HTTP, observations and inference are local mocks. No provider or environment file is read.
const definitions = () => [
  { id: 'review-event', label: 'Review event', description: 'A clear visible review event.', mode: 'instant', auto_confirm: false },
  { id: 'automatic-event', label: 'Automatic event', description: 'A clear local automatic event.', mode: 'instant', auto_confirm: true },
];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const currentContext = engine => eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch);
const apply = (engine, profile) => engine.activateEventProfile({ kind: 'profile', id: profile.id, expected_revision: profile.revision });
const trigger = (key, event_id = 'review-event') => ({ event_id, idempotency_key: key });
const options = prompt => ({ expectedSessionId: prompt.expectedSessionId, expiresAt: prompt.expires_at,
  expectedEventDefinition: prompt.definitionFingerprint, expectedProfileContext: prompt.expectedProfileContext });
async function fixture({ events = definitions(), store = new MemoryStore() } = {}) {
  let clock = 100000;
  const engine = new NotesEngine({ store, decisions: new DemoJudgements(), now: () => clock });
  const first = await engine.saveEventProfile({ label: 'Profile A', events });
  const second = await engine.saveEventProfile({ label: 'Profile B', events });
  await apply(engine, first);
  return { engine, first, second, events: new EventSystem({ engine, now: () => clock }),
    now: () => clock, advance(ms) { clock += ms; } };
}

test('same-content profile identity changes invalidate pending AI and API candidates without clearing policy ledgers', async () => {
  for (const source of ['ai', 'api']) {
    const f = await fixture();
    const candidate = source === 'ai' ? await f.events.propose('review-event', { observedAt: f.now() }) : await f.events.trigger(trigger('pending'));
    assert.equal(f.events.prompts().length, 1);
    const before = structuredClone(f.engine.state.event_runtime);
    assert.equal(before.candidates[0].profileContext, currentContext(f.engine));
    assert.ok(!JSON.stringify(candidate).includes(f.first.id));
    assert.equal(Object.hasOwn(candidate, 'profileContext'), false);
    await apply(f.engine, f.second);
    assert.deepEqual(f.events.prompts(), []);
    assert.equal(await f.events.confirm(candidate.candidate_id), null);
    assert.deepEqual(f.engine.state.event_runtime.candidates, []);
    assert.deepEqual(f.engine.state.event_runtime.receipts, before.receipts);
    assert.deepEqual(f.engine.state.event_runtime.cooldowns, before.cooldowns);
    assert.equal(f.engine.state.occurrences.length, 0);
    await assert.rejects(f.events.trigger(trigger('new-key')), { status: 429, code: 'event_cooldown' });
  }
});

test('already-consumed confirmations cannot occur under a different same-content profile', async () => {
  const f = await fixture();
  const candidate = await f.events.propose('review-event', { observedAt: f.now() });
  const prompt = await f.events.confirm(candidate.candidate_id);
  assert.equal(prompt.expectedProfileContext, currentContext(f.engine));
  await apply(f.engine, f.second);
  await assert.rejects(f.engine.occur(prompt.moment_id, 'Synthetic context', 'ai-confirmed', options(prompt)), { status: 409, code: 'stale_profile_context' });
  assert.equal(f.engine.state.occurrences.length, 0);
});

test('queued AI and API requests capture profile context before mutation admission including ABA switches', async t => {
  for (const source of ['ai', 'api']) for (const aba of [false, true]) await t.test(source + (aba ? ' ABA' : ''), async () => {
    const f = await fixture();
    const entered = deferred(), gate = deferred();
    const blocker = f.engine._mutate(async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const activation = apply(f.engine, f.second);
    const restore = aba ? apply(f.engine, f.first) : null;
    const pending = source === 'ai' ? f.events.propose('review-event', { observedAt: f.now() }) : f.events.trigger(trigger('queued'));
    const result = source === 'ai' ? pending : assert.rejects(pending, { status: 409, code: 'stale_profile_context' });
    gate.resolve();
    await Promise.all([blocker, activation, restore]);
    if (source === 'ai') assert.equal(await result, null); else await result;
    assert.deepEqual(f.events.prompts(), []);
    assert.equal(f.engine.state.occurrences.length, 0);
    assert.equal(f.engine.state.event_runtime?.receipts.length ?? 0, 0);
  });
});

test('an accepted automatic reservation is revalidated against profile context before occur including ABA switches', async t => {
  for (const aba of [false, true]) await t.test(aba ? 'ABA' : 'different profile', async () => {
  const f = await fixture();
  const entered = deferred(), gate = deferred();
  const occur = f.engine.occur.bind(f.engine);
  let calls = 0;
  f.engine.occur = async (...args) => { calls++; entered.resolve(); await gate.promise; return occur(...args); };
  const body = trigger('automatic-wait', 'automatic-event');
  const pending = f.events.trigger(body);
  const rejected = assert.rejects(pending, { status: 409, code: 'stale_profile_context' });
  await entered.promise;
  await apply(f.engine, f.second);
  if (aba) await apply(f.engine, f.first);
  gate.resolve();
  await rejected;
  assert.equal(f.engine.state.occurrences.length, 0);
  assert.equal(f.engine.state.event_runtime.receipts[0].result.error, 'stale_profile_context');
  assert.equal(Object.hasOwn(f.engine.state.event_runtime.receipts[0].result, 'profileContext'), false);
  await assert.rejects(f.events.trigger(body), { status: 409, code: 'stale_profile_context' });
  assert.equal(calls, 1, 'an idempotent rejected reservation never becomes a second automatic occur');
  });
});

test('same-context reapply and saving a new snapshot leave current candidates valid', async () => {
  const f = await fixture();
  const candidate = await f.events.trigger(trigger('stable'));
  const context = currentContext(f.engine);
  await apply(f.engine, f.first);
  assert.equal(currentContext(f.engine), context);
  assert.equal(f.events.prompts()[0].id, candidate.candidate_id);
  const saved = await f.engine.saveEventProfile({ id: f.first.id, expected_revision: 1, label: 'Saved revision two', events: f.first.events });
  assert.equal(saved.revision, 2);
  assert.equal(currentContext(f.engine), context);
  const prompt = await f.events.confirm(candidate.candidate_id);
  assert.ok(prompt);
  await f.engine.occur(prompt.moment_id, 'Synthetic context', 'api-confirmed', options(prompt));
  assert.equal(f.engine.state.occurrences.length, 1);
  const replay = await f.events.trigger(trigger('stable'));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.receipt_id, candidate.receipt_id);
});

test('kind and revision changes fence identical definitions, not only different profile ids', async t => {
  for (const change of ['kind', 'revision']) await t.test(change, async () => {
    const f = await fixture({ events: generic.events });
    const eventId = f.first.events[0].id;
    const candidate = await f.events.propose(eventId, { observedAt: f.now() });
    const prompt = await f.events.confirm(candidate.candidate_id);
    const originalEvents = f.engine.config.events;
    if (change === 'kind') await f.engine.activateEventProfile({ kind: 'builtin', id: 'generic' });
    else {
      const saved = await f.engine.saveEventProfile({ id: f.first.id, expected_revision: 1, label: f.first.label, events: f.first.events });
      await apply(f.engine, saved);
    }
    assert.deepEqual(f.engine.config.events, originalEvents);
    await assert.rejects(f.engine.occur(prompt.moment_id, {}, 'ai-confirmed', options(prompt)), { status: 409, code: 'stale_profile_context' });
    assert.equal(f.engine.state.occurrences.length, 0);
  });
});

test('restart retains context fencing and legacy unlinked candidates remain compatible', async () => {
  const f = await fixture();
  const accepted = await f.events.trigger(trigger('durable'));
  const snapshot = f.engine.store.read();
  const restarted = new NotesEngine({ store: new MemoryStore(snapshot), decisions: new DemoJudgements(), now: f.now });
  const events = new EventSystem({ engine: restarted, now: f.now });
  assert.equal(events.prompts()[0].id, accepted.candidate_id);
  await apply(restarted, f.second);
  assert.deepEqual(events.prompts(), []);
  const legacy = new NotesEngine({ decisions: new DemoJudgements(), now: f.now });
  await legacy.importEventDefinitions(definitions());
  const oldEvents = new EventSystem({ engine: legacy, now: f.now });
  const old = await oldEvents.trigger(trigger('legacy'));
  await legacy._mutate(() => { delete legacy.state.event_runtime.candidates[0].profileContext; delete legacy.state.event_profile_context_epoch; });
  const legacyReloaded = new NotesEngine({ store: new MemoryStore(legacy.store.read()), decisions: new DemoJudgements(), now: f.now });
  const legacyEvents = new EventSystem({ engine: legacyReloaded, now: f.now });
  assert.equal(legacyEvents.prompts()[0].id, old.candidate_id);
  assert.equal((await legacyEvents.confirm(old.candidate_id)).expectedProfileContext, '');
});

test('session rollover still fences a confirmation when profile context itself is unchanged', async () => {
  const f = await fixture();
  const accepted = await f.events.propose('review-event', { observedAt: f.now() });
  const prompt = await f.events.confirm(accepted.candidate_id);
  await f.engine.newSession();
  await assert.rejects(f.engine.occur(prompt.moment_id, {}, 'ai-confirmed', options(prompt)), { status: 409, code: 'stale_confirmation' });
  assert.equal(f.engine.state.occurrences.length, 0);
});

test('HTTP confirmation passes the captured profile context through the confirm-to-occur race', async t => {
  const f = await fixture();
  const accepted = await f.events.propose('review-event', { observedAt: f.now() });
  const watcher = { async confirm(id) { const prompt = await f.events.confirm(id); await apply(f.engine, f.second); return prompt; }, prompts: () => [] };
  const server = await createHTTP({ engine: f.engine, watcher });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base + '/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/operator/action', { method: 'POST', headers: {
    Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ action: 'confirm_ai', id: accepted.candidate_id, approve: true }) });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'stale_profile_context');
  assert.equal(body.message, 'The active event profile changed. Refresh suggestions before confirming.');
  assert.ok(!JSON.stringify(body).includes(f.first.id));
  assert.equal(f.engine.state.occurrences.length, 0);
});

test('HTTP queued confirmation cannot survive Apply A to B to A with identical definitions', async t => {
  const f = await fixture();
  await f.engine.submit({ opaqueId: 'Uprofilefence' }, { body: 'Private profile note', category_id: 'advice', moment_id: 'review-event', payment_mode: 'sim_points', request_id: 'aba-note' });
  const accepted = await f.events.propose('review-event', { observedAt: f.now() });
  const server = await createHTTP({ engine: f.engine, eventSystem: f.events, watcher: f.events });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base + '/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
  const entered = deferred(), gate = deferred(), confirmEnqueued = deferred();
  t.after(() => gate.resolve());
  const blocker = f.engine._mutate(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  const originalConfirm = f.events.confirm.bind(f.events);
  f.events.confirm = id => { const pending = originalConfirm(id); confirmEnqueued.resolve(); return pending; };
  const request = fetch(base + '/api/operator/action', { method: 'POST', headers: {
    Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ action: 'confirm_ai', id: accepted.candidate_id, approve: true }) });
  await confirmEnqueued.promise;
  const second = apply(f.engine, f.second);
  const restored = apply(f.engine, f.first);
  gate.resolve();
  await Promise.all([blocker, second, restored]);
  const response = await request;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'stale_profile_context');
  assert.equal(f.engine.state.occurrences.length, 0);
  assert.deepEqual(f.engine.archive(), []);
});

test('application capture and in-flight model results are fenced by profile identity with identical definitions', async t => {
  for (const phase of ['capture', 'screen', 'model']) await t.test(phase, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sealed-profile-fence-'));
    await mkdir(path.join(directory, 'public'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const intervals = [];
    t.mock.method(globalThis, 'setInterval', (callback, interval) => { const timer = { unref() {} }; intervals.push({ callback, interval }); return timer; });
    let clock = 100000, sequence = 0, calls = 0;
    const entered = deferred(), gate = deferred();
    let holdCapture = false, holdScreen = false, holdModel = false;
    const app = await createApplication({ root: directory, store: new MemoryStore(), now: () => clock,
      env: { OBS_FRAME_WATCHER: 'true', OBS_REVIEW_MODE: 'screened', DECISIONS_LIVE: 'true', OBS_SOURCE_NAME: 'Mock source' },
      compiler: { state: () => ({ status: 'disabled' }), close() {} },
      decisions: { state: () => ({ status: 'mock' }), warmup() {}, close() {}, async eventScreen() {
        if (holdScreen) { entered.resolve(); await gate.promise; }
        return { valid: true, scene: 'gameplay', events: { 'visual-event': { choice: 'yes', confidence: 0.9 } } };
      }, async eventFrames() {
        calls++;
        if (holdModel) { entered.resolve(); await gate.promise; }
        return { scene: 'gameplay', continuity: 'same', events: { 'visual-event': 'yes' } };
      } }, obsSourceFactory: () => ({ close() {}, async readObservation() {
        if (holdCapture) { entered.resolve(); await gate.promise; }
        return { id: String(++sequence), at: clock, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
      } }) });
    t.after(() => app.close());
    const definitions = [{ id: 'visual-event', label: 'Visual event', description: 'A visible example event.', mode: 'instant' }];
    const first = await app.engine.saveEventProfile({ label: 'Visual A', events: definitions });
    const second = await app.engine.saveEventProfile({ label: 'Visual B', events: definitions });
    await apply(app.engine, first);
    const capture = intervals.find(item => item.interval === 200).callback;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    // The first capture synchronizes changed definitions; the next four prime the adaptive buffer.
    for (let i = 0; i < 5; i++) { clock += 200; capture(); await settle(); }
    if (phase === 'capture') holdCapture = true; else if (phase === 'screen') holdScreen = true; else holdModel = true;
    clock += 200; capture(); await entered.promise;
    await apply(app.engine, second);
    await apply(app.engine, first); // ABA: same final identity and definitions, different activation epoch.
    gate.resolve(); await settle(); await settle();
    assert.equal(app.engine.state.event_runtime?.candidates.length ?? 0, 0);
    assert.equal(app.engine.state.occurrences.length, 0);
    assert.equal(calls, phase === 'model' ? 1 : 0);
  });
});
