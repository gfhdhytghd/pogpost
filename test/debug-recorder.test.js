import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DebugRecorder } from '../server/debug-recorder.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
const frame = (id = '1', at = 1000) => ({ id, at, dataUrl: PNG });
const definition = { id: 'launch', label: 'Launch', description: 'A vehicle visibly leaves the pad.', mode: 'instant', min_confidence: 0.85 };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-debug-'));
  const directory = path.join(root, 'debug');
  const recorder = await DebugRecorder.open({ directory, now: () => 123456, ...options });
  t.after(async () => { await recorder.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, recorder };
}

test('debug starts off without creating files and explicit capture choice survives restart', async t => {
  const { directory, recorder } = await fixture(t);
  assert.equal(recorder.enabled, false);
  assert.equal(recorder.recordFrame(frame()), null);
  assert.equal(recorder.beginRequest({ stage: 'screen', frames: [frame()] }), null);
  assert.equal(recorder.recordDecision({ kind: 'reset' }), null);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await recorder.setEnabled(true);
  const id = recorder.recordFrame(frame());
  await recorder.flush();
  const restored = await DebugRecorder.open({ directory });
  t.after(() => restored.close());
  assert.equal(restored.enabled, true);
  assert.equal(restored.query().frames[0].id, id);
  assert.ok(await restored.image(id));
  await restored.setEnabled(false);
  const off = await DebugRecorder.open({ directory });
  t.after(() => off.close());
  assert.equal(off.enabled, false);
  assert.equal(off.query().frames.length, 1, 'disabling collection keeps review history');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'frames'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'index.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(directory, 'frames', id + '.png'))).mode & 0o777, 0o600);
});

test('captured images link exactly to one-image screening and five-image review with bounded model outputs', async t => {
  const { recorder } = await fixture(t);
  await recorder.setEnabled(true);
  const observations = Array.from({ length: 5 }, (_, i) => frame(String(i + 1), 1000 + i * 200));
  const ids = observations.map(observation => recorder.recordFrame(observation));
  const screen = recorder.beginRequest({ stage: 'screen', frames: [observations[4]], definitions: [definition] });
  const review = recorder.beginRequest({ stage: 'review', frames: observations, definitions: [definition] });
  const secret = 'NEVER_KEEP_THIS_SECRET';
  recorder.finishRequest(screen, { outcome: 'ok', latency_ms: 321, model: 'gpt-6-luna',
    raw: { answers: [{ name: 'scene', type: 'choice', choice: 'gameplay', confidence: 0.99, provider_detail: secret },
      { name: 'event:launch', type: 'choice', choice: 'yes', confidence: 0.7, refusal: secret },
      { name: secret, type: 'choice', choice: secret, confidence: 0.8 }] },
    usage: { input_tokens: 4000, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000, secret } },
    error: secret, request_body: secret });
  recorder.finishRequest(screen, { normalized: { valid: true, scene: 'gameplay', events: { launch: { choice: 'yes', confidence: 0.7 } }, secret } });
  recorder.finishRequest(review, { outcome: 'timeout', normalized: { scene: 'unknown', continuity: 'unknown', events: { launch: 'unsure' } } });
  recorder.recordDecision({ kind: 'screen_gate', reason: 'confidence_threshold', request_id: screen, confidence: 0.7, threshold: 0.6, stage: 'screen',
    yes_count: 0, no_count: 2, armed: true, latched: false, secret });
  await recorder.flush();
  const snapshot = recorder.query();
  assert.equal(snapshot.frames.length, 5);
  assert.deepEqual(recorder.request(screen).frame_ids, [ids[4]]);
  assert.deepEqual(recorder.request(review).frame_ids, ids);
  assert.equal(recorder.request(screen).status, 'ok', 'normalization never replaces transport outcome');
  assert.equal(recorder.request(screen).latency_ms, 321);
  assert.equal(recorder.request(screen).usage.input_tokens, 4000);
  assert.equal(recorder.request(screen).normalized.events.launch.choice, 'yes');
  for (const row of snapshot.frames) {
    assert.deepEqual(row.review_request_ids, [review]);
    assert.deepEqual(row.screen_request_ids, row.id === ids[4] ? [screen] : []);
    assert.equal(row.image_url, '/api/operator/debug/frame/' + row.id);
  }
  assert.equal(snapshot.decisions[0].armed, true);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes('data:image'), false);
  assert.deepEqual(recorder.query({ frame_id: ids[4] }).requests.map(row => row.id), [screen, review]);
  assert.equal(recorder.query({ request_id: review }).frames.length, 5);
  assert.equal(recorder.query({ limit: 2 }).frames.length, 2);
  const page = recorder.query({ limit: 2 });
  assert.equal(recorder.query({ before: page.next_cursor, limit: 2 }).frames.length, 2);
  const bytes = Buffer.from(PNG.split(',')[1], 'base64');
  assert.deepEqual((await recorder.image(ids[0])).data, bytes);
});

test('retention evicts old images and bounds request/decision history with explicit counters', async t => {
  const bytes = Buffer.from(PNG.split(',')[1], 'base64').length;
  const { directory, recorder } = await fixture(t, { maxFrames: 2, maxBytes: bytes * 2, maxRequests: 2, maxDecisions: 2 });
  await recorder.setEnabled(true);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const observation = frame(String(i), 1000 + i);
    ids.push(recorder.recordFrame(observation));
    recorder.beginRequest({ stage: 'screen', frames: [observation] });
    recorder.recordDecision({ kind: 'reset', reason: 'synthetic' });
  }
  await recorder.flush();
  const result = recorder.query();
  assert.equal(result.stats.total_frames, 5);
  assert.equal(result.stats.frames, 2);
  assert.equal(result.stats.expired_frames, 3);
  assert.equal(result.stats.bytes, bytes * 2);
  assert.equal(result.requests.length, 2);
  assert.equal(result.decisions.length, 2);
  assert.equal(await recorder.image(ids[0]), null);
  assert.equal((await fs.readdir(path.join(directory, 'frames'))).length, 2);
  const reloaded = await DebugRecorder.open({ directory, maxFrames: 2, maxBytes: bytes * 2 });
  t.after(() => reloaded.close());
  assert.equal(reloaded.query().stats.expired_frames, 3);
  assert.equal(reloaded.query().stats.frames, 2);
});

test('invalid frames, filesystem errors and unsafe image paths never leak or escape into recognition', async t => {
  const { root, directory, recorder } = await fixture(t);
  await recorder.setEnabled(true);
  assert.equal(recorder.recordFrame({ id: 'bad', at: 1, dataUrl: 'data:image/png;base64,AAAA' }), null);
  assert.equal(recorder.query().stats.dropped_frames, 1);
  assert.equal(await recorder.image('../outside'), null);
  const id = recorder.recordFrame(frame());
  await recorder.flush();
  const imagePath = path.join(directory, 'frames', id + '.png');
  const outside = path.join(root, 'outside-private');
  await fs.writeFile(outside, 'PRIVATE_OUTSIDE_DATA');
  await fs.unlink(imagePath);
  await fs.symlink(outside, imagePath);
  assert.equal(await recorder.image(id), null);
  assert.equal(recorder.request(randomUUID()), null);
  await assert.rejects(recorder.setEnabled('true'), { code: 'invalid_debug_enabled' });
  const blocked = await DebugRecorder.open({ directory: outside });
  t.after(() => blocked.close());
  await assert.rejects(blocked.setEnabled(true), { code: 'debug_storage_unavailable' });
  assert.equal(blocked.recordFrame(frame()), null);
  assert.ok(blocked.state().stats.storage_errors >= 1);
});

test('completion after debug is disabled still records allocated requests and preserves transport error', async t => {
  const { recorder } = await fixture(t);
  await recorder.setEnabled(true);
  recorder.recordFrame(frame());
  const id = recorder.beginRequest({ stage: 'screen', frames: [frame()] });
  await recorder.setEnabled(false);
  recorder.finishRequest(id, { outcome: 'http_error', latency_ms: 30, raw: null });
  recorder.finishRequest(id, { normalized: { valid: false, scene: 'unknown', events: {} } });
  assert.equal(recorder.request(id).status, 'http_error');
  assert.equal(recorder.request(id).latency_ms, 30);
  assert.equal(recorder.recordFrame(frame('new', 2000)), null);
});

test('interrupted index writes recover image files, while corrupt metadata is preserved and blocks collection', async t => {
  const { directory, recorder } = await fixture(t);
  await recorder.setEnabled(true);
  const id = recorder.recordFrame(frame());
  await recorder.flush();
  const orphan = randomUUID();
  await fs.writeFile(path.join(directory, 'frames', orphan + '.png'), Buffer.from(PNG.split(',')[1], 'base64'), { mode: 0o600 });
  const recovered = await DebugRecorder.open({ directory });
  t.after(() => recovered.close());
  assert.ok(recovered.query().frames.some(row => row.id === orphan && row.capture_id === 'recovered-after-interruption'));
  assert.ok(await recovered.image(id));
  assert.ok(await recovered.image(orphan));
  const manifest = path.join(directory, 'index.json');
  const corrupted = '{broken-private-debug-index';
  await fs.writeFile(manifest, corrupted);
  const blocked = await DebugRecorder.open({ directory });
  t.after(() => blocked.close());
  assert.equal(blocked.enabled, false);
  assert.ok(blocked.state().stats.storage_errors >= 1);
  await assert.rejects(blocked.setEnabled(true), { code: 'debug_storage_unavailable' });
  await blocked.setEnabled(false);
  await blocked.flush();
  assert.equal(await fs.readFile(manifest, 'utf8'), corrupted);
  assert.ok((await fs.stat(path.join(directory, 'frames', id + '.png'))).isFile());
});

test('failed metadata write or sync removes its temporary file and keeps the last durable index', async t => {
  const { directory, recorder } = await fixture(t);
  await recorder.setEnabled(true);
  const durable = await fs.readFile(path.join(directory, 'index.json'), 'utf8');
  const originalOpen = fs.open.bind(fs);
  for (const failMethod of ['writeFile','sync','close']) {
    const mock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const originalClose = handle.close.bind(handle);
        handle[failMethod] = async () => { if (failMethod === 'close') await originalClose(); throw Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE'); };
      }
      return handle;
    });
    recorder.recordDecision({ kind: 'reset', reason: 'synthetic_fault' });
    await recorder.flush();
    mock.mock.restore();
    assert.equal((await fs.readdir(directory)).filter(file => file.endsWith('.tmp')).length, 0, failMethod);
    assert.equal(await fs.readFile(path.join(directory, 'index.json'), 'utf8'), durable, failMethod);
  }
  assert.equal(recorder.state().stats.storage_errors, 3);
  assert.equal(JSON.stringify(recorder.query()).includes('SYNTHETIC_PRIVATE_STORAGE_FAILURE'), false);
});

test('metadata byte quota expires old request/decision rows, preserves captured images and remains reloadable', async t => {
  const { directory, recorder } = await fixture(t, { maxMetadataBytes: 8192 });
  await recorder.setEnabled(true);
  const observation = frame();
  const frameId = recorder.recordFrame(observation);
  const heavy = Array.from({ length: 12 }, (_, index) => ({ id: 'event-' + index,
    label: '界'.repeat(80), description: '界'.repeat(300), mode: 'instant', min_confidence: 0.85 }));
  const oversized = recorder.beginRequest({ stage: 'screen', frames: [observation], definitions: heavy });
  recorder.finishRequest(oversized, { outcome: 'ok', raw: { answers: [{ name: 'scene', type: 'choice', choice: 'gameplay', confidence: 0.99 }] } });
  await recorder.flush();
  assert.equal(recorder.request(oversized), null);
  assert.equal(recorder.state().stats.expired_requests, 1);
  assert.equal(recorder.query().frames[0].id, frameId);
  assert.deepEqual(recorder.query().frames[0].screen_request_ids, [oversized], 'the image still proves it was screened even when older output expires');
  assert.ok(await recorder.image(frameId));
  for (let index = 0; index < 40; index++) recorder.recordDecision({ kind: 'screen_gate', reason: 'confidence_threshold',
    request_id: oversized, frame_ids: [frameId], confidence: 0.6, threshold: 0.6, yes_count: 0, no_count: 2, armed: true, latched: false });
  await recorder.flush();
  const quotaState = recorder.state();
  assert.equal(quotaState.stats.frames, 1);
  assert.ok(quotaState.stats.expired_decisions > 0);
  assert.ok(quotaState.stats.metadata_bytes <= quotaState.limits.max_metadata_bytes);
  assert.ok((await fs.stat(path.join(directory, 'index.json'))).size <= 8192);
  assert.equal(quotaState.stats.storage_errors, 0);
  const restored = await DebugRecorder.open({ directory, maxMetadataBytes: 8192 });
  t.after(() => restored.close());
  assert.equal(restored.enabled, true);
  assert.equal(restored.state().stats.expired_requests, quotaState.stats.expired_requests);
  assert.equal(restored.state().stats.expired_decisions, quotaState.stats.expired_decisions);
  assert.ok(await restored.image(frameId));
  assert.equal(restored.state().stats.storage_errors, 0);
});

test('a valid refusal needs no confidence while malformed choice confidence remains explicit', async t => {
  const { recorder } = await fixture(t);
  await recorder.setEnabled(true);
  const request = recorder.beginRequest({ stage: 'screen' });
  recorder.finishRequest(request, { outcome: 'ok', raw: { answers: [
    { name: 'event:launch', type: 'refusal' },
    { name: 'scene', type: 'choice', choice: 'gameplay' },
    { name: 'event:landing', type: 'refusal', confidence: 2 },
    { name: 'event:flag', type: 'choice', choice: 'no', confidence: 0.9 },
  ] } });
  const answers = recorder.request(request).raw.answers;
  assert.deepEqual(answers[0], { name: 'event:launch', type: 'refusal', refusal: true });
  assert.equal(answers[1].malformed, true);
  assert.equal(answers[1].invalid_confidence, true);
  assert.equal(answers[2].refusal, true);
  assert.equal(answers[2].confidence, 2);
  assert.equal(answers[2].invalid_confidence, true);
  assert.equal(answers[2].malformed, true);
  assert.equal(answers[3].malformed, undefined);
  assert.equal(answers[3].confidence, 0.9);
});
