import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventWatcher } from '../server/event-watcher.js';
import { KSPWatcher } from '../server/ksp-perception.js';
import { validateEventDefinitions } from '../server/event-definitions.js';
import ksp from '../presets/ksp.json' with { type: 'json' };

const image = 'data:image/png;base64,iVBORw0KGgo=';
const definitions = () => [
  { id: 'custom-chest', label: 'Chest opens', description: 'A closed chest becomes visibly open.', mode: 'persistent', min_confidence: 0.85, cooldown_s: 30, auto_confirm: false },
  { id: 'custom-flash', label: 'Bright flash', description: 'A brief bright flash appears in the game world.', mode: 'instant', min_confidence: 0.9, cooldown_s: 2, auto_confirm: true },
];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const answer = (events = {}, extra = {}) => ({ scene: 'gameplay', continuity: 'same', events, ...extra });
function fixture(options = {}) {
  let clock = 100000, sequence = 0, session = 'one', active = true, result = answer();
  const calls = [];
  const watcher = new EventWatcher({ definitions: definitions(), now: () => clock,
    getSessionId: () => session, isActive: () => active,
    judgements: { async eventFrames(frames, events) { calls.push({ frames, definitions: events }); return typeof result === 'function' ? result(frames, events) : result; } }, ...options });
  return { watcher, calls, time: () => clock, advance(ms) { clock += ms; }, session(value) { session = value; }, active(value) { active = value; },
    result(value) { result = value; }, capture(id = String(++sequence)) { return { id, at: clock, dataUrl: image }; },
    async feed(events = {}, extra = {}) { result = answer(events, extra); clock += 2000; return watcher.observe(this.capture()); },
    async baseline() { for (let i = 0; i < 3; i++) await this.feed(Object.fromEntries(watcher.definitions.map(definition => [definition.id, 'no']))); } };
}

test('generic definitions are bounded, isolated, and reconfiguration invalidates pending evidence', async t => {
  const original = definitions();
  const f = fixture({ definitions: original }); t.after(() => f.watcher.close());
  original[0].label = 'Mutated outside watcher';
  assert.equal(f.watcher.definitions[0].label, 'Chest opens');
  await f.feed(); await f.feed({ 'custom-flash': 'yes' });
  assert.equal(f.watcher.prompts().length, 1);
  const epoch = f.watcher.epoch;
  assert.equal(f.watcher.setDefinitions(definitions()), false);
  assert.equal(f.watcher.epoch, epoch);
  assert.throws(() => f.watcher.setDefinitions(Array.from({ length: 13 }, (_, i) => ({ ...definitions()[0], id: `event-${i}` }))), { code: 'event_limit' });
  assert.equal(f.watcher.prompts().length, 1);
  f.watcher.setDefinitions([definitions()[0]]);
  assert.deepEqual(f.watcher.prompts(), []);
  assert.equal(f.watcher.frames.length, 0);
  assert.equal(f.watcher.tracks.has('custom-flash'), false);
});

test('persistent events need two negative then two positive windows; instant events need one positive window', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  for (let i = 0; i < 4; i++) await f.feed({ 'custom-chest': 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.feed({ 'custom-chest': 'no' }); await f.feed({ 'custom-chest': 'no' });
  await f.feed({ 'custom-chest': 'yes', 'custom-flash': 'yes' });
  assert.deepEqual(f.watcher.prompts().map(prompt => prompt.event_id), ['custom-flash']);
  await f.feed({ 'custom-chest': 'yes', 'custom-flash': 'yes' });
  assert.deepEqual(f.watcher.prompts().map(prompt => prompt.event_id), ['custom-flash', 'custom-chest']);
  assert.ok(f.watcher.prompts().every(prompt => prompt.needs_confirmation));
  assert.match(f.watcher.prompts()[0].evidence, /Human confirmation is required/);
  assert.doesNotMatch(JSON.stringify(f.watcher.prompts()), /data:image|base64/);
});

test('unknown answers break consecutive baselines and positive streaks', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  await f.feed(); await f.feed({ 'custom-chest': 'no' });
  await f.feed({ 'custom-chest': 'unsure' }); await f.feed({ 'custom-chest': 'no' });
  await f.feed({ 'custom-chest': 'yes' }); await f.feed({ 'custom-chest': 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.baseline(); await f.feed({ 'custom-chest': 'yes' }); await f.feed({ 'custom-chest': 'unsure' });
  await f.feed({ 'custom-chest': 'yes' }); assert.deepEqual(f.watcher.prompts(), []);
  await f.feed({ 'custom-chest': 'yes' }); assert.equal(f.watcher.prompts()[0].event_id, 'custom-chest');
});

test('standalone per-definition cooldown survives removal, re-addition and reset', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  await f.baseline(); await f.feed({ 'custom-chest': 'yes' }); await f.feed({ 'custom-chest': 'yes' });
  f.watcher.confirm(f.watcher.prompts()[0].id);
  f.watcher.setDefinitions([]); f.watcher.setDefinitions(definitions());
  await f.baseline(); await f.feed({ 'custom-chest': 'yes' }); await f.feed({ 'custom-chest': 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  for (let i = 0; i < 16; i++) await f.feed({ 'custom-chest': 'yes' });
  assert.deepEqual(f.watcher.prompts(), []);
  await f.feed({ 'custom-chest': 'no' }); await f.feed({ 'custom-chest': 'no' });
  await f.feed({ 'custom-chest': 'yes' }); await f.feed({ 'custom-chest': 'yes' });
  assert.equal(f.watcher.prompts()[0].event_id, 'custom-chest');
});

test('central candidate callback owns queues and cooldowns; rejected evidence remains consumed', async t => {
  const submitted = [];
  const f = fixture({ definitions: [{ ...definitions()[1], cooldown_s: 3600 }], onCandidate: async (id, metadata) => { submitted.push({ id, metadata }); return null; } });
  t.after(() => f.watcher.close());
  await f.feed(); await f.feed({ 'custom-flash': 'yes' });
  for (let i = 0; i < 3; i++) await f.feed({ 'custom-flash': 'yes' });
  assert.equal(submitted.length, 1);
  await f.feed({ 'custom-flash': 'no' }); await f.feed({ 'custom-flash': 'no' }); await f.feed({ 'custom-flash': 'yes' });
  assert.equal(submitted.length, 2, 'no watcher-local cooldown competes with the shared service');
  assert.deepEqual(f.watcher.prompts(), []);
  assert.equal(f.watcher.lastPrompts.size, 0);
  assert.equal(submitted[0].id, 'custom-flash');
  assert.equal(submitted[0].metadata.source, 'ai');
  const normalized = validateEventDefinitions([{ ...definitions()[1], cooldown_s: 3600 }])[0];
  assert.equal(submitted[0].metadata.definitionFingerprint, createHash('sha256').update(JSON.stringify(normalized)).digest('hex'));
});

test('standalone cooldown history stays bounded without evicting live cooldowns', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  for (let i = 0; i < 513; i++) {
    const definition = { ...definitions()[1], id: `rotated-${i}`, cooldown_s: 3600 };
    f.watcher.setDefinitions([definition]);
    await f.feed({ [definition.id]: 'no' }); await f.feed({ [definition.id]: 'yes' });
    assert.equal(f.watcher.prompts().length, i < 512 ? 1 : 0);
  }
  assert.equal(f.watcher.lastPrompts.size, 512);
  assert.ok(f.watcher.lastPrompts.has('rotated-0'));
  f.advance(3600000);
  f.watcher.setDefinitions([{ ...definitions()[1], id: 'new-after-expiry', cooldown_s: 3600 }]);
  await f.feed({ 'new-after-expiry': 'no' }); await f.feed({ 'new-after-expiry': 'yes' });
  assert.equal(f.watcher.lastPrompts.size, 1);
  assert.equal(f.watcher.prompts()[0].event_id, 'new-after-expiry');
});

test('classification captures definition fingerprints and fences edits while inference is pending', async t => {
  const submitted = [], pending = deferred();
  const f = fixture({ onCandidate: async (id, metadata) => { submitted.push(metadata); return { id }; } });
  t.after(() => f.watcher.close());
  await f.baseline();
  f.result((frames, defs) => { defs[0].description = 'Changed provider argument'; return pending.promise; });
  f.advance(2000); const operation = f.watcher.observe(f.capture());
  f.watcher.setDefinitions([{ ...definitions()[0], label: 'Changed definition' }]);
  pending.resolve(answer({ 'custom-flash': 'yes' })); await operation;
  assert.deepEqual(submitted, []);
  assert.deepEqual(f.watcher.frames, []);
  assert.equal(f.watcher.definitions[0].description, definitions()[0].description);
});

test('reset, session change, wrap-up, edits and close fence completion-stamped captures before inference', async () => {
  for (const change of [f => f.watcher.reset(), f => f.session('two'), f => f.active(false),
    f => f.watcher.setDefinitions([definitions()[1]]), f => f.watcher.close()]) {
    const pending = deferred();
    const f = fixture({ readObservation: () => pending.promise });
    await f.baseline();
    const count = f.calls.length;
    const operation = f.watcher.capture();
    change(f); f.advance(2000);
    pending.resolve(f.capture('completion-stamped-old-capture'));
    await operation;
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.watcher.frames, []);
    assert.deepEqual(f.watcher.prompts(), []);
    f.watcher.close();
  }
});

test('an old capture completion or error cannot clear evidence collected after a reset', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), f = fixture({ readObservation: () => pending.promise });
    const operation = f.watcher.capture();
    f.watcher.reset(); await f.feed();
    const currentFrames = structuredClone(f.watcher.frames);
    if (reject) pending.reject(Error('private capture error'));
    else pending.resolve(f.capture('old'));
    await operation;
    assert.deepEqual(f.watcher.frames, currentFrames);
    assert.equal(f.calls.length, 0);
    f.watcher.close();
  }
});

test('invalid scene, discontinuity and stale inference clear queues without exposing provider data', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  await f.feed(); await f.feed({ 'custom-flash': 'yes' });
  await f.feed({}, { scene: 'flight' });
  assert.deepEqual(f.watcher.prompts(), []);
  assert.deepEqual(f.watcher.frames, []);
  await f.baseline();
  f.result(() => { f.advance(6000); return answer({ 'custom-flash': 'yes' }); });
  f.advance(2000); await f.watcher.observe(f.capture());
  assert.deepEqual(f.watcher.prompts(), []);
});

test('explicit legacy KSP modes retain persistent, instant, multi-event and reset/cooldown positions', async () => {
  const actions = [ {}, {}, {}, { launch: 'yes', eva: 'yes', parachute: 'yes' }, { launch: 'yes', eva: 'yes', parachute: 'yes' },
    { explosion: 'yes' }, 'confirm', 'reset', {}, {}, {}, { explosion: 'yes' }, 'wait',
    { explosion: 'yes' }, { explosion: 'yes' }, {}, {}, { explosion: 'yes' } ];
  async function trace(legacy) {
    let clock = 100000, current = {};
    const watcher = legacy ? new KSPWatcher({ now: () => clock, judgements: { async kspFrames() {
      return { scene: 'flight', continuity: 'same', events: Object.fromEntries(ksp.events.map(definition => [definition.id.slice(4), current[definition.id.slice(4)] || 'no'])) };
    } } }) : new EventWatcher({ definitions: ksp.events.map(definition => ({ ...definition, mode: definition.id === 'ksp-explosion' ? 'instant' : 'persistent' })), now: () => clock, judgements: { async eventFrames() {
      return answer(Object.fromEntries(ksp.events.map(definition => [definition.id, current[definition.id.slice(4)] || 'no'])));
    } } });
    const recorded = [];
    for (const [position, action] of actions.entries()) {
      if (action === 'confirm') { for (const prompt of watcher.prompts()) watcher.confirm(prompt.id); continue; }
      if (action === 'reset') { watcher.reset(); continue; }
      if (action === 'wait') { clock += 30000; continue; }
      current = action; clock += 2000;
      const proposals = await watcher.observe({ id: String(position), at: clock, dataUrl: image });
      if (proposals?.length) recorded.push({ position, kinds: proposals.map(proposal => proposal.moment_id.replace(/^ksp-/, '')) });
    }
    watcher.close(); return recorded;
  }
  const expected = [{ position: 4, kinds: ['launch', 'eva', 'parachute'] }, { position: 5, kinds: ['explosion'] }, { position: 17, kinds: ['explosion'] }];
  assert.deepEqual(await trace(false), expected);
  assert.deepEqual(await trace(true), expected);
});
