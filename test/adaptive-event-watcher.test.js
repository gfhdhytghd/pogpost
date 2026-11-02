import test from 'node:test';
import assert from 'node:assert/strict';
import { EventWatcher } from '../server/event-watcher.js';

// Deterministic clock, synthetic frames and injected judgements only.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const definition = (extra = {}) => ({ id: 'signal', label: 'Visible signal', description: 'A closed object becomes visibly open.',
  mode: 'persistent', min_confidence: 0.85, cooldown_s: 30, auto_confirm: false, ...extra });
const screening = (choice = 'no', confidence = 0.99, extra = {}) => ({ valid: true, scene: 'gameplay', events: { signal: { choice, confidence } }, ...extra });
const review = (choice = 'no', extra = {}) => ({ scene: 'gameplay', continuity: 'same', events: { signal: choice }, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  let clock = 100000, sequence = 0, session = 'one', active = true;
  let screenResult = screening(), reviewResult = review();
  const screens = [], reviews = [];
  const watcher = new EventWatcher({ adaptive: true, definitions: [definition()], now: () => clock,
    getSessionId: () => session, isActive: () => active,
    judgements: {
      async eventScreen(frame, definitions) { screens.push({ frame, definitions, at: clock }); return typeof screenResult === 'function' ? screenResult(frame, definitions) : screenResult; },
      async eventFrames(frames, definitions) { reviews.push({ frames, definitions, at: clock }); return typeof reviewResult === 'function' ? reviewResult(frames, definitions) : reviewResult; },
    }, ...options });
  return { watcher, screens, reviews, now: () => clock, advance(ms) { clock += ms; }, session(value) { session = value; }, active(value) { active = value; },
    screen(value) { screenResult = value; }, review(value) { reviewResult = value; },
    image(id = String(++sequence)) { return { id, at: clock, dataUrl: PNG }; },
    async tick(ms = 200) { clock += ms; return watcher.observe(this.image()); },
    async ticks(count = 5) { let result; for (let i = 0; i < count; i++) result = await this.tick(); return result; },
    async baseline() { await this.ticks(10); assert.equal(watcher.tracks.get('signal').armed, true); },
  };
}

test('adaptive sampling sends at most one single-frame screen per second and quiet baselines stop window reviews', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  await f.ticks(4);
  assert.equal(f.screens.length, 0);
  await f.tick();
  assert.equal(f.screens.length, 1);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0].frames.length, 5);
  assert.equal(f.watcher.tracks.get('signal').no, 1);
  await f.ticks(5);
  assert.equal(f.screens.length, 2);
  assert.equal(f.reviews.length, 2);
  assert.equal(f.watcher.tracks.get('signal').armed, true);
  await f.ticks(20);
  assert.equal(f.screens.length, 6);
  assert.equal(f.reviews.length, 2, 'a high-confidence quiet screen alone never consumes another review after verified arming');
  assert.ok(f.screens.slice(1).every((call, i) => call.at - f.screens[i].at >= 1000));
  assert.equal(f.watcher.frames.length, 5);
  assert.equal(f.watcher.frames.at(-1).at - f.watcher.frames[0].at, 800);
  const state = f.watcher.state();
  assert.equal(state.capture_hz, 5);
  assert.equal(state.screen_interval_ms, 1000);
  assert.equal(state.review_frames, 5);
  assert.equal(state.screen_requests, 6);
  assert.equal(state.review_requests, 2);
});

test('single-frame positives never create candidates; persistent events retain two verified negatives then two positives', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  f.screen(screening('yes', 1)); f.review(review('unsure'));
  await f.ticks(10);
  assert.deepEqual(f.watcher.prompts(), []);
  assert.equal(f.watcher.tracks.get('signal').no, 0);
  assert.equal(f.watcher.tracks.get('signal').yes, 0);
  f.screen(screening('no')); f.review(review('no'));
  await f.ticks(10);
  assert.equal(f.watcher.tracks.get('signal').armed, true);
  f.screen(screening('yes', 0.6)); f.review(review('yes'));
  await f.ticks(5);
  assert.deepEqual(f.watcher.prompts(), []);
  assert.equal(f.watcher.tracks.get('signal').yes, 1);
  await f.ticks(5);
  const [candidate] = f.watcher.prompts();
  assert.equal(candidate.event_id, 'signal');
  assert.equal(candidate.needs_confirmation, true);
  assert.equal(candidate.source, 'ai');
  assert.ok(!JSON.stringify(candidate).includes('data:image'));
});

test('configurable screening gate requests review only at its threshold; malformed/noisy screens never count as evidence', async t => {
  const f = fixture({ reviewConfidence: 0.7 }); t.after(() => f.watcher.close());
  await f.baseline();
  const count = f.reviews.length;
  for (const value of [screening('yes', 0.69), screening('yes', 1.01), screening('yes', -1), screening('yes', NaN),
    screening('yes', '0.99'), screening('unsure', 0.99), screening('invented', 0.99),
    screening('yes', 0.99, { events: {} })]) {
    f.screen(value); await f.ticks(5);
    assert.equal(f.reviews.length, count);
    assert.deepEqual(f.watcher.prompts(), []);
  }
  f.screen(screening('yes', 0.7)); f.review(review('yes'));
  await f.ticks(5);
  assert.equal(f.reviews.length, count + 1);
  assert.equal(f.watcher.tracks.get('signal').yes, 1);
  // A skipped review breaks consecutiveness; a later verified yes starts at one again.
  f.screen(screening('yes', 0.69)); await f.ticks(5);
  f.screen(screening('yes', 0.7)); await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').yes, 1);
  assert.deepEqual(f.watcher.prompts(), []);
});

test('negative screens need each event minimum confidence and two full review windows before baseline arming', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  f.screen(screening('no', 0.84));
  await f.ticks(10);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.watcher.tracks.get('signal').armed, false);
  f.screen(screening('no', 0.85)); f.review(review('no'));
  await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').armed, false);
  await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').armed, true);
});

test('instant events require one verified positive, latch, rearm after two reviewed absences, and obey cooldown and queue bounds', async t => {
  const f = fixture({ definitions: [definition({ mode: 'instant', cooldown_s: 30 })] }); t.after(() => f.watcher.close());
  f.screen(screening('yes', 0.99)); f.review(review('yes'));
  await f.ticks();
  assert.equal(f.watcher.prompts().length, 1);
  assert.equal(f.watcher.prompts()[0].needs_confirmation, true);
  await f.ticks(5);
  assert.equal(f.watcher.prompts().length, 1, 'a repeated verified flash remains latched');
  const first = f.watcher.prompts()[0]; f.watcher.confirm(first.id);
  f.screen(screening('no')); f.review(review('no')); await f.ticks(10);
  assert.equal(f.watcher.tracks.get('signal').latched, false);
  f.screen(screening('yes')); f.review(review('yes')); await f.ticks(5);
  assert.deepEqual(f.watcher.prompts(), [], 'rearming does not bypass cooldown');
  await f.ticks(150);
  assert.deepEqual(f.watcher.prompts(), [], 'the consumed positive cannot resurface after cooldown');
  f.screen(screening('no')); f.review(review('no')); await f.ticks(10);
  f.screen(screening('yes')); f.review(review('yes')); await f.ticks(5);
  assert.equal(f.watcher.prompts().length, 1);
  assert.notEqual(f.watcher.prompts()[0].id, first.id);
});

test('capture continues at 5 Hz during deferred screening and review receives the frozen trigger window', async t => {
  const pending = deferred();
  let f, reads = 0;
  f = fixture({ definitions: [definition({ mode: 'instant' })], readObservation: async () => { reads++; return f.image(); } });
  t.after(() => f.watcher.close());
  await f.ticks(4);
  f.screen(() => pending.promise); f.review(review('yes'));
  f.advance(200); const operation = f.watcher.capture();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.screens.length, 1);
  const triggerAt = f.screens[0].frame.at;
  const expectedWindow = f.watcher.frames.map(frame => ({ ...frame }));
  for (let i = 0; i < 4; i++) { f.advance(200); await f.watcher.capture(); }
  assert.equal(reads, 5);
  assert.equal(f.watcher.frames.at(-1).at, triggerAt + 800);
  assert.equal(f.screens.length, 1, 'there is no concurrent duplicate screen');
  pending.resolve(screening('yes', 0.99)); await operation;
  assert.equal(f.reviews.length, 1);
  assert.deepEqual(f.reviews[0].frames, expectedWindow);
  assert.equal(f.reviews[0].frames.at(-1).at, triggerAt);
  assert.equal(f.watcher.prompts()[0].observed_at, triggerAt);
});

test('screening failures and non-game scenes clear evidence without generating review requests', async () => {
  for (const value of [screening('yes', 1, { valid: false }), screening('yes', 1, { scene: 'menu' }),
    screening('yes', 1, { scene: 'map' }), screening('yes', 1, { scene: 'unknown' }), null,
    () => { throw Error('private provider exception'); }]) {
    const f = fixture();
    try {
      await f.baseline();
      const count = f.reviews.length;
      f.screen(value); await f.ticks(5);
      assert.equal(f.reviews.length, count);
      assert.deepEqual(f.watcher.frames, []);
      assert.equal(f.watcher.tracks.get('signal').armed, false);
      assert.deepEqual(f.watcher.prompts(), []);
    } finally { f.watcher.close(); }
  }
});

test('reset, session/profile changes, wrap and close fence deferred screen results before five-frame review', async () => {
  for (const mutate of [f => f.watcher.reset(), f => f.session('two'), f => f.active(false),
    f => f.watcher.setDefinitions([definition({ label: 'Changed definition' })]), f => f.watcher.close()]) {
    const pending = deferred(), f = fixture();
    try {
      await f.ticks(4); f.screen(() => pending.promise);
      f.advance(200); const operation = f.watcher.observe(f.image());
      mutate(f); pending.resolve(screening('yes', 1)); await operation;
      assert.equal(f.reviews.length, 0);
      assert.deepEqual(f.watcher.prompts(), []);
      assert.deepEqual(f.watcher.frames, []);
    } finally { f.watcher.close(); }
  }
});

test('capture failures and reset/session/profile changes invalidate a deferred five-frame review', async () => {
  for (const mutate of [async f => { await f.watcher.observe(null); }, async f => { f.watcher.reset(); },
    async f => { f.session('two'); }, async f => { f.active(false); },
    async f => { f.watcher.setDefinitions([definition({ label: 'Edited profile' })]); }]) {
    const pending = deferred(), f = fixture({ definitions: [definition({ mode: 'instant' })] });
    try {
      await f.ticks(4); f.screen(screening('yes')); f.review(() => pending.promise);
      f.advance(200); const operation = f.watcher.observe(f.image());
      await Promise.resolve(); await Promise.resolve();
      assert.equal(f.reviews.length, 1);
      await mutate(f); pending.resolve(review('yes')); await operation;
      assert.deepEqual(f.watcher.prompts(), []);
      assert.equal(f.watcher.tracks.get('signal').yes, 0);
    } finally { f.watcher.close(); }
  }
});

test('gaps, duplicate timestamps and sparse windows cannot be used for five-frame review', async t => {
  const f = fixture(); t.after(() => f.watcher.close());
  await f.ticks(4);
  f.advance(800); await f.watcher.observe(f.image());
  assert.equal(f.watcher.frames.length, 1);
  assert.equal(f.screens.length, 0);
  await f.ticks(3);
  const duplicateTime = f.image('different-id-same-timestamp');
  await f.watcher.observe(duplicateTime);
  assert.deepEqual(f.watcher.frames, []);
  assert.equal(f.screens.length, 0);
  await f.ticks(5);
  assert.equal(f.reviews.length, 1);
  assert.ok(f.reviews[0].frames.at(-1).at - f.reviews[0].frames[0].at <= 1000);
});

test('capture continues during deferred five-frame review and a capture exception fences its candidate', async t => {
  const pending = deferred();
  let f, failCapture = false, reads = 0;
  f = fixture({ definitions: [definition({ mode: 'instant' })], readObservation: async () => {
    reads++;
    if (failCapture) throw Error('private OBS capture detail');
    return f.image();
  } });
  t.after(() => f.watcher.close());
  await f.ticks(4); f.screen(screening('yes')); f.review(() => pending.promise);
  f.advance(200); const operation = f.watcher.capture();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(f.reviews.length, 1);
  const reviewed = structuredClone(f.reviews[0].frames);
  f.advance(200); await f.watcher.capture();
  assert.equal(reads, 2);
  assert.equal(f.watcher.frames.at(-1).at, reviewed.at(-1).at + 200);
  failCapture = true; f.advance(200); await f.watcher.capture();
  assert.equal(reads, 3);
  assert.deepEqual(f.watcher.frames, []);
  pending.resolve(review('yes')); await operation;
  assert.deepEqual(f.watcher.prompts(), []);
  assert.deepEqual(f.reviews[0].frames, reviewed);
});

test('five-frame review rejection, menu and discontinuity discard single-frame positive evidence', async () => {
  for (const value of [review('yes', { scene: 'menu' }), review('yes', { continuity: 'changed' }),
    review('yes', { continuity: 'unknown' }), null, () => { throw Error('private review error'); }]) {
    const f = fixture({ definitions: [definition({ mode: 'instant' })] });
    try {
      f.screen(screening('yes', 1)); f.review(value); await f.ticks();
      assert.equal(f.reviews.length, 1);
      assert.deepEqual(f.watcher.frames, []);
      assert.deepEqual(f.watcher.prompts(), []);
      assert.equal(f.watcher.tracks.get('signal').latched, false);
    } finally { f.watcher.close(); }
  }
});

test('stale screen completions cannot initiate review and stale reviewed positives cannot queue candidates', async () => {
  for (const phase of ['screen', 'review']) {
    const pending = deferred(), f = fixture({ definitions: [definition({ mode: 'instant' })] });
    try {
      await f.ticks(4);
      f.screen(phase === 'screen' ? () => pending.promise : screening('yes', 1));
      f.review(phase === 'review' ? () => pending.promise : review('yes'));
      f.advance(200); const operation = f.watcher.observe(f.image());
      for (let i = 0; i < 4; i++) await Promise.resolve();
      f.advance(5001);
      pending.resolve(phase === 'screen' ? screening('yes', 1) : review('yes')); await operation;
      assert.equal(f.reviews.length, phase === 'review' ? 1 : 0);
      assert.deepEqual(f.watcher.frames, []);
      assert.deepEqual(f.watcher.prompts(), []);
    } finally { f.watcher.close(); }
  }
});

test('demo window mode sees a brief signal before the latest frame without screening', async t => {
  const f = fixture({reviewMode:'window', definitions:[definition({mode:'instant'})]});
  t.after(() => f.watcher.close());
  f.screen(() => { throw Error('Single-image gate must not run'); });
  // Frame identity is semantic fixture data: only the second frame has the flash.
  f.review(frames => review(frames.some(frame => frame.dataUrl === 'data:image/png;base64,RkxBU0g=') ? 'yes' : 'no'));
  for (let i=0;i<5;i++) {
    f.advance(200);
    const image=f.image();
    if(i===1)image.dataUrl='data:image/png;base64,RkxBU0g=';
    await f.watcher.observe(image);
  }
  assert.equal(f.screens.length,0);
  assert.equal(f.reviews.length,1);
  assert.equal(f.watcher.prompts().length,1);
  assert.equal(f.watcher.prompts()[0].needs_confirmation,true);
  assert.equal(f.watcher.state().strategy,'direct_window');
  await f.ticks(20);
  assert.equal(f.reviews.length,5);
  assert.ok(f.reviews.slice(1).every((call,i)=>call.at-f.reviews[i].at>=1000));
});

test('demo window unavailable answer retains captures, retries next second and cannot make a positive streak', async t => {
  const f=fixture({reviewMode:'window'}); t.after(()=>f.watcher.close());
  await f.baseline();
  f.review(review('yes')); await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').yes,1);
  f.review({scene:'unknown',continuity:'unknown',events:{signal:'unsure'}});
  await f.ticks(5);
  assert.equal(f.watcher.frames.length,5);
  assert.equal(f.watcher.tracks.get('signal').armed,true);
  assert.equal(f.watcher.tracks.get('signal').yes,0);
  f.review(review('yes')); await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').yes,1);
  assert.equal(f.watcher.prompts().length,0);
});

test('demo window resets retained baseline after three consecutive unavailable reviews', async t => {
  const f=fixture({reviewMode:'window'});t.after(()=>f.watcher.close());
  await f.baseline();
  f.review(()=>{throw Error('Synthetic provider unavailable');});
  await f.ticks(10);
  assert.equal(f.watcher.tracks.get('signal').armed,true);
  assert.equal(f.watcher.frames.length,5);
  await f.ticks(5);
  assert.equal(f.watcher.tracks.get('signal').armed,false);
  assert.equal(f.watcher.frames.length,0);
  assert.equal(f.watcher.prompts().length,0);
});

test('demo window continues capture during inference and fences changed profiles', async t => {
  const pending=deferred(),f=fixture({reviewMode:'window',definitions:[definition({mode:'instant'})]});
  t.after(()=>f.watcher.close());
  f.review(()=>pending.promise);await f.ticks(4);
  f.advance(200);const operation=f.watcher.observe(f.image());
  const frozen=structuredClone(f.reviews[0].frames);
  await f.ticks(4);
  assert.deepEqual(f.reviews[0].frames,frozen);
  assert.equal(f.watcher.frames.at(-1).at,frozen.at(-1).at+800);
  f.watcher.setDefinitions([definition({mode:'instant',label:'Another profile'})]);
  pending.resolve(review('yes'));await operation;
  assert.equal(f.watcher.prompts().length,0);
});
