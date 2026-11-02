import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';
import { Judgements } from '../server/judgements.js';

const run = promisify(execFile);
test('the explicit live flag cannot turn an offline demo into a provider client', async () => {
  await assert.rejects(run(process.execPath, [path.resolve(import.meta.dirname, '../server/index.js'), '--demo', '--decisions-live', '--port=0'], {
    env: { PATH: process.env.PATH, HOME: '/tmp' }, timeout: 4000,
  }), error => error.code === 1 && error.stderr.includes('Live Decisions cannot be enabled in the offline demo.') && !error.stdout);
});

test('operator diagnostics expose bounded provider health and warmup without exposing credentials publicly', async () => {
  const key = 'synthetic-private-key-canary';
  const judge = new Judgements({ keyReader: () => key, fetchFn: async () => ({ ok: true, json: async () => ({ answers: [{ choice: 'ready', confidence: 1 }] }) }) });
  const app = await createApplication({ store: new MemoryStore(), env: { DECISIONS_LIVE: 'true' }, decisions: judge });
  try {
    await judge.warmup();
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const cookie = (await fetch(base + '/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(base + '/api/operator/state', { headers: { Cookie: cookie } })).json();
    const health = state.integrations.judgements;
    assert.equal(health.status, 'ready');
    assert.equal(health.enabled, true);
    assert.equal(health.simulated, false);
    assert.equal(health.warmup.ok, true);
    assert.deepEqual(health.deadlines, { submissionMs: 1500, frameMs: 2000 });
    assert.equal(JSON.stringify(state).includes(key), false);
    assert.equal((await fetch(base + '/api/operator/state')).status, 401);
    assert.equal((await fetch(base + '/api/operator/state', { headers: { Cookie: cookie, 'X-Forwarded-For': '198.51.100.4' } })).status, 403);
    assert.deepEqual(await (await fetch(base + '/api/archive')).json(), { notes: [] });
  } finally { await app.close(); }
});
