import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { NotesEngine } from '../server/domain.js';
import { DemoJudgements } from '../server/judgements.js';
import { KSPWatcher } from '../server/ksp-perception.js';
import { createHTTP } from '../server/http.js';

const image = 'data:image/png;base64,iVBORw0KGgo=';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  let clock = 100000;
  const engine = new NotesEngine({ now: () => clock, decisions: new DemoJudgements() });
  await engine.updateConfig({ moments: [...engine.config.moments, {
    id: 'ksp-explosion', label: 'Destructive explosion', kind: 'ai', long_lived: false,
  }] });
  const watcher = new KSPWatcher({
    now: () => clock,
    getSessionId: () => `${engine.state.session.id}:${engine.state.session.wrapped_at ?? ''}`,
    isActive: () => engine.state.session.wrapped_at === null,
    judgements: { kspFrames: async () => ({ scene: 'flight', continuity: 'same', events: { explosion: 'yes' } }) },
  });
  await watcher.observe({ id: 'one', at: clock, dataUrl: image });
  clock += 2000;
  await watcher.observe({ id: 'two', at: clock, dataUrl: image });
  const prompt = watcher.prompts()[0];
  assert.ok(prompt, 'a current-session human confirmation prompt exists');

  const consumed = deferred();
  const confirm = watcher.confirm.bind(watcher);
  watcher.confirm = id => {
    const result = confirm(id);
    if (result) consumed.resolve();
    return result;
  };
  const server = await createHTTP({ engine, watcher, now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + '/api/operator/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const releases = [];
  return {
    engine, prompt, consumed,
    setClock(value) { clock = value; },
    async blockMutation() {
      const entered = deferred(), gate = deferred();
      releases.push(gate.resolve);
      // Stand in for an asynchronous judgement already holding the serialized engine queue.
      const operation = engine._mutate(async () => { entered.resolve(); await gate.promise; return {}; });
      await entered.promise;
      return { operation, release: gate.resolve };
    },
    submit(requestId) {
      return engine.submit({ opaqueId: 'Unew' }, {
        body: 'Private note waiting in this session', category_id: 'advice',
        moment_id: 'ksp-explosion', payment_mode: 'sim_points', request_id: requestId,
      });
    },
    confirm() {
      return fetch(base + '/api/operator/action', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'X-Sealed-Action': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm_ai', id: prompt.id, approve: true }),
      });
    },
    async close() {
      for (const release of releases) release();
      watcher.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('a queued new session fences an old KSP confirmation before it can reveal a new-session note', { timeout: 5000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  const oldSession = f.engine.state.session.id;
  const blocked = await f.blockMutation();
  const newSession = f.engine.newSession();
  const newNote = f.submit('new-session-note');
  const confirmation = f.confirm();
  await f.consumed.promise;
  blocked.release();
  const [, , receipt] = await Promise.all([blocked.operation, newSession, newNote]);
  const response = await confirmation;

  assert.equal(response.status, 409);
  assert.notEqual(f.engine.state.session.id, oldSession);
  assert.equal(f.engine.state.notes.find(note => note.id === receipt.id).status, 'sealed');
  assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'ksp-explosion').length, 0);
  assert.deepEqual(f.engine.archive(), []);
  assert.equal((await response.text()).includes('Private note waiting'), false);
});

test('a KSP prompt expiring while its confirmation waits in the engine queue cannot reveal a note', { timeout: 5000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  const receipt = await f.submit('expiry-note');
  const blocked = await f.blockMutation();
  const confirmation = f.confirm();
  await f.consumed.promise;
  f.setClock(f.prompt.expires_at + 1);
  blocked.release();
  await blocked.operation;
  const response = await confirmation;

  assert.equal(response.status, 409);
  assert.equal(f.engine.state.notes.find(note => note.id === receipt.id).status, 'sealed');
  assert.equal(f.engine.state.occurrences.filter(event => event.moment_id === 'ksp-explosion').length, 0);
  assert.deepEqual(f.engine.archive(), []);
  assert.equal((await response.text()).includes('Private note waiting'), false);
});
