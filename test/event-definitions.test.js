import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validateEventDefinition, validateEventDefinitions, loadEventPreset, MAX_EVENT_DEFINITIONS } from '../server/event-definitions.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';

const definition = (id = 'custom-event', extra = {}) => ({ id, label: 'Custom event', description: 'A clear visible event after a continuous sequence.', mode: 'persistent', ...extra });
const engine = () => new NotesEngine({ store: new MemoryStore(), decisions: {
  evaluate: async (_body, _config, _moment, category) => ({ moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id: category }, fit: 'fits' }),
  choose: async candidates => [candidates[0].id],
} });
const throwsCode = (operation, code) => assert.rejects(operation, error => error.code === code && error.status >= 400);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('event definitions accept only the bounded canonical schema and fill conservative defaults', () => {
  assert.equal(MAX_EVENT_DEFINITIONS, 12);
  assert.deepEqual(validateEventDefinition(definition()), { ...definition(), min_confidence: 0.85, cooldown_s: 30, auto_confirm: false });
  assert.equal(validateEventDefinition(definition('minimum', { min_confidence: 0, cooldown_s: 1 })).min_confidence, 0);
  assert.equal(validateEventDefinition(definition('maximum', { min_confidence: 1, cooldown_s: 3600, auto_confirm: true, mode: 'instant' })).auto_confirm, true);
  assert.equal(validateEventDefinition(definition('unicode', { label: '🌟'.repeat(100), description: '🌟'.repeat(300) })).description, '🌟'.repeat(300));
  for (const bad of [null, [], { ...definition(), script: 'anything' }, { ...definition(), id: 'Upper' }, { ...definition(), id: 'a'.repeat(61) }, { ...definition(), mode: 'code' }, { ...definition(), min_confidence: NaN }, { ...definition(), min_confidence: 1.01 }, { ...definition(), min_confidence: -0.1 }, { ...definition(), min_confidence: '0.9' }, { ...definition(), cooldown_s: 0 }, { ...definition(), cooldown_s: 3601 }, { ...definition(), cooldown_s: 1.1 }, { ...definition(), auto_confirm: 'true' }, { ...definition(), label: 'x'.repeat(101) }, { ...definition(), description: 'x'.repeat(301) }, { ...definition(), description: '' }]) assert.throws(() => validateEventDefinition(bad), { code: 'invalid_event_definition' });
});

test('event collections reject duplicates and more than twelve definitions without partial output', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => definition(`event-${i}`));
  assert.equal(validateEventDefinitions(twelve).length, 12);
  assert.throws(() => validateEventDefinitions([...twelve, definition('overflow')]), { code: 'event_limit' });
  assert.throws(() => validateEventDefinitions([definition(), definition()]), { code: 'duplicate_event' });
  assert.throws(() => validateEventDefinitions({ events: [] }), { code: 'invalid_event_definition' });
  assert.throws(() => validateEventDefinitions(Array(1)), { code: 'invalid_event_definition' });
  assert.throws(() => validateEventDefinition(Object.create(definition())), { code: 'invalid_event_definition' });
});

test('checked-in generic and KSP presets have exact versioned schemas and conservative defaults', async () => {
  const ksp = await loadEventPreset(new URL('../presets/ksp.json', import.meta.url));
  const generic = await loadEventPreset(new URL('../presets/generic.json', import.meta.url));
  assert.equal(ksp.version, 1);
  assert.deepEqual(ksp.events.map(value => value.id), ['ksp-launch','ksp-explosion','ksp-landing','ksp-eva','ksp-flag','ksp-parachute']);
  assert.deepEqual(generic.events.map(value => value.id), ['first-death','ai-victory','ai-boss']);
  assert.ok([...ksp.events, ...generic.events].every(value => value.mode === 'instant'), 'game presets suggest one-time events from one matching review window');
  assert.ok([...ksp.events, ...generic.events].every(value => value.min_confidence === 0.85 && value.cooldown_s === 30 && value.auto_confirm === false));
});

test('preset loader rejects oversized, malformed, non-regular, symbolic and non-versioned inputs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'event-presets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, text] of [
    ['large.json', ' '.repeat(65537)], ['bad.json', '{'], ['version.json', JSON.stringify({ version: 2, events: [] })],
    ['extra.json', JSON.stringify({ version: 1, events: [], command: 'anything' })], ['array.json', '[]'],
  ]) {
    const file = path.join(directory, name); await writeFile(file, text);
    await throwsCode(() => loadEventPreset(file), 'invalid_event_preset');
  }
  const target = path.join(directory, 'valid.json'); await writeFile(target, JSON.stringify({ version: 1, events: [] }));
  const link = path.join(directory, 'link.json'); await symlink(target, link);
  await throwsCode(() => loadEventPreset(link), 'invalid_event_preset');
  await throwsCode(() => loadEventPreset(directory), 'invalid_event_preset');
  await throwsCode(() => loadEventPreset(path.join(directory, 'missing')), 'invalid_event_preset');
  assert.deepEqual(await loadEventPreset(target), { version: 1, events: [] });
});

test('event CRUD persists normalized definitions atomically and synchronizes AI moments', async () => {
  const app = engine();
  assert.deepEqual(await app.listEventDefinitions(), []);
  const first = await app.upsertEventDefinition(definition());
  assert.deepEqual(await app.listEventDefinitions(), [first]);
  assert.deepEqual(app.config.moments.find(value => value.id === first.id), { id: first.id, label: first.label, kind: 'ai', long_lived: false });
  const updated = await app.upsertEventDefinition(definition(first.id, { label: 'Changed event', auto_confirm: true }));
  assert.equal((await app.listEventDefinitions()).length, 1);
  assert.equal(app.config.moments.find(value => value.id === first.id).label, 'Changed event');
  const restored = new NotesEngine({ store: new MemoryStore(app.store.read()) });
  assert.deepEqual(await restored.listEventDefinitions(), [updated]);
  assert.equal(restored.config.version, app.config.version);
  await restored.deleteEventDefinition(first.id);
  assert.deepEqual(await restored.listEventDefinitions(), []);
  assert.ok(restored.config.moments.some(value => value.id === first.id));
  await throwsCode(() => restored.deleteEventDefinition(first.id), 'event_not_found');
});

test('imports replace definitions as one mutation, preserve builtin first-death, and reject collisions', async () => {
  const app = engine();
  await app.upsertEventDefinition(definition());
  const generic = await loadEventPreset(new URL('../presets/generic.json', import.meta.url));
  const result = await app.importEventDefinitions(generic.events);
  assert.deepEqual(result.map(value => value.id), ['first-death','ai-victory','ai-boss']);
  assert.equal(app.config.moments.find(value => value.id === 'first-death').kind, 'builtin');
  const previous = app.config;
  for (const id of ['margit', 'raid', 'end', 'never']) await throwsCode(() => app.upsertEventDefinition(definition(id)), 'event_moment_conflict');
  await throwsCode(() => app.importEventDefinitions([definition('fresh-event'), definition('raid')]), 'event_moment_conflict');
  assert.deepEqual(app.config, previous);
  const tooMany = Array.from({ length: 13 }, (_, i) => definition(`event-${i}`));
  await throwsCode(() => app.importEventDefinitions(tooMany), 'event_limit');
  assert.deepEqual(app.config, previous);
});

test('full configuration updates enforce event bounds and cannot desynchronize definition labels or kinds', async () => {
  const app = engine();
  await app.updateConfig({ events: [definition()] });
  const moments = app.config.moments.filter(value => value.id !== 'custom-event');
  await app.updateConfig({ moments });
  assert.equal(app.config.moments.find(value => value.id === 'custom-event').kind, 'ai');
  await throwsCode(() => app.updateConfig({ moments: app.config.moments.map(value => value.id === 'custom-event' ? { ...value, kind: 'declared' } : value) }), 'event_moment_conflict');
  await throwsCode(() => app.updateConfig({ events: Array.from({ length: 13 }, (_, i) => definition(`event-${i}`)) }), 'event_limit');
});

test('deleting a definition preserves moments referenced by sealed notes and after conditions', async () => {
  const app = engine();
  await app.upsertEventDefinition(definition());
  const viewer = { opaqueId: 'Uevents', userId: null };
  await app.submit(viewer, { body: 'A sealed event note', category_id: 'encouragement', moment_id: 'custom-event', payment_mode: 'sim_points' });
  await app.submit(viewer, { body: 'After this event', category_id: 'advice', moment_id: 'key', condition: { type: 'after', after_moment_id: 'custom-event' }, payment_mode: 'sim_points' });
  await app.deleteEventDefinition('custom-event');
  assert.ok(app.config.moments.some(value => value.id === 'custom-event'));
  await throwsCode(() => app.updateConfig({ moments: app.config.moments.filter(value => value.id !== 'custom-event') }), 'moment_in_use');
  assert.ok(app.viewerState(viewer).notes.every(value => value.status === 'sealed'));
});

test('API automatic occurrences use explicit provenance and reject changed queued definition policies', async () => {
  const app = engine();
  const first = await app.upsertEventDefinition(definition('api-event', { auto_confirm: true }));
  await app.submit({ opaqueId: 'Uapi' }, { body: 'An API event note', category_id: 'encouragement', moment_id: first.id, payment_mode: 'sim_points' });
  const expected = hash(first);
  const change = app.upsertEventDefinition(definition(first.id, { auto_confirm: false }));
  const stale = app.occur(first.id, {}, 'api-auto', { expectedEventDefinition: expected });
  await change;
  await throwsCode(() => stale, 'event_definition_changed');
  assert.equal(app.state.occurrences.length, 0);
  await app.occur(first.id, {}, 'api-auto', { expectedEventDefinition: hash(app.config.events[0]), expectedSessionId: app.state.session.id, expiresAt: Date.now() + 1000 });
  assert.equal(app.archive()[0].reliability, 'API event · automatic');
  await app.skip();
  await app.submit({ opaqueId: 'Umanualapi' }, { body: 'A confirmed API event note', category_id: 'encouragement', moment_id: first.id, payment_mode: 'sim_points' });
  await app.occur(first.id, {}, 'api-confirmed', { expectedEventDefinition: hash(app.config.events[0]) });
  assert.equal(app.archive().at(-1).reliability, 'API event · confirmed by mod');
  const sessionId = app.state.session.id;
  await throwsCode(() => app.occur(first.id, {}, 'api-auto', { expectedSessionId: 'old-session' }), 'stale_confirmation');
  await throwsCode(() => app.occur(first.id, {}, 'ai-confirmed', { expectedSessionId: sessionId, expiresAt: 0 }), 'stale_confirmation');
});
