import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { DebugRecorder } from '../server/debug-recorder.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
async function fixture(t, { available = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-debug-http-'));
  await fs.mkdir(path.join(root, 'public'));
  for (const file of ['debug.html','debug.js','debug.css']) await fs.writeFile(path.join(root, 'public', file), file === 'debug.html' ? '<!doctype html><title>Private capture debugger</title>' : '/* private debugger */');
  const recorder = await DebugRecorder.open({ directory: path.join(root, 'data/debug') });
  const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
  const server = await createHTTP({ engine, root, debugRecorder: available ? recorder : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await recorder.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/operator/bootstrap');
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find(value => value.startsWith('sealed_operator=')).split(';')[0];
  const debugCookie = cookies.find(value => value.startsWith('sealed_debug=')).split(';')[0];
  return { root, recorder, base, cookie, debugCookie, cookies,
    action(body, headers = {}) { return fetch(base + '/api/operator/action', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); } };
}

test('debug mode uses operator action authentication and returns structured retained history', async t => {
  const f = await fixture(t);
  assert.match(f.cookies[0], /Path=\/api\/operator/);
  assert.match(f.cookies[1], /Path=\/debug/);
  const initial = await fetch(f.base + '/api/operator/debug', { headers: { Cookie: f.cookie } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).enabled, false);
  assert.equal((await f.action({ action: 'debug_set', enabled: true }, { Cookie: '' })).status, 401);
  assert.equal((await f.action({ action: 'debug_set', enabled: true }, { Origin: 'https://public.example.test' })).status, 403);
  assert.equal((await f.action({ action: 'debug_set', enabled: true }, { 'X-Sealed-Action': '' })).status, 403);
  assert.equal((await f.action({ action: 'debug_set', enabled: 'true' })).status, 400);
  const enabled = await f.action({ action: 'debug_set', enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).result.enabled, true);
  const observation = { id: 'capture-1', at: 1000, dataUrl: PNG };
  const frameId = f.recorder.recordFrame(observation);
  const requestId = f.recorder.beginRequest({ stage: 'screen', frames: [observation] });
  f.recorder.finishRequest(requestId, { outcome: 'ok', raw: { answers: [{ name: 'scene', type: 'choice', choice: 'gameplay', confidence: 0.9 }] } });
  await f.recorder.flush();
  const json = await (await fetch(f.base + '/api/operator/debug?frame_id=' + frameId, { headers: { Cookie: f.cookie } })).json();
  assert.equal(json.frames[0].id, frameId);
  assert.equal(json.requests[0].id, requestId);
  assert.equal(JSON.stringify(json).includes('data:image'), false);
  const request = await fetch(f.base + '/api/operator/debug/request/' + requestId, { headers: { Cookie: f.cookie } });
  assert.equal((await request.json()).request.status, 'ok');
  assert.equal((await fetch(f.base + '/api/operator/debug/request/' + randomUUID(), { headers: { Cookie: f.cookie } })).status, 404);
  const image = await fetch(f.base + json.frames[0].image_url, { headers: { Cookie: f.cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal((await f.action({ action: 'debug_set', enabled: false })).status, 200);
  const retained = await (await fetch(f.base + '/api/operator/debug', { headers: { Cookie: f.cookie } })).json();
  assert.equal(retained.enabled, false);
  assert.equal(retained.frames.length, 1);
});

test('every debug page, asset, JSON and image rejects public, forwarded and unauthenticated requests', async t => {
  const f = await fixture(t);
  await f.recorder.setEnabled(true);
  const frameId = f.recorder.recordFrame({ id: '1', at: 1000, dataUrl: PNG });
  await f.recorder.flush();
  for (const route of ['/debug','/debug/debug.html','/debug/debug.js','/debug/debug.css','/debug.html','/debug.js','/debug.css',
    '/api/operator/debug','/api/operator/debug/frame/' + frameId,'/api/operator/debug/request/' + randomUUID()]) {
    const Cookie = route.startsWith('/api/') ? f.cookie : f.debugCookie;
    assert.equal((await fetch(f.base + route, { redirect: 'manual' })).status, route==='/debug'?302:401, route);
    for (const headers of [{ Origin: 'https://public.example.test' }, { 'X-Forwarded-For': '203.0.113.5' },
      { Forwarded: 'for=203.0.113.5' }, { 'X-Forwarded-Host': 'notes.example.test' }]) {
      assert.equal((await fetch(f.base + route, { headers: { Cookie, ...headers } })).status, 403, route + ' ' + JSON.stringify(headers));
    }
    const hostStatus = await new Promise((resolve, reject) => {
      const request = http.get(f.base + route, { headers: { Cookie, Host: 'notes.example.test' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.once('error', reject);
    });
    assert.equal(hostStatus, 403, route + ' public Host');
  }
  for (const route of ['/debug','/debug/debug.html','/debug/debug.js','/debug/debug.css']) assert.equal((await fetch(f.base + route, { headers: { Cookie: f.debugCookie } })).status, 200);
  assert.equal((await fetch(f.base + '/api/archive')).status, 200);
  assert.deepEqual(await (await fetch(f.base + '/api/archive')).json(), { notes: [] });
  for (const route of ['/data/debug/index.json','/data/debug/frames/' + frameId + '.png','/frames/' + frameId + '.png']) assert.equal((await fetch(f.base + route)).status, 404);
});

test('bare debug entry refreshes only local scoped cookies through a fixed redirect', async t => {
  const f = await fixture(t);
  const entry = await fetch(f.base + '/debug', { redirect: 'manual' });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/api/operator/bootstrap?next=debug');
  const bootstrap = await fetch(f.base + entry.headers.get('location'), { redirect: 'manual' });
  assert.equal(bootstrap.status, 302);
  assert.equal(bootstrap.headers.get('location'), '/debug');
  assert.equal(bootstrap.headers.getSetCookie().length, 2);
  for (const query of ['?next=https://evil.example','?next=debug&next=debug','?next=debug&other=1']) {
    assert.equal((await fetch(f.base + '/api/operator/bootstrap' + query, { redirect: 'manual' })).status, 400);
  }
  for (const route of ['/debug','/api/operator/bootstrap?next=debug']) {
    for (const headers of [{ Origin: 'https://public.example.test' }, { 'X-Forwarded-For': '203.0.113.5' }]) {
      assert.equal((await fetch(f.base + route, { headers, redirect: 'manual' })).status, 403);
    }
  }
  const invalidCookie = await fetch(f.base + '/debug', { headers: { Cookie: 'sealed_debug=old-private-cookie' }, redirect: 'manual' });
  assert.equal(invalidCookie.status, 302);
});

test('debug query validation and unavailable recorder fail closed with fixed errors', async t => {
  const f = await fixture(t);
  for (const query of ['?limit=251','?before=-1','?limit=1&limit=2','?frame_id=../../secret','?unknown=1','?frame_id=' + randomUUID() + '&request_id=' + randomUUID()]) {
    assert.equal((await fetch(f.base + '/api/operator/debug' + query, { headers: { Cookie: f.cookie } })).status, 400, query);
  }
  assert.equal((await fetch(f.base + '/api/operator/debug/frame/' + randomUUID(), { headers: { Cookie: f.cookie } })).status, 404);
  assert.equal((await fetch(f.base + '/api/operator/debug', { method: 'POST', headers: { Cookie: f.cookie, 'X-Sealed-Action': '1' } })).status, 405);
  const unavailable = await fixture(t, { available: false });
  assert.equal((await fetch(unavailable.base + '/api/operator/debug', { headers: { Cookie: unavailable.cookie } })).status, 503);
  assert.equal((await unavailable.action({ action: 'debug_set', enabled: true })).status, 503);
});
