import test from 'node:test';
import assert from 'node:assert/strict';
import { Judgements, DemoJudgements, DECISIONS_URL, KSP_QUESTION_ORDER, KSP_MINIMUM_CONFIDENCE } from '../server/judgements.js';

// Only injected endpoint mocks and literal fake credentials are used. Never load .env.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
const SECOND_PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('second mocked image')]).toString('base64');
const frames = () => [{ dataUrl: PNG, at: 1000 }, { dataUrl: SECOND_PNG, at: 3000 }];
const unknown = () => ({ scene: 'unknown', continuity: 'unknown', events: { launch: 'unsure', explosion: 'unsure', landing: 'unsure', eva: 'unsure', flag: 'unsure', parachute: 'unsure' } });
const answer = (name, value, score = 0.95) => ({ type: 'choice', name: ['scene', 'continuity'].includes(name) ? name : `event:ksp-${name}`,
  choice: name === 'scene' && value === 'flight' ? 'gameplay' : value, confidence: score });
const allAnswers = () => [answer('scene', 'flight'), answer('continuity', 'same'), ...KSP_QUESTION_ORDER.slice(2).map((name) => answer(name, 'no'))];
const response = (answers) => ({ ok: true, json: async () => ({ answers }) });
const client = (fetchFn, options = {}) => new Judgements({ keyReader: () => 'mock-ksp-key', fetchFn, ...options });

test('KSP sends one named 8-question request with actual timestamped ordered image parts', async () => {
  let calls = 0;
  const model = client(async (url, options) => {
    calls++;
    assert.equal(url, DECISIONS_URL);
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.questions.map((item) => item.name), ['scene', 'continuity', ...KSP_QUESTION_ORDER.slice(2).map((name) => `event:ksp-${name}`)]);
    for (const item of body.questions) {
      assert.equal(item.type, 'choice');
      assert.equal(Object.hasOwn(item, 'id'), false);
      assert.ok(item.instructions.includes('untrusted data'));
      assert.ok(item.instructions.includes('unreadable small text'));
    }
    assert.deepEqual(body.questions[0].choices.map((item) => item.value), ['gameplay', 'map', 'editor', 'menu', 'unknown']);
    assert.deepEqual(body.questions[1].choices.map((item) => item.value), ['same', 'changed', 'unknown']);
    for (const item of body.questions.slice(2)) assert.deepEqual(item.choices.map((row) => row.value), ['yes', 'no', 'unsure']);
    const content = body.input[0].content;
    assert.equal(body.input[0].role, 'user');
    assert.equal(content[1].type, 'input_text');
    assert.match(content[1].text, /Frame 1; captured_at_ms=1000; relative_ms=0/);
    assert.deepEqual(content[2], { type: 'input_image', image_url: PNG });
    assert.match(content[3].text, /Frame 2; captured_at_ms=3000; relative_ms=2000/);
    assert.deepEqual(content[4], { type: 'input_image', image_url: SECOND_PNG });
    assert.equal(content.filter((item) => item.type === 'input_image').length, 2);
    const named = Object.fromEntries(body.questions.map((item) => [item.name, item.instructions]));
    assert.match(named.continuity, /menu\/load transition, actor or craft switch, abrupt camera jump/);
    const definitions = JSON.parse(content[0].text.split('UNTRUSTED_EVENT_DEFINITIONS=')[1]);
    const criteria = Object.fromEntries(definitions.map((item) => [item.id, item.description]));
    assert.match(criteria['ksp-launch'], /Clear separation from the ground and a powered ascent/);
    assert.match(criteria['ksp-landing'], /Stable surface contact is sufficient/);
    assert.match(criteria['ksp-explosion'], /Normal engine exhaust, planned staging/);
    assert.match(criteria['ksp-eva'], /Portraits, editor previews and menu text/);
    assert.match(criteria['ksp-flag'], /clear planted flag is sufficient/);
    assert.match(criteria['ksp-parachute'], /clearly open or opening parachute canopy/);
    for (const item of body.questions.slice(2)) {
      assert.match(item.instructions, /Select no when clear visible evidence establishes absence or the described negative baseline/);
      assert.match(item.instructions, /observable before\/after sequence/);
    }
    return response(allAnswers());
  });
  const result = await model.kspFrames(frames());
  assert.equal(calls, 1);
  assert.deepEqual(result, { scene: 'flight', continuity: 'same', events: { launch: 'no', explosion: 'no', landing: 'no', eva: 'no', flag: 'no', parachute: 'no' } });
  assert.ok(!JSON.stringify(result).includes('data:image'));
  assert.ok(!JSON.stringify(model.state()).includes('mock-ksp-key'));
  assert.ok(!JSON.stringify(model.state()).includes('data:image'));
  model.close();
});

test('KSP maps reordered named answers semantically and retains valid partial answers', async () => {
  const model = client(async () => response([
    answer('explosion', 'yes'), answer('eva', 'yes'), answer('scene', 'flight'), answer('continuity', 'same'), answer('launch', 'yes'),
  ]));
  const result = await model.kspFrames(frames());
  assert.deepEqual(result, { scene: 'flight', continuity: 'same', events: { launch: 'yes', explosion: 'yes', landing: 'unsure', eva: 'yes', flag: 'unsure', parachute: 'unsure' } });
  model.close();
});

test('KSP rejects each malformed refusal or low-confidence answer independently', async () => {
  const model = client(async () => response([
    answer('scene', 'flight'), answer('continuity', 'same'), answer('launch', 'yes'), answer('explosion', 'yes'),
    answer('landing', 'yes', 0.84), answer('eva', 'outside'), { ...answer('flag', 'yes'), refusal: '' }, { ...answer('parachute', 'yes'), type: 'predicate' },
  ]));
  const result = await model.kspFrames(frames());
  assert.equal(result.events.launch, 'yes');
  assert.equal(result.events.explosion, 'yes');
  for (const name of ['landing', 'eva', 'flag', 'parachute']) assert.equal(result.events[name], 'unsure');
  assert.equal(result.scene, 'flight');
  model.close();
});

test('KSP initial 0.85 threshold applies to no, yes, scene and continuity without claiming accuracy', async () => {
  assert.equal(KSP_MINIMUM_CONFIDENCE, 0.85);
  for (const bad of [0.84, -1, 1.01, NaN, undefined]) {
    const model = client(async () => response(allAnswers().map((row) => ({ ...row, confidence: bad }))));
    assert.deepEqual(await model.kspFrames(frames()), unknown());
    model.close();
  }
  const exact = client(async () => response(allAnswers().map((row) => ({ ...row, confidence: 0.85 }))));
  assert.equal((await exact.kspFrames(frames())).scene, 'flight');
  exact.close();
});

test('duplicate named answers invalidate only that question and never shift another event', async () => {
  const model = client(async () => response([...allAnswers(), answer('explosion', 'yes'), answer('invented', 'yes')]));
  const result = await model.kspFrames(frames());
  assert.equal(result.events.explosion, 'unsure');
  assert.equal(result.events.landing, 'no');
  assert.equal(result.events.parachute, 'no');
  model.close();
});

test('partial unnamed and mixed named/unnamed responses cannot shift event choices', async () => {
  for (const answers of [allAnswers().slice(0, 7).map(({ name, ...row }) => row), [...allAnswers(), answer('extra', 'yes')].map(({ name, ...row }) => row)]) {
    const model = client(async () => response(answers));
    assert.deepEqual(await model.kspFrames(frames()), unknown());
    model.close();
  }
  const mixed = client(async () => response([answer('scene', 'flight'), { type: 'choice', choice: 'yes', confidence: 1 }, answer('flag', 'yes')]));
  const result = await mixed.kspFrames(frames());
  assert.equal(result.scene, 'flight');
  assert.equal(result.events.flag, 'yes');
  assert.equal(result.events.explosion, 'unsure');
  assert.equal(result.events.eva, 'unsure');
  mixed.close();
});

test('complete unnamed responses use only documented question order', async () => {
  const answers = allAnswers().map(({ name, ...row }) => row);
  answers[5].choice = 'yes';
  const model = client(async () => response(answers));
  const result = await model.kspFrames(frames());
  assert.equal(result.events.eva, 'yes');
  assert.equal(result.events.flag, 'no');
  model.close();
});

test('single frame or unknown continuity cannot confirm temporal launch and landing', async () => {
  for (const continuity of ['same', 'changed', 'unknown']) {
    const answers = [answer('scene', 'flight'), answer('continuity', continuity), ...KSP_QUESTION_ORDER.slice(2).map((name) => answer(name, 'yes'))];
    const model = client(async () => response(answers));
    const single = await model.kspFrames(frames().slice(0, 1));
    assert.equal(single.continuity, 'unknown');
    assert.equal(single.events.launch, 'unsure');
    assert.equal(single.events.landing, 'unsure');
    assert.equal(single.events.explosion, 'yes');
    const sequence = await model.kspFrames(frames());
    assert.equal(sequence.events.launch, continuity === 'same' ? 'yes' : 'unsure');
    assert.equal(sequence.events.landing, continuity === 'same' ? 'yes' : 'unsure');
    model.close();
  }
});

test('KSP validates frame count timestamps temporal span and image encoding before any request', async () => {
  let calls = 0;
  const model = client(async () => { calls++; return response(allAnswers()); });
  const image = (dataUrl = PNG, at = 1000) => ({ dataUrl, at });
  for (const batch of [null, [], Array.from({ length: 6 }, (_, index) => image(PNG, index)), [null], [image(PNG, NaN)], [image(PNG, -1)],
    [image(PNG, 2000), image(PNG, 1000)], [image(), image()], [image(PNG, 1000), image(PNG, 9001)], [image('https://internal.invalid/frame.png')],
    [image('data:image/png;base64,AAAA')], [image('data:image/png;base64,AA=A')], [image('data:image/png;base64,' + 'A'.repeat(4_000_000))]]) {
    assert.deepEqual(await model.kspFrames(batch), unknown());
  }
  assert.equal(calls, 0);
  assert.equal((await model.kspFrames([image(PNG, 0), image(PNG, 8000)])).scene, 'flight');
  model.close();
});

test('KSP handles unavailable malformed refused and disabled providers without network fallthrough', async () => {
  for (const fetchFn of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ answers: 'not-an-array' }) }),
    async () => response(null), async () => response(KSP_QUESTION_ORDER.map((name) => ({ name, type: 'refusal', choice: 'yes', confidence: 1 }))),
    async () => { throw Error('private provider diagnostic'); }]) {
    const model = client(fetchFn);
    assert.deepEqual(await model.kspFrames(frames()), unknown());
    assert.ok(!JSON.stringify(model.state()).includes('private provider'));
    model.close();
  }
  let calls = 0;
  const disabled = client(async () => { calls++; return response(allAnswers()); }, { enabled: false });
  assert.deepEqual(await disabled.kspFrames(frames()), unknown());
  assert.equal(calls, 0);
  disabled.close();
  assert.deepEqual(await new DemoJudgements().kspFrames(frames()), unknown());
});

test('KSP inherits bounded shared concurrency and hard frame deadline even for hung mocks', async t => {
  // Admission and deadline expiry are independent of OS scheduling under a loaded full suite.
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const model = client(() => { calls++; return new Promise(() => {}); }, { deadlines: { frameMs: 25 } });
  const pending = Array.from({ length: 8 }, () => model.kspFrames(frames()));
  assert.equal(model.state().in_flight, 8);
  assert.deepEqual(await model.kspFrames(frames()), unknown());
  assert.equal(calls, 8);
  clock = 24;
  t.mock.timers.tick(24);
  assert.equal(model.state().in_flight, 8);
  clock = 25;
  t.mock.timers.tick(1);
  for (const result of await Promise.all(pending)) assert.deepEqual(result, unknown());
  assert.equal(model.state().in_flight, 0);
  assert.ok(model.state().deadlines.frameMs <= 2000);
  model.close();
});

test('generic frame classifier keeps its original single-question contract', async () => {
  const model = client(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.questions.length, 1);
    assert.equal(Object.hasOwn(body.questions[0], 'name'), false);
    return response([{ choice: 'gameplay', confidence: 0.95 }]);
  });
  assert.equal(await model.frame(PNG), 'gameplay');
  model.close();
});
