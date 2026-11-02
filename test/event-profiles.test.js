import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore, JsonStore } from '../server/store.js';
import { createHTTP } from '../server/http.js';
import { createApplication } from '../server/index.js';
import { listEventPresets } from '../server/event-presets.js';
import { signExtensionJWT } from '../server/extension/auth.js';
import { validateEventProfileInput, validateStoredEventProfiles, eventProfileHash, MAX_EVENT_PROFILES, eventProfileContext } from '../server/event-profiles.js';

const definition = (id = 'profile-event', extra = {}) => ({ id, label: 'A clear event', description: 'A clearly visible event happens during gameplay.', mode: 'persistent', ...extra });
const profileInput = (extra = {}) => ({ label: 'My game profile', description: 'A private saved collection.', events: [definition()], ...extra });
const decisions = () => ({
  evaluate: async (_body, _config, _moment, category_id) => ({ moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id }, fit: 'fits' }),
  choose: async candidates => candidates.map(value => value.id),
});
const setup = options => new NotesEngine({ store: new MemoryStore(), decisions: decisions(), ...options });
const throwsCode = (operation, code) => assert.rejects(operation, error => error.code === code && error.status >= 400);
const apply = (engine, profile) => engine.activateEventProfile({ kind: 'profile', id: profile.id, expected_revision: profile.revision });
async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sealed-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const root = await temp(t);
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'archive.html'), 'archive fixture');
  const engine = setup();
  const secret = Buffer.alloc(32, 42);
  let syncs = 0;
  const env = { TWITCH_EXT_SECRET: secret.toString('base64'), TWITCH_EXT_CLIENT_ID: 'newextension', TWITCH_BROADCASTER_ID: '123' };
  const server = await createHTTP({ root, engine, env, watcher: { syncDefinitions: () => { syncs++; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + '/api/operator/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const post = (body, headers = {}) => fetch(base + '/api/operator/action', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const jwt = signExtensionJWT({ channel_id: '123', exp: Math.floor(Date.now() / 1000) + 300, role: 'viewer', opaque_user_id: 'Uprofileviewer' }, secret);
  return { root, engine, base, cookie, post, jwt, origin: 'https://newextension.ext-twitch.tv', syncs: () => syncs };
}

test('save creates a server-owned snapshot without applying events, incrementing config, or naming the live collection', async () => {
  const engine = setup({ now: () => 1000 });
  const before = engine.config;
  const profile = await engine.saveEventProfile(profileInput());
  assert.match(profile.id, /^profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(profile).sort(), ['created_at','description','events','id','label','revision','updated_at']);
  assert.equal(profile.revision, 1); assert.equal(profile.created_at, 1000); assert.equal(profile.updated_at, 1000);
  assert.equal(profile.events[0].min_confidence, 0.85);
  assert.equal(profile.events[0].cooldown_s, 30);
  assert.equal(profile.events[0].auto_confirm, false);
  assert.deepEqual(engine.config, before);
  assert.deepEqual(await engine.listEventProfiles(), { profiles: [profile], active_ref: null, dirty: false });
  assert.deepEqual(engine.operatorState().event_profiles, { profiles: [profile], active_ref: null, dirty: false });
});

test('explicit apply snapshots the chosen identity; saving a newer revision never silently applies it', async () => {
  const engine = setup();
  const first = await engine.saveEventProfile(profileInput());
  const applied = await apply(engine, first);
  assert.deepEqual(applied.events, first.events); assert.equal(applied.dirty, false);
  assert.deepEqual(applied.active_ref, { kind: 'profile', id: first.id, revision: 1, label: first.label, events_hash: eventProfileHash(first.events) });
  const second = await engine.saveEventProfile({ id: first.id, expected_revision: 1, label: 'Renamed saved profile', events: [definition('new-profile-event')] });
  assert.equal(second.revision, 2);
  assert.deepEqual(engine.config.events, first.events);
  assert.deepEqual((await engine.listEventProfiles()).active_ref, applied.active_ref);
  assert.equal((await engine.listEventProfiles()).dirty, false);
  await throwsCode(() => apply(engine, first), 'profile_revision_conflict');
  assert.equal((await apply(engine, second)).active_ref.revision, 2);
  assert.equal(engine.config.events[0].id, 'new-profile-event');
});

test('revision checks serialize concurrent updates so exactly one writer succeeds', async () => {
  const engine = setup(); const first = await engine.saveEventProfile(profileInput());
  const update = label => engine.saveEventProfile({ id: first.id, expected_revision: first.revision, label, events: first.events });
  const results = await Promise.allSettled([update('Writer A'), update('Writer B')]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const failed = results.find(value => value.status === 'rejected');
  assert.equal(failed.reason.code, 'profile_revision_conflict'); assert.equal(failed.reason.status, 409);
  assert.equal((await engine.listEventProfiles()).profiles[0].revision, 2);
  await throwsCode(() => engine.saveEventProfile({ id: first.id, label: 'No revision', events: first.events }), 'profile_revision_required');
  await throwsCode(() => engine.activateEventProfile({ kind: 'profile', id: first.id }), 'profile_revision_required');
});

test('profile limits, required fields, unsafe text, forged metadata, revisions and duplicate event IDs fail without writes', async () => {
  assert.equal(MAX_EVENT_PROFILES, 20);
  const engine = setup(); const before = engine.store.read();
  const unknownId = 'profile-00000000-0000-4000-8000-000000000000';
  for (const bad of [null, [], { ...profileInput(), revision: 1 }, { ...profileInput(), created_at: 0 }, { ...profileInput(), active_ref: {} }, { ...profileInput(), label: '' }, { ...profileInput(), label: 'x'.repeat(81) }, { ...profileInput(), description: 'x'.repeat(301) }, { ...profileInput(), description: null }, { ...profileInput(), label: 'private@example.com' }, { ...profileInput(), description: 'password=private' }, { ...profileInput(), expected_revision: 1 }, { ...profileInput(), id: 'chosen-id', expected_revision: 1 }]) {
    await throwsCode(() => engine.saveEventProfile(bad), 'invalid_profile');
    assert.deepEqual(engine.store.read(), before);
  }
  for (const revision of [0,-1,1.5,'1',NaN]) await throwsCode(() => engine.saveEventProfile({ ...profileInput(), id: unknownId, expected_revision: revision }), 'profile_revision_required');
  await throwsCode(() => engine.saveEventProfile({ ...profileInput(), id: unknownId, expected_revision: 1 }), 'profile_not_found');
  await throwsCode(() => engine.saveEventProfile(profileInput({ events: [definition(), definition()] })), 'duplicate_event');
  await throwsCode(() => engine.saveEventProfile(profileInput({ events: Array.from({ length: 13 }, (_, i) => definition(`event-${i}`)) })), 'event_limit');
  const unicode = await engine.saveEventProfile(profileInput({ label: '🌟'.repeat(80), description: '🌟'.repeat(300) }));
  assert.equal([...unicode.label].length, 80); assert.equal([...unicode.description].length, 300);
});

test('twenty saved snapshots are allowed, updates at capacity work, and names are unique without case sensitivity', async () => {
  const engine = setup();
  const profiles = [];
  for (let index = 0; index < 20; index++) profiles.push(await engine.saveEventProfile(profileInput({ label: `Game ${index}` })));
  await throwsCode(() => engine.saveEventProfile(profileInput({ label: 'Overflow' })), 'profile_limit');
  const updated = await engine.saveEventProfile({ ...profileInput({ label: 'Renamed at capacity' }), id: profiles[0].id, expected_revision: 1 });
  assert.equal(updated.revision, 2); assert.equal((await engine.listEventProfiles()).profiles.length, 20);
  const other = setup();
  await other.saveEventProfile(profileInput({ label: 'Example Game' }));
  await throwsCode(() => other.saveEventProfile(profileInput({ label: 'example game' })), 'profile_name_in_use');
});

test('builtin presets remain read-only and apply only through their explicit kind and identity', async () => {
  const engine = setup();
  for (const id of ['ksp','generic']) await throwsCode(() => engine.saveEventProfile({ ...profileInput(), id, expected_revision: 1 }), 'profile_read_only');
  await throwsCode(() => engine.activateEventProfile({ kind: 'builtin', id: 'generic-legacy' }), 'profile_not_found');
  const builtin = await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
  assert.equal(builtin.active_ref.kind, 'builtin'); assert.equal(builtin.active_ref.id, 'ksp'); assert.equal(builtin.active_ref.revision, 1);
  assert.equal(builtin.active_ref.label, 'Kerbal Space Program');
  assert.deepEqual(builtin.events, (await listEventPresets())[0].events);
  const snapshot = await engine.saveEventProfile(profileInput({ label: 'My KSP copy', events: builtin.events }));
  assert.equal((await engine.listEventProfiles()).active_ref.kind, 'builtin');
  await apply(engine, snapshot);
  assert.equal((await engine.listEventProfiles()).active_ref.kind, 'profile');
  await throwsCode(() => engine.activateEventProfile({ kind: 'builtin', id: 'ksp', expected_revision: 2 }), 'profile_revision_conflict');
});

test('same-content profiles preserve their distinct identity across restarts and never infer builtin names', async () => {
  const engine = setup();
  const content = (await listEventPresets())[1].events;
  const first = await engine.saveEventProfile(profileInput({ label: 'Game A', events: content }));
  const second = await engine.saveEventProfile(profileInput({ label: 'Game B', events: content }));
  assert.notEqual(first.id, second.id);
  await apply(engine, first); await apply(engine, second);
  const restarted = setup({ store: new MemoryStore(engine.store.read()) });
  const pack = await restarted.listEventProfiles();
  assert.equal(pack.active_ref.kind, 'profile'); assert.equal(pack.active_ref.id, second.id); assert.equal(pack.active_ref.label, 'Game B');
  assert.equal(pack.dirty, false);
  const unlabelled = setup(); await unlabelled.importEventDefinitions(content);
  assert.equal((await unlabelled.listEventProfiles()).active_ref, null);
});

test('dirty is order independent, edits do not overwrite a saved snapshot, and explicit apply resets working changes', async () => {
  const engine = setup();
  const profile = await engine.saveEventProfile(profileInput({ events: [definition('alpha'), definition('beta')] }));
  await apply(engine, profile);
  await engine.updateConfig({ events: [...engine.config.events].reverse() });
  assert.equal((await engine.listEventProfiles()).dirty, false);
  await engine.upsertEventDefinition(definition('alpha', { label: 'An edited label' }));
  let pack = await engine.listEventProfiles();
  assert.equal(pack.dirty, true); assert.equal(pack.active_ref.id, profile.id);
  assert.deepEqual(pack.profiles[0].events, profile.events);
  await engine.deleteEventDefinition('beta');
  assert.equal((await engine.listEventProfiles()).dirty, true);
  await apply(engine, profile);
  assert.equal((await engine.listEventProfiles()).dirty, false);
  assert.deepEqual(engine.config.events, profile.events);
  await engine.importEventDefinitions(profile.events);
  pack = await engine.listEventProfiles();
  assert.equal(pack.active_ref, null); assert.equal(pack.dirty, false); assert.equal(pack.profiles.length, 1);
});

test('profile activation failures roll back events, identity, history, notes and runtime cooldowns together', async () => {
  const engine = setup();
  const valid = await engine.saveEventProfile(profileInput());
  await apply(engine, valid);
  await engine.submit({ opaqueId: 'Uprivateprofile' }, { body: 'Preserve this sealed note', category_id: 'encouragement', moment_id: 'profile-event', payment_mode: 'sim_points' });
  engine.state.event_runtime = { receipts: [{ key: 'kept' }], cooldowns: { 'profile-event': 100 }, candidates: [] };
  const conflicting = await engine.saveEventProfile(profileInput({ label: 'A conflicting snapshot', events: [definition('margit')] }));
  const before = engine.store.read();
  await throwsCode(() => apply(engine, conflicting), 'event_moment_conflict');
  assert.deepEqual(engine.store.read(), before);
  assert.deepEqual(engine.state, before);
  await engine.activateEventProfile({ kind: 'builtin', id: 'generic' });
  assert.deepEqual(engine.state.event_runtime, before.event_runtime);
  assert.equal(engine.state.notes[0].status, 'sealed');
  assert.ok(engine.config.moments.some(moment => moment.id === 'profile-event'));
});

test('a saved profile and applied identity persist in a private atomic JSON snapshot at mode 0600', async t => {
  const root = await temp(t); const file = path.join(root, 'notes.json');
  const engine = setup({ store: new JsonStore({ file }) });
  const profile = await engine.saveEventProfile(profileInput()); await apply(engine, profile);
  const before = await engine.listEventProfiles();
  const restored = setup({ store: new JsonStore({ file }) });
  assert.deepEqual(await restored.listEventProfiles(), before);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('legacy stores gain private defaults while invalid persisted snapshots fail without replacing the old store', async () => {
  const engine = setup(); const legacy = engine.store.read();
  delete legacy.event_profiles; delete legacy.event_profile_active_ref;
  const migrated = setup({ store: new MemoryStore(legacy) });
  assert.deepEqual(await migrated.listEventProfiles(), { profiles: [], active_ref: null, dirty: false });
  assert.deepEqual(migrated.state.notes, legacy.notes);
  const profile = await engine.saveEventProfile(profileInput());
  const valid = engine.store.read();
  for (const mutate of [
    state => { state.event_profiles = null; },
    state => { state.event_profiles[0].events.push(state.event_profiles[0].events[0]); },
    state => { state.event_profiles[0].revision = 0; },
    state => { state.event_profiles.push({ ...profile, id: 'profile-00000000-0000-4000-8000-000000000000' }); },
    state => { state.event_profile_active_ref = { kind: 'profile', id: profile.id, revision: 100, label: profile.label, events_hash: eventProfileHash(profile.events) }; },
  ]) {
    const broken = structuredClone(valid); mutate(broken); const store = new MemoryStore(broken);
    assert.throws(() => setup({ store })); assert.deepEqual(store.read(), broken);
  }
  assert.throws(() => validateStoredEventProfiles([profile, profile]), { code: 'invalid_profile' });
});

test('operator actions expose exact profile contracts and sync detectors only on explicit apply', async t => {
  const f = await fixture(t);
  const save = await f.post({ action: 'events_profile_save', profile: profileInput() });
  assert.equal(save.status, 200); const profile = (await save.json()).result.profile;
  assert.equal(f.syncs(), 0); assert.deepEqual(f.engine.config.events, []);
  const list = await f.post({ action: 'events_profiles' });
  assert.deepEqual((await list.json()).result, { profiles: [profile], active_ref: null, dirty: false });
  const activate = await f.post({ action: 'events_profile_activate', profile_kind: 'profile', profile_id: profile.id, expected_revision: profile.revision });
  assert.equal(activate.status, 200); const result = (await activate.json()).result;
  assert.deepEqual(result.events, profile.events); assert.equal(result.active_ref.id, profile.id); assert.equal(result.dirty, false);
  assert.equal(f.syncs(), 1);
  assert.equal((await f.post({ action: 'events_profile_activate', profile_kind: 'profile', profile_id: profile.id })).status, 400);
  const operator = await (await fetch(f.base + '/api/operator/state', { headers: { Cookie: f.cookie } })).json();
  assert.equal(operator.event_profiles.active_ref.id, profile.id);
  assert.equal((await f.post({ action: 'events_profile_save', profile: { ...profileInput(), id: profile.id, expected_revision: 99 } })).status, 409);
  assert.equal((await f.post({ action: 'events_profile_save', profile: { ...profileInput(), id: 'ksp', expected_revision: 1 } })).status, 403);
});

test('all profile actions require operator cookie, action header, same origin and direct loopback', async t => {
  const f = await fixture(t);
  for (const action of [
    { action: 'events_profiles' }, { action: 'events_profile_save', profile: profileInput() },
    { action: 'events_profile_activate', profile_kind: 'builtin', profile_id: 'generic' },
  ]) {
    for (const [headers, expected] of [[{ Cookie: '' },401],[{ 'X-Sealed-Action': '' },403],[{ Origin: 'https://untrusted.invalid' },403],[{ 'X-Forwarded-For': '198.51.100.2' },403],[{ Forwarded: 'for=198.51.100.2' },403]]) assert.equal((await f.post(action, headers)).status, expected);
    const raw = await new Promise((resolve, reject) => {
      const req = request(f.base + '/api/operator/action', { method: 'POST', headers: { Host: 'public.invalid', Cookie: f.cookie, Origin: f.base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify(action));
    });
    assert.equal(raw, 403);
  }
  assert.deepEqual((await f.engine.listEventProfiles()).profiles, []);
});

test('saved profile snapshots and active metadata never enter EBS, config, archive, overlays or event toasts', async t => {
  const f = await fixture(t);
  const canary = 'PROFILE_PRIVATE_METADATA_CANARY';
  const hidden = await f.engine.saveEventProfile(profileInput({ label: canary, description: canary, events: [definition('private-unused-event')] }));
  await f.engine.saveEventProfile(profileInput({ label: 'Inactive saved profile', events: [definition('inactive-only-event')] }));
  await apply(f.engine, hidden);
  for (const projection of [f.engine.config,f.engine.viewerState({opaqueId:'Uprofileviewer'}),f.engine.overlayState(),f.engine.archive(),f.engine.events({opaqueId:'Uprofileviewer'})]) {
    const json = JSON.stringify(projection);
    assert.equal(json.includes(canary), false); assert.equal(json.includes(hidden.id), false); assert.equal(json.includes('inactive-only-event'), false);
    assert.equal(json.includes('event_profiles'), false); assert.equal(json.includes('event_profile_active_ref'), false);
  }
  for (const [route, headers] of [
    ['/ebs/state',{ Origin:f.origin,Authorization:'Bearer '+f.jwt }],
    ['/api/archive',{}], ['/api/overlay',{}],
  ]) {
    const response = await fetch(f.base + route, { headers }); assert.equal(response.status,200);
    const json = await response.text(); assert.equal(json.includes(canary),false); assert.equal(json.includes(hidden.id),false);
  }
  assert.equal((await fetch(f.base + '/api/operator/profiles', { headers:{'X-Forwarded-For':'198.51.100.2'} })).status,404);
  assert.equal((await fetch(f.base + '/event-profiles.json')).status,404);
});

test('an explicitly applied empty profile survives application restart without default OBS presets or provider access', async () => {
  const engine = setup();
  const profile = await engine.saveEventProfile(profileInput({ label: 'An intentionally empty detector set', events: [] }));
  await apply(engine, profile);
  const store = new MemoryStore(engine.store.read());
  let captures = 0, classification = 0, closes = 0;
  const app = await createApplication({ store, env: { OBS_FRAME_WATCHER:'true', OBS_GAME_PROFILE:'ksp', OBS_SOURCE_NAME:'Synthetic source', DECISIONS_LIVE:'true' },
    decisions: { warmup:async()=>{},eventFrames:async()=>{classification++;throw Error('must not classify');},state:()=>({status:'mocked'}),close(){} },
    obsSourceFactory:()=>({readObservation:async()=>{captures++;return null;},close(){closes++;}}),
  });
  try {
    assert.deepEqual(app.engine.config.events, []);
    const pack = await app.engine.listEventProfiles();
    assert.equal(pack.active_ref.id, profile.id); assert.equal(pack.active_ref.label, profile.label); assert.equal(pack.dirty,false);
    assert.equal(app.engine.config.moments.some(moment=>moment.id==='ksp-launch'),false);
    assert.equal(captures,0); assert.equal(classification,0);
  } finally { await app.close(); }
  assert.equal(closes,1);
});


test('profile context is explicit identity, and only applying a different identity or revision clears pending candidates', async () => {
  assert.equal(eventProfileContext(null), '');
  const engine = setup();
  const first = await engine.saveEventProfile(profileInput({ label: 'Context A' }));
  const second = await engine.saveEventProfile(profileInput({ label: 'Context B' }));
  await apply(engine, first);
  const context = eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch);
  assert.equal(context, JSON.stringify(['profile', first.id, 1, engine.state.event_profile_context_epoch]));
  const runtime = { receipts: [{ id: 'preserved' }], cooldowns: { 'profile-event': 123 }, candidates: [{ id: 'candidate-a' }] };
  await engine._mutate(() => { engine.state.event_runtime = structuredClone(runtime); });
  await apply(engine, first);
  assert.deepEqual(engine.state.event_runtime, runtime);
  const revised = await engine.saveEventProfile({ ...profileInput({ label: 'Renamed Context A' }), id: first.id, expected_revision: 1 });
  assert.deepEqual(engine.state.event_runtime, runtime);
  assert.equal(eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch), context);
  await apply(engine, revised);
  assert.deepEqual(engine.state.event_runtime, { ...runtime, candidates: [] });
  assert.notEqual(eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch), context);
  await engine._mutate(() => { engine.state.event_runtime.candidates = [{ id: 'new-candidate' }]; });
  await apply(engine, second);
  assert.deepEqual(engine.state.event_runtime, { ...runtime, candidates: [] });
  assert.equal(engine.state.event_profile_active_ref.id, second.id);
});

test('a queued confirmation cannot cross between different profiles containing exactly the same events', async () => {
  const engine = setup();
  const first = await engine.saveEventProfile(profileInput({ label: 'Profile before queued switch' }));
  const second = await engine.saveEventProfile(profileInput({ label: 'Profile after queued switch' }));
  await apply(engine, first);
  const expectedProfileContext = eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch);
  const switching = apply(engine, second);
  const occurrence = engine.occur('profile-event', {}, 'api-confirmed', { expectedProfileContext });
  await switching;
  await throwsCode(() => occurrence, 'stale_profile_context');
  assert.equal(engine.state.occurrences.length, 0);
  await engine.occur('profile-event', {}, 'api-confirmed', { expectedProfileContext: eventProfileContext(engine.state.event_profile_active_ref, engine.state.event_profile_context_epoch) });
  assert.equal(engine.state.occurrences.length, 1);
});


test('profile snapshots remain saveable when applying new event IDs exceeds forty retained moments', async () => {
  const engine = setup();
  assert.equal(engine.config.moments.length, 13);
  const snapshot = (label, prefix, count) => engine.saveEventProfile(profileInput({ label, events: Array.from({ length: count }, (_, index) => definition(`${prefix}-${index}`)) }));
  const first = await snapshot('Twelve events A', 'alpha', 12);
  const second = await snapshot('Twelve events B', 'beta', 12);
  const third = await snapshot('Twelve events C', 'gamma', 12);
  await apply(engine, first); await apply(engine, second);
  assert.equal(engine.config.moments.length, 37);
  await engine._mutate(() => { engine.state.event_runtime = { receipts: [{ id: 'kept' }], cooldowns: { 'alpha-0': 100 }, candidates: [{ id: 'pending-before-failed-apply' }] }; });
  const before = engine.store.read();
  await throwsCode(() => apply(engine, third), 'profile_moment_limit');
  assert.deepEqual(engine.store.read(), before);
  assert.deepEqual(engine.state, before);
  assert.equal((await engine.listEventProfiles()).profiles.length, 3);
  const exact = await snapshot('Exactly forty moments', 'delta', 3);
  await apply(engine, exact);
  assert.equal(engine.config.moments.length, 40);
  await apply(engine, first); // Reusing retained IDs requires no additional capacity.
  assert.equal(engine.config.moments.length, 40);
  const oneMore = await snapshot('One over forty', 'epsilon', 1);
  await throwsCode(() => apply(engine, oneMore), 'profile_moment_limit');
  const conflict = await engine.saveEventProfile(profileInput({ label: 'A genuine moment conflict', events: [definition('margit')] }));
  await throwsCode(() => apply(engine, conflict), 'event_moment_conflict');
});

test('monotonic profile epochs fence an A-to-B-to-A identity cycle before an old occurrence can reveal', async () => {
  const engine = setup();
  const first = await engine.saveEventProfile(profileInput({ label: 'ABA profile A' }));
  const second = await engine.saveEventProfile(profileInput({ label: 'ABA profile B' }));
  assert.equal(engine.state.event_profile_context_epoch, 0);
  await apply(engine, first);
  const firstEpoch = engine.state.event_profile_context_epoch;
  const expectedProfileContext = eventProfileContext(engine.state.event_profile_active_ref, firstEpoch);
  const note = await engine.submit({ opaqueId: 'Uababoundary' }, { body: 'Stay sealed across profile cycles', category_id: 'encouragement', moment_id: 'profile-event', payment_mode: 'sim_points' });
  const switchToB = apply(engine, second);
  const returnToA = apply(engine, first);
  const lateOccurrence = engine.occur('profile-event', {}, 'api-confirmed', { expectedProfileContext });
  await Promise.all([switchToB, returnToA]);
  await throwsCode(() => lateOccurrence, 'stale_profile_context');
  assert.equal(engine.state.event_profile_active_ref.id, first.id);
  assert.equal(engine.state.event_profile_context_epoch, firstEpoch + 2);
  assert.equal(engine.state.notes.find(value => value.id === note.id).status, 'sealed');
  assert.equal(engine.state.occurrences.length, 0);
});

test('definition edits also advance the epoch, so restoring the same final event content cannot revive old evidence', async () => {
  const engine = setup();
  const profile = await engine.saveEventProfile(profileInput({ events: [definition('alpha'), definition('beta')] }));
  await apply(engine, profile);
  let epoch = engine.state.event_profile_context_epoch;
  const context = eventProfileContext(engine.state.event_profile_active_ref, epoch);
  await engine._mutate(() => { engine.state.event_runtime = { candidates: [{ id: 'old' }], receipts: [1], cooldowns: { alpha: 20 } }; });
  await engine.updateConfig({ events: [...engine.config.events].reverse() });
  assert.equal(engine.state.event_profile_context_epoch, epoch);
  assert.equal(engine.state.event_runtime.candidates.length, 1);
  await engine.upsertEventDefinition(definition('alpha', { label: 'Temporarily changed' }));
  assert.equal(engine.state.event_profile_context_epoch, ++epoch);
  assert.deepEqual(engine.state.event_runtime, { candidates: [], receipts: [1], cooldowns: { alpha: 20 } });
  await engine.updateConfig({ events: profile.events });
  assert.equal(engine.state.event_profile_context_epoch, ++epoch);
  assert.equal((await engine.listEventProfiles()).dirty, false);
  await throwsCode(() => engine.occur('alpha', {}, 'api-confirmed', { expectedProfileContext: context }), 'stale_profile_context');
  await engine.importEventDefinitions(profile.events);
  assert.equal(engine.state.event_profile_context_epoch, ++epoch); // Clearing an explicit ref is a boundary even with identical events.
  assert.equal(engine.state.event_profile_active_ref, null);
  await engine.importEventDefinitions(profile.events);
  assert.equal(engine.state.event_profile_context_epoch, epoch); // Repeating the same unlabeled import changes no context.
  const restored = setup({ store: new MemoryStore(engine.store.read()) });
  assert.equal(restored.state.event_profile_context_epoch, epoch);
  assert.equal(eventProfileContext(restored.state.event_profile_active_ref, epoch), JSON.stringify([null, null, null, epoch]));
});

test('missing epochs migrate to zero; invalid or exhausted epochs fail closed with no partial configuration changes', async () => {
  const engine = setup(); const legacy = engine.store.read(); delete legacy.event_profile_context_epoch;
  assert.equal(setup({ store: new MemoryStore(legacy) }).state.event_profile_context_epoch, 0);
  for (const epoch of [-1, 0.1, null, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = engine.store.read(); snapshot.event_profile_context_epoch = epoch;
    const store = new MemoryStore(snapshot);
    assert.throws(() => setup({ store }), { code: 'profile_context_unavailable' });
    assert.deepEqual(store.read(), snapshot);
  }
  await engine._mutate(() => { engine.state.event_profile_context_epoch = Number.MAX_SAFE_INTEGER; });
  const profile = await engine.saveEventProfile(profileInput({ events: [], label: 'Saving does not advance an exhausted context' }));
  const before = engine.store.read();
  await throwsCode(() => apply(engine, profile), 'profile_context_unavailable');
  assert.deepEqual(engine.state, before); assert.deepEqual(engine.store.read(), before);
  await throwsCode(() => engine.upsertEventDefinition(definition()), 'profile_context_unavailable');
  assert.deepEqual(engine.state, before);
});
