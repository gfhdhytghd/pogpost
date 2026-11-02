import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { NotesEngine } from '../server/domain.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';
import { createHTTP } from '../server/http.js';

const TOKEN = 'mock-events-token-not-a-real-secret';
const definitions = () => [
  { id: 'candidate-event', label: 'Candidate event', description: 'A visible event for human review.', mode: 'instant', cooldown_s: 30, auto_confirm: false, min_confidence: 0.85 },
  { id: 'automatic-event', label: 'Automatic event', description: 'An authenticated external event.', mode: 'instant', cooldown_s: 30, auto_confirm: true, min_confidence: 0.85 },
];
const trigger = (key = 'request-1', event = 'candidate-event', context = 'Synthetic event context') => ({ event_id: event, context, idempotency_key: key });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture({ configured = true } = {}) {
  let clock = 100000;
  const engine = new NotesEngine({ now: () => clock, decisions: new DemoJudgements() });
  await engine.importEventDefinitions(definitions());
  const events = new EventSystem({ engine, now: () => clock });
  const server = await createHTTP({ engine, eventSystem: events, watcher: events,
    env: configured ? { EVENTS_API_TOKEN: TOKEN } : {}, now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + '/api/operator/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  return {
    engine, events, base,
    advance(ms) { clock += ms; },
    now: () => clock,
    post(body = trigger(), { authorization = `Bearer ${TOKEN}`, headers = {}, method = 'POST', query = '' } = {}) {
      return fetch(base + '/api/events/trigger' + query, { method,
        headers: { 'Content-Type': 'application/json', ...(authorization === null ? {} : { Authorization: authorization }), ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    },
    rawPost(headers) {
      return new Promise((resolve, reject) => {
        const request = http.request(base + '/api/events/trigger', {
          method: 'POST', timeout: 5000,
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
        }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.once('timeout', () => request.destroy(Error('Loopback request timed out')));
        request.end(JSON.stringify(trigger()));
      });
    },
    operator(body) {
      return fetch(base + '/api/operator/action', { method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    },
    submit(event = 'candidate-event') {
      return engine.submit({ opaqueId: 'Uviewer' }, { body: 'Private event note', category_id: 'advice', moment_id: event,
        payment_mode: 'sim_points', request_id: 'note-' + event });
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('private trigger requires a configured Bearer token and returns a safe unknown-event error', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const authorization of [null, 'Basic ' + TOKEN, 'Bearer wrong', 'Bearer ' + 'x'.repeat(TOKEN.length), 'Bearer ' + 'x'.repeat(513)]) {
    const response = await f.post(trigger(), { authorization });
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('Synthetic event context'), false);
  }
  const missing = await f.post(trigger('unknown', 'missing-event'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'event_not_found');
  assert.deepEqual(f.events.prompts(), []);
  assert.equal(f.engine.state.occurrences.length, 0);
});

test('an unconfigured private trigger fails closed without accepting a candidate', async t => {
  const f = await fixture({ configured: false }); t.after(() => f.close());
  assert.equal((await f.post()).status, 503);
  assert.deepEqual(f.events.prompts(), []);
});

test('forwarded traffic, a public Host, and cross-origin browsers cannot use a valid trigger token', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const headers of [
    { Forwarded: 'for=198.51.100.1;proto=https' }, { 'X-Forwarded-For': '198.51.100.1' },
    { 'X-Forwarded-Host': 'notes.example.test' }, { 'X-Forwarded-Proto': 'https' },
    { Host: 'notes.example.test' }, { Origin: 'https://notes.example.test' }, { Origin: 'null' },
  ]) assert.equal(await f.rawPost(headers), 403, JSON.stringify(headers));
  assert.deepEqual(f.events.prompts(), []);
  const local = await f.post(trigger(), { headers: { Origin: f.base } });
  assert.equal(local.status, 200);
  assert.equal((await local.json()).status, 'candidate');
});

test('trigger method, JSON schema, context size, and query strings are bounded', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.post(undefined, { method: 'GET' })).status, 405);
  assert.equal((await f.post(trigger(), { query: '?token=ignored' })).status, 400);
  for (const body of [
    {}, trigger('bad key'), { ...trigger(), execute: 'untrusted' },
    { ...trigger(), context: {} }, { ...trigger(), context: '文'.repeat(1201) },
  ]) assert.equal((await f.post(body)).status, 400);
  const validUnicode = await f.post(trigger('unicode', 'candidate-event', '文'.repeat(1200)));
  assert.equal(validUnicode.status, 200);
  assert.equal((await validUnicode.text()).includes('文'), false);
});

test('concurrent retries share one candidate and fingerprint conflicts do not bypass cooldown', async t => {
  const f = await fixture(); t.after(() => f.close());
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.post(trigger('same-key'))));
  assert.ok(responses.every(response => response.status === 200));
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.receipt_id)).size, 1);
  assert.equal(receipts.filter(receipt => receipt.duplicate === false).length, 1);
  assert.equal(receipts.filter(receipt => receipt.duplicate === true).length, 2);
  assert.equal(f.events.prompts().length, 1);
  assert.equal(f.engine.state.occurrences.length, 0);
  assert.equal((await f.post(trigger('same-key', 'candidate-event', 'Different context'))).status, 409);
  assert.equal((await f.post(trigger('same-key', 'automatic-event'))).status, 409);
  assert.equal((await f.post(trigger('another-key'))).status, 429);
  assert.equal(JSON.stringify(f.engine.state.event_runtime.receipts).includes('same-key'), false);
  f.advance(30001);
  assert.equal((await f.post(trigger('after-cooldown'))).status, 200);
  assert.equal(f.events.prompts().length, 1);
});

test('explicit API auto-confirm occurs once and reveals only the selected event note', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.submit('automatic-event');
  assert.deepEqual(f.engine.archive(), []);
  const first = await f.post(trigger('auto-key', 'automatic-event'));
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(receipt.status, 'occurred');
  assert.equal(JSON.stringify(receipt).includes('Private event note'), false);
  assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'automatic-event').length, 1);
  assert.equal(f.engine.archive().length, 1);
  assert.equal(f.engine.archive()[0].reliability, 'API event · automatic');
  const retry = await f.post(trigger('auto-key', 'automatic-event'));
  assert.equal(retry.status, 200);
  const replay = await retry.json();
  assert.equal(replay.duplicate, true);
  assert.equal(replay.receipt_id, receipt.receipt_id);
  assert.equal(replay.status, 'occurred');
  assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'automatic-event').length, 1);
  assert.deepEqual(f.events.prompts(), []);
});

test('API and AI candidates share human review, while AI cannot use an auto-confirm definition automatically', async t => {
  const f = await fixture(); t.after(() => f.close());
  const candidate = await (await f.post(trigger('manual-key'))).json();
  assert.equal(candidate.status, 'candidate');
  assert.equal((await f.operator({ action: 'confirm_ai', id: candidate.candidate_id, approve: false })).status, 200);
  assert.equal(f.engine.state.occurrences.length, 0);
  await f.submit('automatic-event');
  const proposed = await f.events.propose('automatic-event', { source: 'ai', observedAt: f.now(), evidence: 'MODEL_PRIVATE_CANARY' });
  assert.equal(proposed.status, 'candidate');
  assert.equal(f.engine.state.occurrences.length, 0);
  assert.equal(f.events.prompts().length, 1);
  assert.equal(JSON.stringify(f.events.prompts()).includes('MODEL_PRIVATE_CANARY'), false);
  assert.equal((await f.operator({ action: 'confirm_ai', id: proposed.candidate_id, approve: true })).status, 200);
  assert.equal(f.engine.archive().length, 1);
  assert.equal(f.engine.state.occurrences[0].confirmed_by, 'ai-confirmed');
  assert.deepEqual(f.events.prompts(), []);
});

test('candidate expiry, stream wrap-up and session rollover fence old confirmations and keys', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = await (await f.post(trigger('expiring-key'))).json();
  f.advance(30001);
  assert.deepEqual(f.events.prompts(), []);
  assert.equal((await f.operator({ action: 'confirm_ai', id: first.candidate_id, approve: true })).status, 404);
  const wrapped = await (await f.post(trigger('old-session-key'))).json();
  await f.engine.wrap();
  assert.deepEqual(f.events.prompts(), []);
  assert.equal((await f.post(trigger('during-wrap'))).status, 409);
  assert.equal((await f.operator({ action: 'confirm_ai', id: wrapped.candidate_id, approve: true })).status, 404);
  await f.engine.newSession();
  assert.equal((await f.post(trigger('old-session-key'))).status, 409);
  assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'candidate-event').length, 0);
});

test('authenticated trigger admission is limited to ten requests per second', async t => {
  const f = await fixture(); t.after(() => f.close());
  const responses = await Promise.all(Array.from({ length: 11 }, () => f.post(trigger('rate-retry'))));
  assert.equal(responses.filter(response => response.status === 200).length, 10);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(f.events.prompts().length, 1);
});

test('invalid Bearer requests are bounded before authentication', async t => {
  const f = await fixture(); t.after(() => f.close());
  const responses = await Promise.all(Array.from({ length: 41 }, () => f.post(trigger(), { authorization: 'Bearer wrong' })));
  assert.equal(responses.filter(response => response.status === 401).length, 40);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.deepEqual(f.events.prompts(), []);
});

test('queued AI evidence cannot cross a session, definition change, freshness limit, or reset', async t => {
  for (const change of ['session', 'definition', 'freshness', 'reset']) {
    await t.test(change, async t => {
      const f = await fixture(); t.after(() => f.close());
      const entered = deferred(), gate = deferred();
      t.after(() => gate.resolve());
      const blocker = f.engine._mutate(async () => { entered.resolve(); await gate.promise; return {}; });
      await entered.promise;
      let mutation;
      if (change === 'session') mutation = f.engine.newSession();
      if (change === 'definition') mutation = f.engine.upsertEventDefinition({ ...definitions()[0], description: 'A different visible event.' });
      const proposed = f.events.propose('candidate-event', { source: 'ai', observedAt: f.now() });
      if (change === 'freshness') f.advance(5001);
      if (change === 'reset') mutation = f.events.reset();
      gate.resolve();
      await Promise.all([blocker, mutation]);
      assert.equal(await proposed, null);
      assert.deepEqual(f.events.prompts(), []);
      assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'candidate-event').length, 0);
    });
  }
});

test('an API request waiting behind a new session rejects rather than moving into that session', async t => {
  const f = await fixture(); t.after(() => f.close());
  const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const blocker = f.engine._mutate(async () => { entered.resolve(); await gate.promise; return {}; });
  await entered.promise;
  const session = f.engine.newSession();
  const pending = f.events.trigger(trigger('arrived-in-old-session'));
  const rejected = assert.rejects(pending, { status: 409, code: 'stale_event_trigger' });
  gate.resolve();
  await Promise.all([blocker, session, rejected]);
  assert.deepEqual(f.events.prompts(), []);
});

test('API automatic confirmation revalidates definition and expiry after accepting a receipt', async t => {
  for (const change of ['definition', 'expiry']) {
    await t.test(change, async t => {
      const f = await fixture(); t.after(() => f.close());
      const entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
      const occur = f.engine.occur.bind(f.engine);
      f.engine.occur = async (...args) => { entered.resolve(); await gate.promise; return occur(...args); };
      const request = trigger('auto-waits', 'automatic-event');
      const pending = f.events.trigger(request);
      const rejected = assert.rejects(pending, { status: 409 });
      await entered.promise;
      if (change === 'definition') await f.engine.upsertEventDefinition({ ...definitions()[1], description: 'A changed external event.' });
      else f.advance(30001);
      gate.resolve();
      await rejected;
      assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'automatic-event').length, 0);
      await assert.rejects(f.events.trigger(request), { status: 409 });
      assert.deepEqual(f.engine.archive(), []);
    });
  }
});

test('current-session API keys remain idempotent at the bounded receipt capacity', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (let index = 0; index < 512; index++) {
    const receipt = await f.events.trigger(trigger('bounded-' + index));
    assert.equal(receipt.status, 'candidate');
    f.advance(30001);
  }
  assert.equal(f.engine.state.event_runtime.receipts.length, 512);
  await assert.rejects(f.events.trigger(trigger('over-capacity')), { status: 429, code: 'events_history_full' });
  const replay = await f.events.trigger(trigger('bounded-0'));
  assert.equal(replay.duplicate, true);
  assert.equal(f.engine.state.event_runtime.receipts.length, 512);
  assert.deepEqual(f.events.prompts(), []);
});
