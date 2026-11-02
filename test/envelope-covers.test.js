import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';

const safe = { evaluate: async (_body, _config, _moment, category) => ({ moderation: { verdict: 'safe', source: 'decisions', confidence: 1 }, classification: { category_id: category }, fit: 'fits' }) };
const make = () => new NotesEngine({ store: new MemoryStore(), decisions: safe, now: () => 100000 });
const send = (engine, id, extra = {}) => engine.submit({ opaqueId: `U-${id}`, userId: `${id}`, displayName: `sender_${id}` }, {
  body: `private-letter-canary-${id}`, category_id: 'encouragement', moment_id: 'margit', payment_mode: 'free', ...extra,
});

test('rope covers reveal only consented names and public conditions, never sealed contents', async () => {
  const engine = make();
  const anonymous = await send(engine, 1);
  const named = await send(engine, 2, { show_name: true, condition: { type: 'count', count: 3 } });
  await send(engine, 3, { condition: { type: 'window', before_minutes: 15 } });
  await send(engine, 4, { condition: { type: 'after', after_moment_id: 'key' } });
  const view = engine.overlayState();
  assert.equal(view.serverNow, 100000);
  assert.equal(view.sealed_envelopes.length, 4);
  assert.equal(view.sealed_envelopes[0].id, anonymous.id);
  assert.equal(view.sealed_envelopes[0].display_name, null);
  assert.equal(view.sealed_envelopes[1].id, named.id);
  assert.equal(view.sealed_envelopes[1].display_name, 'sender_2');
  assert.match(view.sealed_envelopes[1].condition_label, /occurrence 3/);
  assert.match(view.sealed_envelopes[2].condition_label, /before 15 min/);
  assert.match(view.sealed_envelopes[3].condition_label, /after Find the key/);
  for (const cover of view.sealed_envelopes) assert.deepEqual(Object.keys(cover).sort(), ['id','display_name','moment_label','condition_label','category_id','payment_mode'].sort());
  assert.equal(JSON.stringify(view).includes('private-letter-canary'), false);
  assert.equal(JSON.stringify(view.sealed_envelopes).includes('U-'), false);
});

test('rope covers are bounded and remove opened, held and rejected letters', async () => {
  const engine = make();
  for (let id = 1; id <= 15; id++) await send(engine, id);
  const before = engine.overlayState();
  assert.equal(before.sealedCount, 15);
  assert.equal(before.sealed_envelopes.length, 12);
  const first = before.sealed_envelopes[0].id;
  engine.state.notes[0].status = 'held';
  engine.state.notes[1].status = 'rejected';
  let view = engine.overlayState();
  assert.equal(view.sealed_envelopes.some(cover => cover.id === first), false);
  assert.equal(view.sealed_envelopes.length, 12);
  await engine.occur('margit');
  view = engine.overlayState();
  assert.ok(view.current?.body.startsWith('private-letter-canary'));
  assert.equal(view.sealed_envelopes.some(cover => cover.id === view.current.id), false);
  assert.equal(JSON.stringify(view.sealed_envelopes).includes('private-letter-canary'), false);
});
