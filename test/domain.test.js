import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore, JsonStore } from '../server/store.js';
import { DEFAULT_CONFIG, validateConfig } from '../server/config.js';
import { LivePayments, PAYMENTS_LIVE } from '../server/payments.js';

const viewer = (id = 'one') => ({ opaqueId: `U${id}`, userId: id, displayName: `viewer_${id}` });
const input = (overrides = {}) => ({ body: 'You have got this!', category_id: 'encouragement', moment_id: 'margit', ...overrides });
const decisions = (overrides = {}) => ({
  evaluate: async (_body, _cfg, _moment, category) => ({ moderation: { verdict: 'safe', source: 'decisions', confidence: 0.99, latency_ms: 10 }, classification: { category_id: category, confidence: 0.99, latency_ms: 10 }, fit: 'fits' }),
  choose: async candidates => [candidates.at(-1).id], predict: async () => 'came_true', ...overrides,
});
function setup(overrides = {}) {
  let time = 100000;
  const engine = new NotesEngine({ store: new MemoryStore(), decisions: decisions(), now: () => time, ...overrides });
  return { engine, advance: ms => { time += ms; }, get time() { return time; } };
}
async function paid(engine, identity = viewer(), overrides = {}) { return engine.submit(identity, input({ payment_mode: 'sim_points', ...overrides })); }
const throwsCode = (operation, code) => assert.rejects(operation, error => error.code === code && error.status >= 400);

test('default prices are simulated and free allowance consumes only a successfully sealed note', async () => {
  const { engine } = setup();
  const user = viewer();
  for (let i = 0; i < 3; i++) assert.equal((await engine.quote(user, input())).mode, 'free');
  assert.deepEqual(engine.viewerState(user).wallet, { points: 10000, bits: 1000 });
  const free = await engine.submit(user, input());
  assert.equal(free.payment.mode, 'free');
  assert.equal(engine.viewerState(user).free_remaining, 0);
  assert.equal((await engine.quote(user, input())).mode, 'sim_points');
  assert.match(free.label, /TEST MODE/);
  assert.equal(PAYMENTS_LIVE, false);
});

test('moderation and classification occur before charge; rejected and mismatched notes never charge', async () => {
  let engine;
  const calls = [];
  const mock = decisions({ evaluate: async () => {
    calls.push(engine.viewerState(viewer()).wallet.points);
    return { moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id: 'advice' }, fit: 'mismatched' };
  } });
  ({ engine } = setup({ decisions: mock }));
  await throwsCode(() => paid(engine), 'moment_mismatch');
  assert.deepEqual(calls, [10000]);
  assert.equal(engine.viewerState(viewer()).wallet.points, 10000);
  mock.evaluate = async () => ({ moderation: { verdict: 'violates', source: 'decisions' }, classification: { category_id: 'joke' }, fit: 'fits' });
  const rejected = await paid(engine);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.payment, null);
  assert.equal(engine.viewerState(viewer()).wallet.points, 10000);
  await throwsCode(() => engine.review(rejected.id, true), 'moderation_floor');
});

test('fixed local filters reject URLs, private data, custom words, and unsafe display names', async () => {
  let calls = 0;
  const { engine } = setup({ decisions: decisions({ evaluate: async () => { calls++; throw new Error('must not call'); } }) });
  await engine.updateConfig({ moderation: { custom_words: ['blockedword'] } });
  for (const body of ['visit https://example.com', 'private@example.com', 'blockedword']) {
    const note = await paid(engine, viewer(body.length.toString()), { body }); assert.equal(note.status, 'rejected');
  }
  assert.equal(calls, 0);
  const safe = setup().engine;
  const note = await safe.submit({ opaqueId: 'Anonymous', displayName: 'pretend_name' }, input());
  await safe.occur('margit');
  assert.equal(safe.archive()[0].display_name, null);
  assert.equal(note.status, 'sealed');
});

test('all-human and unsure modes hold without charging; review revalidates balance and charges once', async () => {
  const { engine } = setup(); const user = viewer();
  await engine.updateConfig({ moderation: { mode: 'all_human' }, payments: { points_price: 10000 } });
  const first = await paid(engine, user); const second = await paid(engine, user);
  assert.equal(first.status, 'held'); assert.equal(second.payment, null);
  assert.equal(engine.viewerState(user).wallet.points, 10000);
  assert.equal(engine.operatorState().held[0].body, input().body);
  assert.equal('body' in engine.operatorState().notes[0], false);
  await engine.review(first.id, true);
  assert.equal(engine.viewerState(user).wallet.points, 0);
  await throwsCode(() => engine.review(second.id, true), 'insufficient_balance');
  assert.equal(engine.operatorState().held.length, 1);
  await engine.review(first.id, true);
  assert.equal(engine.viewerState(user).wallet.points, 0);
});

test('unsure rejects only with configured policy; unavailable Decisions always holds', async () => {
  const unsure = decisions({ evaluate: async () => ({ moderation: { verdict: 'unsure', source: 'decisions' }, classification: { category_id: null }, fit: 'unsure' }) });
  const { engine } = setup({ decisions: unsure });
  assert.equal((await paid(engine)).status, 'held');
  await engine.updateConfig({ moderation: { unsure: 'reject' } });
  assert.equal((await paid(engine)).status, 'rejected');
  const unavailable = setup({ decisions: undefined }).engine;
  await unavailable.updateConfig({ moderation: { unsure: 'reject' } });
  assert.equal((await paid(unavailable)).status, 'held');
  assert.equal(unavailable.viewerState(viewer()).wallet.points, 10000);
});

test('category modes remain independent of moderation and unclear classification never rejects', async () => {
  const mock = decisions({ evaluate: async () => ({ moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id: 'joke' }, fit: 'fits' }) });
  const { engine } = setup({ decisions: mock });
  await engine.updateConfig({ category_mode: 'viewer' });
  assert.equal((await paid(engine)).category_id, 'encouragement');
  await engine.updateConfig({ category_mode: 'ai' });
  assert.equal((await paid(engine)).category_id, 'joke');
  await engine.updateConfig({ category_mode: 'viewer_check', category_mismatch: 'hold' });
  assert.equal((await paid(engine)).status, 'held');
  await engine.updateConfig({ category_mismatch: 'ai' });
  assert.equal((await paid(engine)).category_id, 'joke');
  mock.evaluate = async () => ({ moderation: { verdict: 'safe', source: 'decisions' }, classification: { category_id: 'unsure' }, fit: 'unsure' });
  assert.equal((await paid(engine)).status, 'sealed');
});

test('viewer note limit includes held notes; anonymity option requires identity share', async () => {
  const { engine } = setup();
  await engine.updateConfig({ moderation: { mode: 'all_human', max_notes_per_viewer: 1, allow_anonymous: false } });
  await throwsCode(() => engine.submit({ opaqueId: 'A1' }, input()), 'identity_required');
  await paid(engine);
  await throwsCode(() => paid(engine), 'viewer_limit');
});

test('paid guarantees exceed selection cap; one canonical reveal at a time, skip and tick advance', async () => {
  const { engine, advance } = setup();
  await engine.updateConfig({ reveal: { max_per_moment: 1 } });
  const notes = await Promise.all([paid(engine, viewer('1')), paid(engine, viewer('2')), paid(engine, viewer('3'))]);
  await engine.submit(viewer('free'), input());
  const result = await engine.occur('margit', 'context', 'streamer');
  assert.equal(result.selected.length, 3);
  assert.equal(engine.archive().length, 1);
  assert.equal(engine.overlayState().queue.length, 2);
  assert.equal('body' in engine.overlayState().queue[0], false);
  assert.equal(engine.overlayState().current.id, notes[0].id);
  advance(7999); await engine.tick(); assert.equal(engine.archive().length, 1);
  advance(1); await engine.tick(); assert.equal(engine.archive().length, 2);
  await engine.skip(); assert.equal(engine.archive().length, 3);
  assert.equal(engine.viewerState(viewer('free')).notes[0].status, 'sealed');
});

test('Decisions chooses among free candidates without accepting foreign ids', async () => {
  const { engine } = setup({ decisions: decisions({ choose: async () => ['foreign'] }) });
  await engine.updateConfig({ reveal: { max_per_moment: 1 } });
  const notes = await Promise.all(['a','b','c'].map(id => engine.submit(viewer(id), input())));
  await engine.occur('margit');
  assert.equal(engine.archive().length, 1);
  assert.equal(engine.archive()[0].id, notes[0].id);
});

test('prediction verdict and explicit operator override project only opened predictions', async () => {
  const { engine } = setup();
  const note = await paid(engine, viewer(), { category_id: 'prediction' });
  await engine.occur('margit', 'A prediction came true.');
  assert.equal(engine.overlayState().current.prediction_verdict, 'came_true');
  await engine.overrideVerdict(note.id, 'missed');
  assert.equal(engine.archive()[0].prediction_verdict, 'missed');
  assert.equal(engine.archive()[0].prediction_override, true);
});

test('reject refunds are idempotent and can be disabled', async () => {
  const { engine } = setup();
  const note = await paid(engine);
  assert.equal(engine.viewerState(viewer()).wallet.points, 9800);
  await engine.review(note.id, false);
  assert.equal(engine.viewerState(viewer()).wallet.points, 10000);
  await throwsCode(() => engine.review(note.id, false), 'invalid_status');
  await engine.updateConfig({ payments: { refund_on_reject: false } });
  const next = await paid(engine); await engine.review(next.id, false);
  assert.equal(engine.viewerState(viewer()).wallet.points, 9800);
});

test('count, window, after, built-in first-death and event ids enforce conditions', async () => {
  const { engine, advance } = setup();
  const count = await paid(engine, viewer('count'), { condition: { type: 'count', count: 3 } });
  for (let i = 1; i <= 2; i++) { await engine.occur('margit', { event_id: String(i) }); assert.equal(engine.archive().length, 0); }
  assert.equal((await engine.occur('margit', { event_id: '2' })).duplicate, true);
  await engine.occur('margit', { event_id: '3' }); assert.equal(engine.archive()[0].id, count.id);
  await engine.skip();
  const after = await paid(engine, viewer('after'), { condition: { type: 'after', after_moment_id: 'key' } });
  await engine.occur('margit'); assert.equal(engine.archive().length, 1);
  await engine.occur('key'); await engine.occur('margit'); assert.equal(engine.archive().at(-1).id, after.id);
  await engine.skip();
  const window = await paid(engine, viewer('window'), { condition: { type: 'window', before_minutes: 1 } });
  advance(60000); await engine.tick();
  assert.equal(engine.viewerState(viewer('window')).notes[0].status, 'expired');
  assert.equal(engine.viewerState(viewer('window')).wallet.points, 10000);
  assert.equal(engine.archive().some(note => note.id === window.id), false);
  await engine.occur('first-death'); assert.equal((await engine.occur('first-death')).duplicate, true);
});

test('AI moments require human confirmation; warm-up cannot trigger events', async () => {
  const { engine } = setup();
  await engine.updateConfig({ moments: [...engine.config.moments, { id: 'victory', label: 'Victory detected', kind: 'ai', long_lived: false }] });
  await throwsCode(() => engine.occur('victory', {}, 'twitch'), 'confirmation_required');
  await throwsCode(() => engine.occur('margit', { warmup: true }, 'twitch'), 'warmup_event');
  await paid(engine, viewer(), { moment_id: 'victory' });
  await engine.occur('victory', {}, 'moderator');
  assert.equal(engine.archive()[0].reliability, 'AI-detected · confirmed by mod');
});

test('wrap opens end notes, returns max-three never reel, refunds and keeps actual revealed status', async () => {
  const { engine } = setup();
  const end = await paid(engine, viewer('end'), { moment_id: 'end' });
  const never = await paid(engine, viewer('never'), { moment_id: 'never' });
  await paid(engine, viewer('other'));
  const wrapped = await engine.wrap();
  assert.equal(wrapped.reel.count, 2);
  assert.equal(engine.archive()[0].id, end.id);
  assert.equal((await engine.wrap()).duplicate, true);
  await engine.skip();
  const note = engine.archive().find(note => note.id === never.id);
  assert.equal(note.status, 'revealed'); assert.ok(note.payment.refunded_at);
  assert.equal(engine.viewerState(viewer('never')).wallet.points, 10000);
  await throwsCode(() => paid(engine), 'session_wrapped');
});

test('never reel excludes unselected notes whose moment actually happened', async () => {
  const { engine } = setup();
  await engine.updateConfig({ reveal: { max_per_moment: 1 } });
  await Promise.all(['1','2'].map(id => engine.submit(viewer(id), input())));
  await engine.occur('margit'); await engine.skip();
  const result = await engine.wrap();
  assert.equal(result.reel.count, 0);
  assert.equal(engine.operatorState().notes.filter(note => note.status === 'expired').length, 1);
});

test('long-lived notes carry over and simulated wallets reset per session', async () => {
  const { engine } = setup();
  const note = await paid(engine, viewer(), { moment_id: 'finish' });
  await engine.wrap(); assert.equal(engine.viewerState(viewer()).notes[0].status, 'sealed');
  await engine.newSession();
  assert.equal(engine.viewerState(viewer()).wallet.points, 10000);
  await engine.occur('finish');
  assert.equal(engine.archive()[0].id, note.id);
});

test('idempotent concurrent submission charges once; conflicting request ids fail', async () => {
  const { engine } = setup();
  const data = input({ request_id: 'retry-1', payment_mode: 'sim_points' });
  const receipts = await Promise.all(Array.from({ length: 10 }, () => engine.submit(viewer(), data)));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
  assert.equal(engine.viewerState(viewer()).wallet.points, 9800);
  await throwsCode(() => engine.submit(viewer(), { ...data, body: 'A different note' }), 'idempotency_conflict');
});

test('JSON store persists bodies privately at 0600; all pre-reveal client projections redact them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-notes-'));
  try {
    const file = path.join(dir, 'notes.json');
    const secret = 'A very private encouragement';
    const engine = new NotesEngine({ store: new JsonStore({ file }), decisions: decisions() });
    const note = await paid(engine, viewer(), { body: secret, request_id: 'persistent' });
    for (const projection of [engine.viewerState(viewer()), engine.viewerState(viewer('other')), engine.overlayState(), engine.operatorState(), engine.archive(), engine.events(viewer())]) assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restored = new NotesEngine({ store: new JsonStore({ file }), decisions: decisions() });
    assert.equal((await restored.submit(viewer(), input({ body: secret, request_id: 'persistent', payment_mode: 'sim_points' }))).id, note.id);
    assert.equal(restored.viewerState(viewer()).wallet.points, 9800);
    await restored.occur('margit');
    assert.equal(restored.archive()[0].body, secret);
    assert.equal('author_opaque_id' in restored.archive()[0], false);
    assert.equal('author_user_id' in restored.archive()[0], false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Bits tiers, gold guarantee, identity-linked viewer limits and category prices are validated', async () => {
  const { engine } = setup();
  await throwsCode(() => paid(engine, viewer(), { payment_mode: 'sim_bits', bits_tier: 75 }), 'invalid_bits_tier');
  const note = await paid(engine, viewer(), { payment_mode: 'sim_bits', bits_tier: 500 });
  assert.equal(note.payment.amount, 500); assert.equal(note.guaranteed, true);
  assert.equal(engine.viewerState(viewer()).wallet.bits, 500);
  await engine.updateConfig({ moderation: { max_notes_per_viewer: 1 } });
  await throwsCode(() => paid(engine, { ...viewer(), opaqueId: 'Udifferent' }), 'viewer_limit');
  const categories = engine.config.categories.map(category => category.id === 'advice' ? { ...category, price: 300 } : category);
  await engine.updateConfig({ categories });
  assert.equal((await engine.quote(viewer('new'), input({ category_id: 'advice', payment_mode: 'sim_points' }))).amount, 300);
  assert.throws(() => validateConfig({ categories: DEFAULT_CONFIG.categories.slice(0, 2) }), /3–6/);
});

function token(secret, payload, alg = 'HS256') {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(`${header}.${body}`).digest('base64url')}`;
}

test('real payments stay disabled unless explicitly enabled; mocked reward and redemption lifecycle is identity-linked', async () => {
  const calls = [];
  const helix = { ensureReward: async price => { calls.push(['ensureReward', price]); return { data: [{ id: 'reward' }] }; }, updateRedemption: async (...args) => calls.push(['updateRedemption', ...args]) };
  const disabled = new LivePayments({ helix });
  await throwsCode(() => disabled.ensureReward(), 'payments_disabled'); assert.equal(calls.length, 0);
  const real = new LivePayments({ live: true, helix, channelId: 'channel' });
  const reward = await real.ensureReward(200); await real.ensureReward(300);
  assert.equal(reward.title, 'Seal a note'); assert.equal(reward.is_user_input_required, false);
  const event = { id: 'redemption', user_id: 'one', broadcaster_user_id: 'channel', reward: { id: 'reward' }, status: 'unfulfilled' };
  assert.equal(real.grantCredit(event).duplicate, false);
  assert.equal(real.grantCredit(event).duplicate, true);
  assert.throws(() => real.credit('other'), { code: 'credit_required' });
  assert.equal(real.credit('one'), 'redemption');
  await throwsCode(() => real.fulfill('other', 'redemption'), 'invalid_redemption');
  await real.fulfill('one', 'redemption'); await real.fulfill('one', 'redemption');
  real.grantCredit({ ...event, id: 'refund' }); await real.cancel('one', 'refund');
  assert.deepEqual(calls, [['ensureReward',200],['ensureReward',300],['updateRedemption','redemption','FULFILLED','reward'],['updateRedemption','refund','CANCELED','reward']]);
});

test('real Bits verifies signature, expiration, product, user, channel and transaction replay with mocked receipts', () => {
  const secret = Buffer.from('a-long-extension-secret-for-tests').toString('base64');
  const now = 100000;
  const real = new LivePayments({ live: true, extensionSecret: secret, channelId: 'channel', now: () => now });
  const receipt = { exp: 200, data: { transactionId: 'transaction-1', userId: 'one', channelId: 'channel', product: { sku: 'seal-100', cost: { amount: 100, type: 'bits' } } } };
  const expected = { userId: 'one', productId: 'seal-100', amount: 100 };
  const signed = token(secret, receipt);
  assert.throws(() => real.verifyBits(token(Buffer.from('wrong').toString('base64'), receipt), expected), { code: 'invalid_receipt' });
  assert.throws(() => real.verifyBits(token(secret, { ...receipt, exp: 100 }), expected), { code: 'expired_receipt' });
  for (const mutation of [{ userId: 'other' }, { productId: 'seal-500' }, { amount: 500 }]) assert.throws(() => real.verifyBits(signed, { ...expected, ...mutation }), { code: 'receipt_mismatch' });
  assert.throws(() => real.verifyBits(token(secret, { ...receipt, data: { ...receipt.data, channelId: 'wrong' } }), expected), { code: 'receipt_mismatch' });
  assert.equal(real.verifyBits(signed, expected).txn_id, 'transaction-1');
  assert.throws(() => real.verifyBits(signed, expected), { code: 'receipt_replayed' });
});

test('real anonymous identities permit null user ids and never project supplied names', async () => {
  const { engine } = setup();
  const identity = { opaqueId: 'AnonViewer', userId: null, displayName: 'pretend_name' };
  await engine.submit(identity, input());
  await engine.occur('margit');
  assert.equal(engine.archive()[0].display_name, null);
});

test('a slow prediction cannot expose the body before the canonical reveal is ready', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let entered;
  const enteredPrediction = new Promise(resolve => { entered = resolve; });
  const { engine } = setup({ decisions: decisions({ predict: async () => { entered(); await pending; return 'came_true'; } }) });
  const secret = 'My secret prediction';
  await paid(engine, viewer(), { body: secret, category_id: 'prediction' });
  const occurring = engine.occur('margit');
  await enteredPrediction;
  assert.equal(engine.archive().length, 0);
  assert.equal(engine.overlayState().current, null);
  assert.equal(JSON.stringify(engine.viewerState(viewer())).includes(secret), false);
  assert.equal(JSON.stringify(engine.operatorState()).includes(secret), false);
  finish(); await occurring;
  assert.equal(engine.overlayState().current.body, secret);
});

test('held long-lived notes charge and refund the same current-session wallet', async () => {
  const { engine } = setup();
  await engine.updateConfig({ moderation: { mode: 'all_human' } });
  const note = await paid(engine, viewer(), { moment_id: 'finish' });
  await engine.newSession();
  await engine.review(note.id, true);
  assert.equal(engine.viewerState(viewer()).wallet.points, 9800);
  await engine.review(note.id, false);
  assert.equal(engine.viewerState(viewer()).wallet.points, 10000);
  assert.equal(Object.values(engine.store.read().wallets).flatMap(Object.values).some(wallet => wallet.points > 10000), false);
});

test('configuration cannot remove an after-condition dependency or reserve an unsure category', async () => {
  const { engine } = setup();
  await paid(engine, viewer(), { condition: { type: 'after', after_moment_id: 'key' } });
  await throwsCode(() => engine.updateConfig({ moments: engine.config.moments.filter(moment => moment.id !== 'key') }), 'moment_in_use');
  const categories = engine.config.categories.map((category, i) => i === 0 ? { ...category, id: 'unsure' } : category);
  await throwsCode(() => engine.updateConfig({ categories }), 'invalid_config');
});

test('JSON store rejects symbolic-link targets without changing the destination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-symlink-'));
  try {
    const target = path.join(dir, 'target'); const link = path.join(dir, 'link');
    fs.writeFileSync(target, '{}', { mode: 0o644 }); fs.symlinkSync(target, link);
    assert.throws(() => new JsonStore({ file: link }), /symbolic link/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('engine admits at most 32 pending mutations while Decisions is slow', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { engine } = setup({ decisions: decisions({ evaluate: async (...args) => { await gate; return decisions().evaluate(...args); } }) });
  const accepted = Array.from({ length: 32 }, (_, i) => paid(engine, viewer(`queued${i}`)));
  await throwsCode(() => paid(engine, viewer('overflow')), 'engine_busy');
  release(); await Promise.all(accepted);
  assert.equal(engine.operatorState().notes.length, 32);
});

test('all-human queues unsure judgements even when automatic unsure policy rejects', async () => {
  const { engine } = setup({ decisions: decisions({ evaluate: async () => ({ moderation: { verdict: 'unsure', source: 'decisions' }, classification: { category_id: null }, fit: 'unsure' }) }) });
  await engine.updateConfig({ moderation: { mode: 'all_human', unsure: 'reject' } });
  assert.equal((await paid(engine)).status, 'held');
});

test('long-lived window deadlines do not reset when a new stream starts', async () => {
  const { engine, advance } = setup();
  await paid(engine, viewer(), { moment_id: 'finish', condition: { type: 'window', before_minutes: 1 } });
  await engine.wrap(); await engine.newSession();
  advance(60000); await engine.tick();
  assert.equal(engine.viewerState(viewer()).notes[0].status, 'expired');
  assert.equal(engine.archive().length, 0);
});

test('the 140-character body limit counts Unicode characters and checks normalized expansion', async () => {
  const { engine } = setup();
  const emoji = '🌟'.repeat(140);
  assert.equal((await paid(engine, viewer(), { body: emoji })).status, 'sealed');
  await throwsCode(() => paid(engine, viewer(), { body: '🌟'.repeat(141) }), 'invalid_body');
  await throwsCode(() => paid(engine, viewer(), { body: 'ﬃ'.repeat(140) }), 'invalid_body');
});

test('optional Twitch signal settings and timer triggers are bounded and survive configuration edits', async () => {
  const { engine } = setup();
  assert.equal(engine.config.signals.clip_poll_enabled, false);
  assert.equal(engine.config.signals.chat_spike.enabled, false);
  const timer = engine.config.moments.find(moment => moment.id === 'stream-15');
  assert.deepEqual(timer.trigger, { type: 'stream_minutes', minutes: 15 });
  await engine.updateConfig({ signals: { clip_poll_enabled: true, chat_spike: { enabled: true, min_messages: 30 } } });
  assert.equal(engine.config.signals.chat_spike.window_seconds, 10);
  assert.equal(engine.config.signals.chat_spike.min_messages, 30);
  await engine.updateConfig({ moments: engine.config.moments });
  assert.deepEqual(engine.config.moments.find(moment => moment.id === timer.id).trigger, timer.trigger);
  for (const signals of [{ clip_poll_enabled: 'yes' }, { chat_spike: { min_viewers: 1 } }, { chat_spike: { cooldown_seconds: 0 } }, { chat_spike: { arbitrary_command: 'x' } }]) await throwsCode(() => engine.updateConfig({ signals }), 'invalid_config');
  for (const trigger of [{ type: 'stream_minutes', minutes: 0 }, { type: 'stream_minutes', minutes: Infinity }, { type: 'stream_minutes', minutes: 1441 }, { type: 'execute', command: 'anything' }, { type: 'stream_minutes', minutes: 1, command: 'anything' }]) {
    await throwsCode(() => engine.updateConfig({ moments: engine.config.moments.map(moment => moment.id === timer.id ? { ...moment, trigger } : moment) }), 'invalid_config');
  }
  await throwsCode(() => engine.updateConfig({ moments: engine.config.moments.map(moment => moment.id === timer.id ? { ...moment, kind: 'declared' } : moment) }), 'invalid_config');
});

test('identity sharing merges prior anonymous free usage, spending, refunds, receipts and private events', async () => {
  const { engine } = setup();
  const anonA = { opaqueId: 'AnonA', userId: null, displayName: 'unshared_name' };
  const anonB = { opaqueId: 'AnonB', userId: null };
  const first = await engine.submit(anonA, input({ request_id: 'first-free' }));
  await paid(engine, anonA);
  await engine.submit(anonB, input());
  const secondPaid = await paid(engine, anonB);
  const linkedA = { ...anonA, userId: 'same-user' };
  const linkedB = { ...anonB, userId: 'same-user' };
  await engine.quote(linkedA, input({ payment_mode: 'sim_points' }));
  // A read-only projection already combines both known identities before the next write.
  assert.equal(engine.viewerState(linkedB).free_remaining, 0);
  assert.equal(engine.viewerState(linkedB).wallet.points, 9600);
  await engine.quote(linkedB, input({ payment_mode: 'sim_points' }));
  assert.equal(engine.viewerState(linkedB).notes.length, 4);
  assert.equal(engine.viewerState(linkedA).wallet.points, 9600);
  assert.equal(engine.events(linkedA).length, 4);
  await throwsCode(() => engine.submit(linkedB, input({ payment_mode: 'free' })), 'free_allowance_used');
  assert.equal((await engine.submit(linkedB, input({ request_id: 'first-free' }))).id, first.id);
  await engine.review(secondPaid.id, false);
  assert.equal(engine.viewerState(linkedA).wallet.points, 9800);
  await engine.occur('margit');
  assert.equal(engine.archive().every(note => note.display_name === null), true);
});

test('a sealed category snapshot retains the original color, subtitle and name after edits or removal', async () => {
  const { engine } = setup();
  const original = structuredClone(engine.config.categories.find(category => category.id === 'encouragement'));
  await paid(engine);
  await engine.updateConfig({ categories: engine.config.categories.map(category => category.id === original.id ? { ...category, name: 'Support', subtitle: 'Keep going', envelope_color: '#9dcfff' } : category) });
  await engine.occur('margit');
  assert.deepEqual(engine.archive()[0].category, original);
  await engine.updateConfig({ categories: engine.config.categories.filter(category => category.id !== original.id) });
  assert.deepEqual(engine.overlayState().current.category, original);
});

test('a persisted configuration keeps its version and upgrades missing optional signal defaults', async () => {
  const { engine } = setup();
  await engine.updateConfig({ payments: { points_price: 300 } });
  const version = engine.config.version;
  const snapshot = engine.store.read();
  delete snapshot.config.signals;
  const restored = new NotesEngine({ store: new MemoryStore(snapshot), decisions: decisions() });
  assert.equal(restored.config.version, version);
  assert.equal(restored.config.payments.points_price, 300);
  assert.equal(restored.config.signals.chat_spike.enabled, false);
});

test('real payment replay and redemption state can persist separately across adapter restarts', async () => {
  const secret = Buffer.from('a-long-extension-secret-for-tests').toString('base64');
  const store = new MemoryStore();
  const helix = { ensureReward: async () => ({ data: [{ id: 'reward' }] }), updateRedemption: async () => {} };
  const args = { live: true, store, helix, channelId: 'channel', extensionSecret: secret, now: () => 100000 };
  const first = new LivePayments(args);
  await first.ensureReward();
  first.grantCredit({ id: 'credit', user_id: 'one', broadcaster_user_id: 'channel', reward: { id: 'reward' } });
  const receipt = token(secret, { exp: 200, data: { transactionId: 'persisted-transaction', userId: 'one', channelId: 'channel', product: { sku: 'seal-100', cost: { amount: 100, type: 'bits' } } } });
  const expected = { userId: 'one', productId: 'seal-100', amount: 100 };
  first.verifyBits(receipt, expected);
  const restored = new LivePayments(args);
  assert.equal(restored.credit('one'), 'credit');
  assert.throws(() => restored.verifyBits(receipt, expected), { code: 'receipt_replayed' });
  await restored.cancel('one', 'credit');
  assert.equal(new LivePayments(args).state.redemptions.credit.status, 'canceled');
});

test('concurrent real redemption finalization sends one update and rejects conflicting transitions', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const helix = { ensureReward: async () => ({ id: 'reward' }), updateRedemption: async () => { calls++; await gate; } };
  const real = new LivePayments({ live: true, helix, channelId: 'channel' });
  await real.ensureReward();
  real.grantCredit({ id: 'redemption', user_id: 'one', broadcaster_user_id: 'channel', reward: { id: 'reward' } });
  const first = real.fulfill('one', 'redemption'); const duplicate = real.fulfill('one', 'redemption');
  const conflicting = throwsCode(() => real.cancel('one', 'redemption'), 'redemption_final');
  release(); await Promise.all([first, duplicate, conflicting]);
  assert.equal(calls, 1);
});

test('optional compiled conditions accept only bounded canonical data and never executable fields', async () => {
  const { validateCompiledCondition } = await import('../server/conditions.js');
  assert.deepEqual(validateCompiledCondition({ type: 'count', count: 3 }, DEFAULT_CONFIG.moments), { type: 'count', count: 3 });
  assert.deepEqual(validateCompiledCondition({ type: 'window', before_minutes: 15 }, DEFAULT_CONFIG.moments), { type: 'window', before_minutes: 15 });
  assert.deepEqual(validateCompiledCondition({ type: 'after', after_moment_id: 'key' }, DEFAULT_CONFIG.moments), { type: 'after', after_moment_id: 'key' });
  for (const value of [{ type: 'moment' }, { type: 'count', count: 3, code: 'anything' }, { type: 'count', n: 3 }, { type: 'window', before_minutes: 0 }, { type: 'after', after_moment_id: 'unknown' }]) assert.throws(() => validateCompiledCondition(value, DEFAULT_CONFIG.moments), { code: 'invalid_condition' });
});

test('malformed signed Bits payloads and prototype condition types return bounded validation errors', async () => {
  const { validateCompiledCondition } = await import('../server/conditions.js');
  for (const type of ['toString', '__proto__', {}, null]) assert.throws(() => validateCompiledCondition({ type }, DEFAULT_CONFIG.moments), { code: 'invalid_condition' });
  const secret = Buffer.from('a-long-extension-secret-for-tests').toString('base64');
  const real = new LivePayments({ live: true, extensionSecret: secret, channelId: 'channel', now: () => 100000 });
  for (const payload of [null, [], 'text']) assert.throws(() => real.verifyBits(token(secret, payload), { userId: 'one', productId: 'seal-100', amount: 100 }), { code: 'invalid_receipt' });
});

test('author credit requires explicit per-note name consent and a safe linked name', async () => {
  const { engine } = setup();
  const anonymous = await paid(engine, viewer('private'));
  const named = await paid(engine, viewer('named'), { show_name: true });
  const unsafe = await paid(engine, { opaqueId: 'UnsafeName', userId: 'unsafe', displayName: 'private@example.com' }, { show_name: true });
  await engine.occur('margit'); await engine.skip(); await engine.skip();
  const notes = new Map(engine.archive().map(note => [note.id, note]));
  assert.equal(notes.get(anonymous.id).display_name, null);
  assert.equal(notes.get(named.id).display_name, 'viewer_named');
  assert.equal(notes.get(unsafe.id).display_name, null);
});
