import test from 'node:test';
import assert from 'node:assert/strict';
import { KSPWatcher, KSP_EVENTS } from '../server/ksp-perception.js';

const image = 'data:image/png;base64,iVBORw0KGgo=';
const result = (events = {}, extras = {}) => ({ scene: 'flight', continuity: 'same',
  events: Object.fromEntries(Object.keys(KSP_EVENTS).map(key => [key, events[key] || 'no'])), ...extras });
function fixture(options = {}) {
  let clock = 100000, serial = 0, session = 'one', active = true, answer = result();
  const calls = [];
  const watcher = new KSPWatcher({ now: () => clock, getSessionId: () => session, isActive: () => active,
    judgements: { async kspFrames(frames) { calls.push(frames); return typeof answer === 'function' ? answer() : answer; } }, ...options });
  return { watcher, calls, time: () => clock, advance(ms) { clock += ms; }, session(value) { session = value; }, active(value) { active = value; },
    answer(value) { answer = value; }, async feed(events = {}, extras = {}) {
      answer = result(events, extras); clock += 2000;
      return watcher.observe({ id: String(++serial), at: clock, dataUrl: image });
    }, async baseline() { await this.feed(); await this.feed(); await this.feed(); } };
}

test('KSP observations are bounded, ordered, and cached captures are not new evidence', async () => {
  const f = fixture();
  const capture = { id: 'same', at: f.time(), dataUrl: image };
  await f.watcher.observe(capture); await f.watcher.observe(capture);
  assert.equal(f.calls.length, 0);
  await f.feed();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 6; i++) await f.feed();
  assert.equal(f.calls.at(-1).length, 4);
  assert.ok(f.calls.at(-1).at(-1).at - f.calls.at(-1)[0].at <= 8000);
  f.watcher.close();
});

test('KSP persistent observations need an absent baseline and two agreeing observations', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await f.feed({ flag: 'yes', landing: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []); // Opening the stream on a flag or landed ship is not a transition.
  await f.feed(); await f.feed();
  await f.feed({ flag: 'yes', landing: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.feed({ flag: 'yes', landing: 'yes' });
  assert.deepEqual(f.watcher.prompts().map(p => p.kind), ['landing', 'flag']);
  assert.ok(f.watcher.prompts().every(p => p.needs_confirmation && p.source === 'ai'));
  assert.ok(!JSON.stringify(f.watcher.prompts()).includes('base64'));
  f.watcher.close();
});

test('KSP launch, EVA and parachute can independently propose in one window', async () => {
  const f = fixture(); await f.baseline();
  await f.feed({ launch: 'yes', eva: 'yes', parachute: 'yes' });
  await f.feed({ launch: 'yes', eva: 'yes', parachute: 'yes' });
  assert.deepEqual(f.watcher.prompts().map(p => p.moment_id), ['ksp-launch', 'ksp-eva', 'ksp-parachute']);
  f.watcher.close();
});

test('one destructive-explosion window proposes once, never repeatedly from persistent fire', async () => {
  const f = fixture();
  await f.feed(); await f.feed({ explosion: 'yes' });
  const prompt = f.watcher.prompts()[0];
  assert.equal(prompt.kind, 'explosion');
  assert.ok(f.watcher.confirm(prompt.id));
  for (let i = 0; i < 20; i++) await f.feed({ explosion: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  // Distinct negative observations re-arm; cooldown already elapsed.
  await f.feed(); await f.feed(); await f.feed({ explosion: 'yes' });
  assert.equal(f.watcher.prompts().length, 1);
  f.watcher.close();
});

test('confirmation, dismissal and reset cannot bypass cooldown', async () => {
  const f = fixture(); await f.baseline(); await f.feed({ explosion: 'yes' });
  const first = f.watcher.prompts()[0];
  assert.ok(f.watcher.confirm(first.id));
  assert.equal(f.watcher.confirm(first.id), null);
  f.watcher.reset(); await f.baseline(); await f.feed({ explosion: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  f.watcher.close();
});

test('a cooldown-suppressed explosion cannot surface late from the same persistent positive window', async () => {
  const f = fixture(); await f.baseline(); await f.feed({ explosion: 'yes' });
  f.watcher.confirm(f.watcher.prompts()[0].id);
  await f.feed(); await f.feed(); await f.feed({ explosion: 'yes' });
  for (let i = 0; i < 20; i++) await f.feed({ explosion: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.feed(); await f.feed(); await f.feed({ explosion: 'yes' });
  assert.equal(f.watcher.prompts().length, 1);
  f.watcher.close();
});

test('uncertain event answers break a positive streak without inventing positives', async () => {
  const f = fixture(); await f.baseline();
  await f.feed({ eva: 'yes' }); await f.feed({ eva: 'unsure' }); await f.feed({ eva: 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.feed({ eva: 'yes' }); assert.equal(f.watcher.prompts()[0].kind, 'eva');
  f.watcher.close();
});

test('map, editor, menus and continuity changes clear old evidence and pending prompts', async () => {
  for (const extras of [{ scene: 'map' }, { scene: 'editor' }, { scene: 'menu' }, { scene: 'unknown' }, { continuity: 'changed' }, { continuity: 'unknown' }]) {
    const f = fixture(); await f.baseline(); await f.feed({ explosion: 'yes' });
    assert.equal(f.watcher.prompts().length, 1);
    await f.feed({}, extras); assert.deepEqual(f.watcher.prompts(), []); assert.equal(f.watcher.frames.length, 0);
    for (let i = 0; i < 3; i++) await f.feed({ flag: 'yes' });
    assert.deepEqual(f.watcher.prompts(), []);
    f.watcher.close();
  }
});

test('invalid, missing, future, stale or reordered screenshots reset continuity', async () => {
  const f = fixture(); await f.baseline(); await f.feed({ eva: 'yes' });
  for (const bad of [null, { id: 'x', at: f.time(), dataUrl: 'https://example.test/x' },
    { id: 'x', at: f.time() + 1, dataUrl: image }, { id: 'x', at: f.time() - 6000, dataUrl: image }]) {
    await f.watcher.observe(bad); assert.equal(f.watcher.frames.length, 0);
  }
  await f.feed();
  await f.watcher.observe({ id: 'old', at: f.time() - 1, dataUrl: image });
  assert.equal(f.watcher.frames.length, 0); assert.equal(f.watcher.tracks.get('eva').armed, false);
  f.advance(7000); await f.feed(); assert.equal(f.watcher.frames.length, 1);
  f.watcher.close();
});

test('manual reset cannot reuse a pre-reset cached capture as fresh evidence', async () => {
  const f = fixture(); const capture = { id: 'cached', at: f.time(), dataUrl: image };
  await f.watcher.observe(capture); f.watcher.reset();
  await f.watcher.observe(capture); assert.equal(f.watcher.frames.length, 0);
  f.advance(2000); await f.watcher.observe({ ...capture, id: 'different-id' });
  assert.equal(f.watcher.frames.length, 0);
  const pendingCapture = { id: 'not-seen-before-reset', at: f.time(), dataUrl: image };
  f.advance(1); f.watcher.reset();
  await f.watcher.observe(pendingCapture); assert.equal(f.watcher.frames.length, 0);
  f.watcher.close();
});

test('failed or slow classification discards evidence rather than revealing or queuing', async () => {
  const f = fixture(); await f.baseline();
  f.answer(() => { throw Error('private provider response'); });
  f.advance(2000);
  await f.watcher.observe({ id: 'failure', at: f.time(), dataUrl: image });
  assert.deepEqual(f.watcher.prompts(), []); assert.equal(f.watcher.frames.length, 0);
  await f.baseline();
  f.answer(() => { f.advance(6000); return result({ explosion: 'yes' }); });
  await f.watcher.observe({ id: 'slow', at: f.time(), dataUrl: image });
  assert.deepEqual(f.watcher.prompts(), []);
  f.watcher.close();
});

test('in-flight reset, session change, wrap-up and close fence late model results', async () => {
  for (const mutate of [f => f.watcher.reset(), f => f.session('two'), f => f.active(false), f => f.watcher.close()]) {
    const f = fixture(); await f.baseline();
    let resolve; f.answer(() => new Promise(done => { resolve = done; }));
    f.advance(2000); const pending = f.watcher.observe({ id: 'pending', at: f.time(), dataUrl: image });
    mutate(f); resolve(result({ explosion: 'yes' })); await pending;
    assert.deepEqual(f.watcher.prompts(), []); f.watcher.close();
  }
});

test('prompts expire and cannot confirm across a stream session or wrap-up', async () => {
  const f = fixture(); await f.baseline(); await f.feed({ explosion: 'yes' });
  const prompt = f.watcher.prompts()[0]; f.advance(30000);
  assert.equal(f.watcher.confirm(prompt.id), null);
  f.watcher.reset(); await f.baseline(); await f.feed({ explosion: 'yes' });
  const next = f.watcher.prompts()[0]; assert.ok(next);
  f.session('two'); assert.equal(f.watcher.confirm(next.id), null);
  f.active(false); await f.feed({ explosion: 'yes' }); assert.equal(f.watcher.frames.length, 0);
  f.watcher.close();
});

test('overlapping observations are dropped instead of scheduling unbounded inference', async () => {
  const f = fixture(); await f.baseline(); let resolve;
  f.answer(() => new Promise(done => { resolve = done; }));
  f.advance(2000); const pending = f.watcher.observe({ id: 'busy', at: f.time(), dataUrl: image });
  const count = f.calls.length;
  assert.equal(await f.watcher.observe({ id: 'dropped', at: f.time(), dataUrl: image }), null);
  assert.equal(f.calls.length, count);
  resolve(result()); await pending; f.watcher.close();
});
