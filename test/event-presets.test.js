import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listEventPresets } from '../server/event-presets.js';
import { loadEventPreset } from '../server/event-definitions.js';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { EventWatcher } from '../server/event-watcher.js';
import { MemoryStore } from '../server/store.js';

const rawDefinition = id => ({ id, label: 'A visible event', description: 'A clearly visible event happens in the current stream.', mode: 'persistent' });
const unavailable = error => error.status === 503 && error.code === 'event_presets_unavailable';

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sealed-preset-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function httpFixture(t) {
  const root = await directory(t);
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'archive.html'), 'archive fixture');
  // A createHTTP root is a static-assets fixture, never the source of the builtin catalog.
  await mkdir(path.join(root, 'presets'));
  await writeFile(path.join(root, 'presets', 'ksp.json'), 'malformed fixture preset');
  const engine = new NotesEngine({ store: new MemoryStore(), decisions: {
    evaluate: async (_body, _config, _moment, category_id) => ({ moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id }, fit: 'fits' }),
    choose: async candidates => candidates.map(note => note.id),
  } });
  let syncs = 0;
  const server = await createHTTP({ root, engine, watcher: { syncDefinitions: () => { syncs++; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + '/api/operator/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const post = (body, headers = {}) => fetch(base + '/api/operator/action', {
    method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { root, engine, server, base, cookie, post, syncs: () => syncs };
}

test('the fixed two-entry catalog matches the checked-in normalized presets exactly', async () => {
  const presets = await listEventPresets();
  assert.deepEqual(presets.map(({ id, label }) => ({ id, label })), [
    { id: 'ksp', label: 'Kerbal Space Program' }, { id: 'generic', label: 'General games' },
  ]);
  for (const preset of presets) {
    assert.deepEqual(Object.keys(preset).sort(), ['description', 'events', 'id', 'label']);
    assert.ok(typeof preset.description === 'string' && preset.description.length > 0);
    assert.deepEqual(preset.events, (await loadEventPreset(new URL(`../presets/${preset.id}.json`, import.meta.url))).events);
    assert.ok(preset.events.every(event => typeof event.min_confidence === 'number' && Number.isInteger(event.cooldown_s) && typeof event.auto_confirm === 'boolean'));
  }
  const encoded = JSON.stringify(presets);
  assert.equal(encoded.includes('/home/'), false);
  assert.equal(encoded.includes('.json'), false);
  assert.equal(encoded.includes('generic-legacy'), false);
  presets[0].events[0].label = 'Caller mutation';
  assert.notEqual((await listEventPresets())[0].events[0].label, 'Caller mutation');
});

test('catalog fixtures normalize omitted defaults and ignore every non-allowlisted file', async t => {
  const dir = await directory(t);
  for (const id of ['ksp', 'generic']) await writeFile(path.join(dir, id + '.json'), JSON.stringify({ version: 1, events: [rawDefinition(id + '-fixture')] }));
  await writeFile(path.join(dir, 'generic-legacy.json'), 'malformed and never read');
  await writeFile(path.join(dir, 'private-canary.txt'), 'SYNTHETIC_SECRET_CANARY');
  const presets = await listEventPresets({ catalogDir: dir });
  assert.equal(presets.length, 2);
  assert.deepEqual(presets[0].events[0], { ...rawDefinition('ksp-fixture'), min_confidence: 0.85, cooldown_s: 30, auto_confirm: false });
  assert.equal(JSON.stringify(presets).includes(dir), false);
  assert.equal(JSON.stringify(presets).includes('SYNTHETIC_SECRET_CANARY'), false);
});

test('a missing, malformed, oversized, or symbolic builtin fails the entire catalog without a path leak', async t => {
  const dir = await directory(t);
  const ksp = path.join(dir, 'ksp.json');
  const generic = path.join(dir, 'generic.json');
  const valid = JSON.stringify({ version: 1, events: [rawDefinition('fixture-event')] });
  await writeFile(ksp, valid);
  await assert.rejects(() => listEventPresets({ catalogDir: dir }), error => unavailable(error) && !error.message.includes(dir));
  for (const invalid of ['{', JSON.stringify({ version: 1, events: [], arbitrary: true }), JSON.stringify({ version: 1, events: [{ ...rawDefinition('bad'), execute: 'arbitrary' }] }), ' '.repeat(65537)]) {
    await writeFile(generic, invalid);
    await assert.rejects(() => listEventPresets({ catalogDir: dir }), error => unavailable(error) && !error.message.includes(dir) && !error.message.includes(invalid));
  }
  await rm(generic);
  await symlink(ksp, generic);
  await assert.rejects(() => listEventPresets({ catalogDir: dir }), unavailable);
});

test('operator preset listing requires the cookie, same origin, action header and direct loopback', async t => {
  const f = await httpFixture(t);
  const body = JSON.stringify({ action: 'events_presets' });
  let response = await fetch(f.base + '/api/operator/action', { method: 'POST', headers: { Origin: f.base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' }, body });
  assert.equal(response.status, 401);
  response = await f.post({ action: 'events_presets' }, { 'X-Sealed-Action': '' });
  assert.equal(response.status, 403);
  for (const headers of [
    { Cookie: 'sealed_operator=wrong' }, { Origin: 'https://untrusted.invalid' },
    { 'X-Forwarded-For': '198.51.100.3' }, { Forwarded: 'for=198.51.100.3' },
    { 'X-Forwarded-Proto': 'https' },
  ]) {
    response = await f.post({ action: 'events_presets' }, headers);
    assert.ok([401,403].includes(response.status), `${JSON.stringify(headers)} returned ${response.status}`);
    assert.equal((await response.text()).includes('Kerbal Space Program'), false);
  }
  // Node's fetch normalizes Host; use the actual HTTP transport to test a public Host.
  const publicHost = await new Promise((resolve, reject) => {
    const req = request(f.base + '/api/operator/action', { method: 'POST', headers: { Host: 'notes.public.invalid', Cookie: f.cookie, Origin: f.base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal(publicHost.status, 403);
  assert.equal(publicHost.body.includes('Kerbal Space Program'), false);
  response = await f.post({ action: 'events_presets', catalogDir: '/untrusted/path' });
  assert.equal(response.status, 400);
  assert.equal((await fetch(f.base + '/api/operator/action', { headers: { Cookie: f.cookie } })).status, 405);
  for (const route of ['/api/operator/presets', '/api/event-presets', '/presets/ksp.json', '/presets/generic.json', '/presets/generic-legacy.json']) {
    const publicResponse = await fetch(f.base + route, { headers: { 'X-Forwarded-For': '198.51.100.3', Host: 'notes.public.invalid' } });
    assert.equal(publicResponse.status, 404, route);
  }
});

test('listing uses repository presets despite an isolated HTTP root and does not mutate engine state', async t => {
  const f = await httpFixture(t);
  await f.engine.upsertEventDefinition(rawDefinition('kept-event'));
  const before = f.engine.store.read();
  const response = await f.post({ action: 'events_presets' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.presets, await listEventPresets());
  assert.deepEqual(f.engine.store.read(), before);
  assert.equal(f.syncs(), 0);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('the existing events_import action applies a catalog selection while preserving prior notes and history', async t => {
  const f = await httpFixture(t);
  const catalogResponse = await f.post({ action: 'events_presets' });
  const catalog = (await catalogResponse.json()).result.presets;
  const ksp = catalog.find(preset => preset.id === 'ksp');
  const generic = catalog.find(preset => preset.id === 'generic');
  assert.equal((await f.post({ action: 'events_import', events: ksp.events })).status, 200);
  const viewer = { opaqueId: 'Upresetviewer' };
  const sealed = await f.engine.submit(viewer, { body: 'Keep this private until launch', category_id: 'encouragement', moment_id: 'ksp-launch', payment_mode: 'sim_points' });
  const opened = await f.engine.submit(viewer, { body: 'A historic explosion note', category_id: 'joke', moment_id: 'ksp-explosion', payment_mode: 'sim_points' });
  await f.engine.occur('ksp-explosion', 'A moderator confirmed the visible explosion.', 'ai-confirmed');
  const history = f.engine.archive();
  const occurrences = structuredClone(f.engine.state.occurrences);
  const balance = f.engine.viewerState(viewer).wallet;
  const response = await f.post({ action: 'events_import', events: generic.events });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.events, generic.events);
  assert.deepEqual(f.engine.config.events, generic.events);
  assert.ok(f.engine.config.moments.some(moment => moment.id === 'ksp-launch'));
  assert.ok(f.engine.config.moments.some(moment => moment.id === 'ksp-explosion'));
  assert.equal(f.engine.config.moments.find(moment => moment.id === 'first-death').kind, 'builtin');
  assert.equal(f.engine.viewerState(viewer).notes.find(note => note.id === sealed.id).status, 'sealed');
  assert.equal(f.engine.viewerState(viewer).notes.find(note => note.id === opened.id).status, 'revealed');
  assert.deepEqual(f.engine.viewerState(viewer).wallet, balance);
  assert.deepEqual(f.engine.archive(), history);
  assert.deepEqual(f.engine.state.occurrences, occurrences);
  assert.equal(f.syncs(), 2);
  assert.equal(JSON.stringify(await (await f.post({ action: 'events_presets' })).json()).includes('Keep this private'), false);
});


test('each demo preset event proposes on its first matching reviewed window without a negative baseline', async t => {
  const presets = await listEventPresets();
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  for (const preset of presets) {
    for (const definition of preset.events) {
      let clock = 100000, matching = false, reviews = 0;
      const watcher = new EventWatcher({ definitions: [definition], now: () => clock,
        judgements: { async eventFrames() {
          reviews++;
          return { scene: 'gameplay', continuity: 'same', events: { [definition.id]: matching ? 'yes' : 'no' } };
        } } });
      t.after(() => watcher.close());
      const feed = async () => {
        clock += 2000;
        return watcher.observe({ id: String(clock), at: clock, dataUrl: image });
      };
      // The first capture only fills the ring. The first judged window matches;
      // there are no earlier model negatives from which to arm a persistent event.
      await feed();
      matching = true;
      const candidates = await feed();
      assert.equal(reviews, 1, definition.id);
      assert.equal(candidates?.length, 1, definition.id);
      assert.equal(candidates[0].event_id, definition.id);
      assert.equal(candidates[0].needs_confirmation, true);
      watcher.confirm(candidates[0].id);
      for (let index = 0; index < 20; index++) await feed();
      assert.deepEqual(watcher.prompts(), [], 'the same visible cue remains latched even after cooldown: ' + definition.id);
    }
  }
});
