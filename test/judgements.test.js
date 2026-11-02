import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Judgements, DemoJudgements, ruleViolation, DECISIONS_URL } from '../server/judgements.js';
import { FrameWatcher } from '../server/perception.js';
import { createOBSSource } from '../server/obs-source.js';

// Credentials are injected literals. This suite never reads .env or calls a live endpoint.
const config = { moderation: { strictness: 'lenient', forbidden_topics: ['spoilers'], custom_words: [] }, categories: [
  { id: 'advice', name: 'Advice', description: 'Useful tips' },
  { id: 'prediction', name: 'Prediction', description: 'Claims about a future outcome' },
  { id: 'joke', name: 'Joke', description: 'Humour' },
] };
const moment = { id: 'boss', label: 'Beat the boss', kind: 'declared' };
const answer = (value, confidence = 0.95) => ({ choice: value, confidence });
const response = (answers) => ({ ok: true, json: async () => ({ answers }) });
const normal = () => response([answer('safe'), answer('prediction'), answer('fits')]);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('submission sends one documented request with three independent questions', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock-secret', fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, DECISIONS_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer mock-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.questions.length, 3);
    for (const item of body.questions) {
      assert.equal(item.type, 'choice');
      assert.ok(item.instructions.includes('untrusted data'));
      assert.equal('id' in item, false);
      assert.ok(item.choices.length >= 2);
    }
    for (const floor of ['harassment', 'hate', 'sexual content', 'personal data', 'self-harm', 'threats']) assert.ok(body.questions[0].instructions.includes(floor));
    assert.ok(body.questions[0].instructions.includes('lenient'));
    assert.deepEqual(JSON.parse(body.input[0].content).extra_forbidden_topics, ['spoilers']);
    return normal();
  } });
  const result = await client.evaluate('I predict a clean victory!', config, moment, 'joke');
  assert.equal(calls, 1);
  assert.equal(result.moderation.verdict, 'safe');
  assert.equal(result.classification.category_id, 'prediction');
  assert.equal(result.fit, 'fits');
  assert.equal(result.moderation.source, 'decisions');
  assert.equal(client.state().rolling.samples, 1);
  assert.ok(!JSON.stringify(client.state()).includes('mock-secret'));
  client.close();
});

test('invalid classification never invalidates independently safe moderation', async () => {
  for (const category of [{ choice: 'invented', confidence: 1 }, { refusal: 'cannot classify' }, answer('unsure'), answer('prediction', 0.2)]) {
    const client = new Judgements({ keyReader: () => 'mock', fetchFn: async () => response([answer('safe'), category, answer('mismatched')]) });
    const result = await client.evaluate('You can win this!', config, moment, 'advice');
    assert.equal(result.moderation.verdict, 'safe');
    assert.equal(result.classification.category_id, 'advice');
    assert.equal(result.fit, 'mismatched');
    client.close();
  }
});

test('refusal, invalid and low-confidence moderation always require review', async () => {
  for (const moderation of [{ refusal: 'declined', choice: 'safe', confidence: 1 }, answer('safe', 0.4), answer('safe', 2), answer('invented'), { choice: 'safe' }, answer('safe', NaN)]) {
    const client = new Judgements({ keyReader: () => 'mock', fetchFn: async () => response([moderation, answer('prediction'), answer('fits')]) });
    const result = await client.evaluate('A clean victory soon!', config, moment, 'joke');
    assert.equal(result.moderation.verdict, 'unsure');
    assert.equal(result.classification.category_id, 'prediction');
    client.close();
  }
});

test('offline, disabled and HTTP errors hold moderation and retain viewer category', async () => {
  for (const options of [{ keyReader: () => '' }, { enabled: false, keyReader: () => 'mock' }, { keyReader: () => 'mock', fetchFn: async () => ({ ok: false }) },
    { keyReader: () => 'mock', fetchFn: async () => { throw Error('secret provider details'); } }]) {
    const client = new Judgements({ fetchFn: async () => { throw Error('unexpected fetch'); }, ...options });
    const result = await client.evaluate('Hello streamer!', config, moment, 'joke');
    assert.equal(result.moderation.verdict, 'unsure');
    assert.equal(result.moderation.source, 'rules');
    assert.equal(result.classification.category_id, 'joke');
    assert.equal(result.fit, 'unsure');
    assert.ok(!JSON.stringify(client.state()).includes('provider'));
    client.close();
  }
});

test('local rules cannot be weakened and reject before remote admission', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: async () => { calls++; return normal(); } });
  for (const body of ['', 'x'.repeat(141), 'https://bad.example', 'kill yourself', 'I will kill you', 'your home address is 123 Main', 'private@example.com', '123-45-6789']) {
    assert.equal((await client.evaluate(body, config, moment, 'joke')).moderation.verdict, 'violates');
  }
  assert.equal(ruleViolation('custom forbidden', { moderation: { custom_words: ['forbidden'] } }), true);
  assert.equal(calls, 0);
  client.close();
});

test('hard deadline also terminates hung fetch and hung JSON mocks ignoring AbortSignal', async () => {
  for (const fetchFn of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const client = new Judgements({ keyReader: () => 'mock', fetchFn, deadlines: { submissionMs: 30, frameMs: 15 } });
    const started = performance.now();
    assert.equal((await client.evaluate('Hello!', config, moment, 'joke')).moderation.verdict, 'unsure');
    assert.ok(performance.now() - started < 300);
    assert.equal(client.state().in_flight, 0);
    assert.equal(client.state().rolling.fallbacks, 1);
    client.close();
  }
});

test('admission never sends more than eight simultaneous calls', async () => {
  const gate = deferred();
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: async () => { calls++; await gate.promise; return normal(); } });
  const pending = Array.from({ length: 8 }, (_, index) => client.evaluate('Hello!', config, moment, 'joke', { key: `viewer-${index}` }));
  assert.equal(client.state().in_flight, 8);
  const overflow = await client.evaluate('Hello!', config, moment, 'joke', { key: 'ninth-viewer' });
  assert.equal(overflow.moderation.verdict, 'unsure');
  assert.equal(calls, 8);
  gate.resolve();
  await Promise.all(pending);
  assert.equal(client.state().in_flight, 0);
  assert.equal(client.state().pending, 0);
  client.close();
});

test('per-viewer coalescing retains one active and only the newest pending submission', async () => {
  const gate = deferred();
  const notes = [];
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: async (url, options) => {
    notes.push(JSON.parse(JSON.parse(options.body).input[0].content).note);
    if (notes.length === 1) await gate.promise;
    return normal();
  } });
  const first = client.evaluate('First', config, moment, 'joke', { key: 'viewer' });
  const old = client.evaluate('Old', config, moment, 'joke', { key: 'viewer' });
  const newest = client.evaluate('Newest', config, moment, 'joke', { key: 'viewer' });
  assert.equal((await old).moderation.verdict, 'unsure');
  assert.equal(client.state().pending, 1);
  assert.equal(client.state().rolling.coalesced, 1);
  gate.resolve();
  assert.equal((await first).moderation.verdict, 'safe');
  assert.equal((await newest).moderation.verdict, 'safe');
  assert.deepEqual(notes, ['First', 'Newest']);
  client.close();
});

test('queued work shares its overall submission deadline', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', deadlines: { submissionMs: 40 }, fetchFn: async () => { calls++; return new Promise(() => {}); } });
  const first = client.evaluate('First', config, moment, 'joke', { key: 'viewer' });
  await sleep(10);
  const started = performance.now();
  const second = client.evaluate('Second', config, moment, 'joke', { key: 'viewer' });
  await first;
  assert.equal((await second).moderation.verdict, 'unsure');
  assert.ok(performance.now() - started < 110);
  assert.equal(calls, 2);
  client.close();
});

test('close cancels active requests and pending coalesced work without leaking diagnostics', async () => {
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: () => new Promise(() => {}) });
  const first = client.evaluate('First', config, moment, 'joke', { key: 'viewer' });
  const pending = client.evaluate('Second', config, moment, 'joke', { key: 'viewer' });
  client.close();
  assert.equal((await first).moderation.verdict, 'unsure');
  assert.equal((await pending).moderation.verdict, 'unsure');
  assert.equal(client.state().status, 'closed');
  assert.equal(client.state().in_flight, 0);
});

test('warmup coalesces, uses shared transport and does not enter submission metrics', async () => {
  const gate = deferred();
  let calls = 0, closed = false;
  const transport = { fetch: async () => { calls++; await gate.promise; return response([answer('ready')]); }, close: () => { closed = true; } };
  const client = new Judgements({ keyReader: () => 'mock', transport });
  const first = client.warmup();
  assert.equal(first, client.warmup());
  assert.equal(client.state().warming, true);
  gate.resolve();
  assert.equal((await first).ok, true);
  assert.equal(calls, 1);
  assert.equal(client.state().rolling.samples, 0);
  client.close();
  assert.equal(closed, true);
});

test('selection bounds candidates and validates returned identifiers; single candidate skips request', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(JSON.parse(body.input[0].content).candidates.length, 10);
    return response([answer(calls === 1 ? 'note-9' : 'invented')]);
  } });
  assert.deepEqual(await client.choose([{ id: 'only' }], moment), ['only']);
  assert.equal(calls, 0);
  const candidates = Array.from({ length: 20 }, (_, index) => ({ id: `note-${index}`, body: 'Hello' }));
  assert.deepEqual(await client.choose(candidates, moment), ['note-9']);
  assert.deepEqual(await client.choose(candidates, moment), []);
  client.close();
});

test('prediction and frame validate choices; frame rejects external URLs and has 2000ms maximum', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', deadlines: { frameMs: 9999 }, fetchFn: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (calls === 1) return response([answer('came_true')]);
    assert.equal(body.input[0].content[1].type, 'input_image');
    assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,AAAA');
    return response([answer('death_screen')]);
  } });
  assert.equal(await client.predict({ body: 'Victory!' }, { outcome: 'victory' }), 'came_true');
  assert.equal(await client.frame('https://internal.invalid/screenshot.png'), 'unsure');
  assert.equal(await client.frame('data:image/png;base64,AAAA'), 'death_screen');
  assert.equal(client.state().deadlines.frameMs, 2000);
  assert.equal(calls, 2);
  client.close();
});

test('frame hard deadline ignores a hung endpoint and produces no event', async () => {
  const client = new Judgements({ keyReader: () => 'mock', deadlines: { frameMs: 15 }, fetchFn: () => new Promise(() => {}) });
  assert.equal(await client.frame('data:image/png;base64,AAAA'), 'unsure');
  client.close();
});

test('speech uses a bounded Decisions choice request and never invents a result on refusal', async () => {
  let calls = 0;
  const client = new Judgements({ keyReader: () => 'mock', fetchFn: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.questions[0].choices.map((item) => item.value), ['blames_game', 'boast', 'laughing', 'other', 'unsure']);
    assert.ok(body.questions[0].instructions.includes('Do not invent audio'));
    assert.equal(JSON.parse(body.input[0].content).transcript, 'This game is unfair!');
    return response([calls === 1 ? answer('blames_game') : { refusal: 'cannot decide', choice: 'blames_game', confidence: 1 }]);
  } });
  assert.equal(await client.speech('This game is unfair!'), 'blames_game');
  assert.equal(await client.speech('This game is unfair!'), 'unsure');
  assert.equal(await client.speech('x'.repeat(2001)), 'unsure');
  assert.equal(await client.speech(undefined), 'unsure');
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(client.state()).includes('unfair'));
  client.close();
});

test('speech deadline rejects hung mocks that ignore AbortSignal', async () => {
  const client = new Judgements({ keyReader: () => 'mock', deadlines: { frameMs: 15 }, fetchFn: () => new Promise(() => {}) });
  assert.equal(await client.speech('This game is unfair!'), 'unsure');
  assert.equal(client.state().in_flight, 0);
  client.close();
});

test('frame watcher requires consecutive agreement and only proposes human confirmations', async () => {
  const results = ['death_screen', 'gameplay', 'death_screen', 'death_screen', 'death_screen', 'unsure', 'victory_screen', 'victory_screen'];
  const prompts = [];
  const watcher = new FrameWatcher({ judgements: { frame: async () => results.shift() }, onConfirmation: (proposal) => prompts.push(proposal) });
  for (let index = 0; index < 8; index++) await watcher.observe('frame');
  assert.deepEqual(prompts.map((item) => item.kind), ['death_screen', 'victory_screen']);
  assert.ok(prompts.every((item) => item.needs_confirmation === true && !('occurred_at' in item)));
  assert.equal(watcher.start(), false);
  watcher.close();
  assert.equal(await watcher.observe('frame'), null);
});

test('demo is explicitly simulated and never replaces production fallback', async () => {
  const demo = new DemoJudgements();
  assert.equal((await demo.evaluate('A victory!', config, moment, 'prediction')).moderation.verdict, 'safe');
  assert.equal((await demo.evaluate('[demo:hold] review me', config, moment, 'joke')).moderation.verdict, 'unsure');
  assert.equal((await demo.evaluate('kill yourself', config, moment, 'joke')).moderation.verdict, 'violates');
  assert.equal(await demo.predict({}, 'A clean victory. The prediction came true.'), 'came_true');
  assert.equal(demo.state().simulated, true);
  const production = new Judgements({ fetchFn: async () => { throw Error('unexpected fetch'); } });
  assert.equal((await production.evaluate('A victory!', config, moment, 'prediction')).moderation.verdict, 'unsure');
  production.close();
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
function obsMock({ authentication, image = PNG, handshake = true, respond = true, failure = false, onSend = () => {} } = {}) {
  const sockets = [], sent = [];
  const factory = (url, options) => {
    const socket = new EventEmitter();
    socket.closed = false;
    socket.close = () => { socket.closed = true; socket.emit('close'); };
    socket.send = (raw) => {
      const message = JSON.parse(raw);
      sent.push(message);
      onSend(message);
      if (message.op === 1) queueMicrotask(() => socket.emit('message', JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
      if (message.op === 6 && respond) queueMicrotask(() => socket.emit('message', JSON.stringify({ op: 7,
        d: { requestId: message.d.requestId, requestType: 'GetSourceScreenshot', requestStatus: { result: !failure, code: failure ? 600 : 100 }, responseData: { imageData: image } } })));
    };
    sockets.push({ socket, url, options });
    if (handshake) queueMicrotask(() => socket.emit('message', JSON.stringify({ op: 0, d: { rpcVersion: 1, ...(authentication ? { authentication } : {}) } })));
    return socket;
  };
  return { factory, sockets, sent };
}

test('optional OBS reader is lazy and unconfigured sources never connect', async () => {
  let calls = 0;
  const source = createOBSSource({ socketFactory: () => { calls++; throw Error('must not connect'); } });
  assert.equal(source.state().status, 'unconfigured');
  assert.equal(await source.readFrame(), null);
  assert.equal(calls, 0);
  source.close();
});

test('OBS reader restricts credential destinations to literal loopback and strips DNS dependence', async () => {
  for (const url of ['ws://example.com:4455', 'ws://127.0.0.1.example.com:4455', 'ws://user:password@127.0.0.1', 'ws://127.0.0.1/?token=secret', 'http://127.0.0.1:4455', 'ws://127.0.0.1/private']) {
    assert.throws(() => createOBSSource({ url, password: 'mock-secret', sourceName: 'Game' }), /loopback/);
  }
  const mock = obsMock();
  const source = createOBSSource({ url: 'ws://localhost:4455', sourceName: 'Game', socketFactory: mock.factory });
  assert.equal(await source.readFrame(), PNG);
  assert.equal(new URL(mock.sockets[0].url).hostname, '127.0.0.1');
  assert.equal(mock.sockets[0].options.followRedirects, false);
  assert.ok(mock.sockets[0].options.maxPayload < 3 * 1024 * 1024);
  source.close();
});

test('OBS v5 authentication and screenshot requests only use the configured single source', async () => {
  const mock = obsMock({ authentication: { salt: 'mock-salt', challenge: 'mock-challenge' } });
  const source = createOBSSource({ password: 'mock-secret', sourceName: 'Selected Game', socketFactory: mock.factory });
  assert.equal(await source.readFrame(), PNG);
  const hash = (value) => createHash('sha256').update(value).digest('base64');
  assert.equal(mock.sent[0].d.authentication, hash(hash('mock-secretmock-salt') + 'mock-challenge'));
  assert.equal(mock.sent[0].d.eventSubscriptions, 0);
  assert.equal(mock.sent[1].d.requestType, 'GetSourceScreenshot');
  assert.deepEqual(mock.sent[1].d.requestData, { sourceName: 'Selected Game', imageFormat: 'png', imageWidth: 960, imageHeight: 540 });
  assert.equal(source.state().connected, true);
  assert.ok(!JSON.stringify(source.state()).includes('mock-secret'));
  assert.ok(!JSON.stringify(source.state()).includes('Selected Game'));
  source.close();
  assert.equal(mock.sockets[0].socket.closed, true);
  assert.equal(source.state().connected, false);
});

test('OBS screenshots coalesce reads and never request faster than two seconds', async () => {
  let now = 0;
  const mock = obsMock();
  const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory, now: () => now });
  const first = source.readFrame();
  assert.equal(first, source.readFrame());
  assert.equal(await first, PNG);
  now = 1999;
  assert.equal(await source.readFrame(), PNG);
  assert.equal(source.state().requests, 1);
  now = 2000;
  assert.equal(await source.readFrame(), PNG);
  assert.equal(source.state().requests, 2);
  assert.equal(mock.sockets.length, 1);
  source.close();
});

test('OBS rejects malformed and oversized frames without exposing protocol error text', async () => {
  for (const image of ['https://private.invalid/frame.png', 'data:image/png;base64,AAAA', `data:image/png;base64,${'A'.repeat(2_900_000)}`]) {
    const mock = obsMock({ image });
    const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory });
    assert.equal(await source.readFrame(), null);
    assert.equal(source.state().status, 'unavailable');
    assert.equal(source.state().failures, 1);
    source.close();
  }
});

test('OBS screenshot and handshake deadlines release stalled mock sockets', async () => {
  for (const options of [{ handshake: false }, { respond: false }, { failure: true }]) {
    const mock = obsMock(options);
    const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory, timeoutMs: 15 });
    const started = performance.now();
    assert.equal(await source.readFrame(), null);
    assert.ok(performance.now() - started < 200);
    assert.equal(mock.sockets[0].socket.closed, true);
    assert.equal(source.state().in_flight, false);
    source.close();
  }
});

test('OBS close resolves a pending read and prevents reconnection', async () => {
  const mock = obsMock({ respond: false });
  const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory });
  const pending = source.readFrame();
  await sleep(0);
  source.close();
  assert.equal(await pending, null);
  assert.equal(await source.readFrame(), null);
  assert.equal(mock.sockets.length, 1);
  assert.equal(source.state().status, 'closed');
});

test('frame confirmation prompts expire, de-duplicate and require explicit consumption', async () => {
  let now = 0, value = 'death_screen';
  const watcher = new FrameWatcher({ judgements: { frame: async () => value }, now: () => now });
  await watcher.observe(PNG);
  assert.deepEqual(watcher.prompts(), []);
  await watcher.observe(PNG);
  const prompt = watcher.prompts()[0];
  assert.equal(prompt.moment_id, 'first-death');
  assert.equal(prompt.needs_confirmation, true);
  assert.equal(prompt.expires_at, 60000);
  await watcher.observe(PNG);
  assert.equal(watcher.prompts().length, 1);
  assert.deepEqual(watcher.confirm(prompt.id), { id: prompt.id, moment_id: 'first-death', label: 'Death screen' });
  assert.equal(watcher.confirm(prompt.id), null);
  await watcher.observe(PNG);
  assert.equal(watcher.prompts().length, 0);
  value = 'gameplay'; await watcher.observe(PNG);
  value = 'death_screen'; await watcher.observe(PNG); await watcher.observe(PNG);
  const second = watcher.prompts()[0];
  assert.ok(second && second.id !== prompt.id);
  now = 60000;
  assert.equal(watcher.confirm(second.id), null);
  assert.equal(watcher.prompts().length, 0);
  watcher.close();
});

test('frame watcher only proposes configured moment mappings and keeps a bounded queue', async () => {
  let value = 'death_screen';
  const disabled = new FrameWatcher({ judgements: { frame: async () => value }, momentMapping: {} });
  await disabled.observe(PNG); await disabled.observe(PNG);
  assert.deepEqual(disabled.prompts(), []);
  disabled.close();
  const watcher = new FrameWatcher({ judgements: { frame: async () => value }, momentMapping: { death_screen: 'custom-death', victory_screen: 'custom-victory', boss_defeated: 'custom-boss' } });
  for (let index = 0; index < 30; index++) {
    value = 'gameplay'; await watcher.observe(PNG);
    value = ['death_screen', 'victory_screen', 'boss_defeated'][index % 3];
    await watcher.observe(PNG); await watcher.observe(PNG);
  }
  assert.equal(watcher.prompts().length, 3);
  assert.ok(watcher.prompts().length <= 8);
  assert.equal(new Set(watcher.prompts().map((item) => item.kind)).size, 3);
  assert.ok(watcher.prompts().every((item) => item.moment_id.startsWith('custom-')));
  watcher.close();
  assert.deepEqual(watcher.prompts(), []);
});
