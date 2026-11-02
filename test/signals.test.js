import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchSignals } from '../server/signals.js';

const START = Date.parse('2026-10-30T12:00:00Z');
const defaults = () => ({ moments: [
  { id: 'stream-15', kind: 'twitch', trigger: { type: 'stream_minutes', minutes: 15 } },
  { id: 'clip-created', kind: 'twitch' }, { id: 'chat-spike', kind: 'twitch' },
], signals: { clip_poll_enabled: true, chat_spike: {
  enabled: true, window_seconds: 10, min_messages: 4, min_viewers: 2, cooldown_seconds: 60,
} } });
const live = (id = 'stream-1', started = START) => ({ id, user_id: '456', started_at: new Date(started).toISOString() });
const clip = (id, at) => ({ id, broadcaster_id: '456', created_at: new Date(at).toISOString(),
  title: 'PRIVATE TITLE', url: 'https://private.invalid/clip' });
function fixture({ age = 0, config = defaults(), enabled = true } = {}) {
  let clock = START + age, next = 0;
  const timers = new Map(), calls = [], requests = [];
  let stream = live(), clips = [], fail = false, deferred;
  const engine = { config, occur: async (...args) => { calls.push(args); } };
  const api = { request: async endpoint => {
    requests.push({ endpoint, at: clock });
    if (fail) throw Error('mock private provider body');
    if (endpoint.startsWith('/streams?')) return deferred ? await deferred : { data: stream ? [stream] : [] };
    return { data: clips };
  } };
  const signals = new TwitchSignals({ engine, api,
    env: { TWITCH_CONNECT: enabled ? 'true' : 'false', TWITCH_SIGNALS: 'true', TWITCH_BROADCASTER_ID: '456' },
    now: () => clock, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  async function tick() {
    const entry = timers.entries().next().value;
    assert.ok(entry, 'one next presence poll exists');
    const [key, timer] = entry; timers.delete(key); clock += timer.ms; timer.fn();
    while (signals.polling) await new Promise(resolve => setImmediate(resolve));
  }
  return { signals, engine, calls, requests, timers, tick,
    setClock: value => { clock = value; }, clock: () => clock,
    setStream: value => { stream = value; }, setClips: value => { clips = value; },
    setFail: value => { fail = value; }, setDeferred: value => { deferred = value; } };
}

test('signals fail closed unless both flags are exact true', () => {
  for (const flags of [{}, { TWITCH_CONNECT: 'true' }, { TWITCH_SIGNALS: 'true' }, { TWITCH_CONNECT: 'TRUE', TWITCH_SIGNALS: 'true' }]) {
    const signals = new TwitchSignals({ engine: {}, api: { request() { throw Error('unexpected network'); } }, env: flags,
      setTimer() { throw Error('unexpected timer'); } });
    signals.start(); assert.equal(signals.state().status, 'disabled'); signals.close();
  }
});

test('duration uses verified started_at and declares a late observation only once with a durable event ID', async () => {
  const f = fixture({ age: 20 * 60000 }); f.signals.start(); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'stream-15');
  assert.equal(f.calls[0][1].eventId, 'twitch:stream-1:minutes:stream-15');
  assert.equal(f.calls[0][1].source, 'twitch');
  await f.tick(); assert.equal(f.calls.length, 1);
  const streamRequests = f.requests.filter(request => request.endpoint.startsWith('/streams?'));
  assert.ok(streamRequests[1].at - streamRequests[0].at >= 30000);
  f.signals.close();
});

test('offline, invalid timestamps, foreign streams and provider failure cannot produce moments', async () => {
  const f = fixture({ age: 20 * 60000 }); f.setStream(null); f.signals.start(); await f.tick();
  assert.equal(f.signals.state().status, 'offline'); assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 1);
  f.setStream(live('future', START + 30 * 60000)); await f.tick();
  assert.equal(f.signals.state().verified, false);
  f.setStream({ ...live(), user_id: '999' }); await f.tick();
  f.setStream({ ...live(), started_at: 'not-a-date' }); await f.tick();
  f.setFail(true); await f.tick();
  assert.equal(f.signals.state().status, 'degraded'); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(f.signals.state()).includes('private'));
  f.signals.close();
});

test('clips establish a baseline, ignore old delayed clips and emit only new sanitized creations', async () => {
  const f = fixture({ age: 60000 }); f.setClips([clip('existing', START + 1000)]);
  f.signals.start(); await f.tick(); assert.equal(f.calls.length, 0);
  const created = f.clock() + 1000;
  f.setClips([clip('existing', START + 1000), clip('delayed-old', START + 500), clip('new-clip', created)]);
  await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'clip-created');
  assert.equal(f.calls[0][1].eventId, 'twitch:stream-1:clip:new-clip');
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE TITLE'));
  assert.ok(!JSON.stringify(f.calls).includes('https://'));
  await f.tick(); assert.equal(f.calls.length, 1);
  const url = new URL(f.requests.find(request => request.endpoint.startsWith('/clips?')).endpoint, 'https://example.invalid');
  assert.equal(url.searchParams.get('broadcaster_id'), '456');
  assert.equal(url.searchParams.get('first'), '100');
  assert.equal(url.searchParams.get('started_at'), new Date(START).toISOString());
  f.signals.offline(); await f.tick();
  assert.equal(f.signals.state().status, 'offline');
  assert.equal(f.requests.filter(request => request.endpoint.startsWith('/clips?')).length, 3);
  f.signals.close();
});

test('clip polling starts a fresh baseline for each verified stream and excludes wrong channel clips', async () => {
  const f = fixture({ age: 60000 }); f.signals.start(); await f.tick();
  f.setStream(live('stream-2', f.clock()));
  f.setClips([clip('new-stream-existing', f.clock()), { ...clip('foreign', f.clock()), broadcaster_id: '999' }]);
  await f.tick(); assert.equal(f.calls.length, 0);
  f.setClips([clip('new-stream-later', f.clock() + 1000)]); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].stream_id, 'stream-2');
  f.signals.close();
});

test('chat spike requires messages and distinct viewers, deduplicates, expires windows and respects cooldown', async () => {
  const f = fixture(); f.signals.start(); await f.tick();
  const chat = (id, user) => f.signals.chat({ broadcaster_user_id: '456', chatter_user_id: user,
    message: { text: 'PRIVATE CHAT BODY' }, chatter_user_name: 'PRIVATE NAME' }, id);
  await chat('one', '1'); await chat('one', '1'); await chat('two', '1'); await chat('three', '1');
  assert.equal(f.calls.length, 0); await chat('four', '2');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'chat-spike');
  assert.equal(f.calls[0][1].messages, 4); assert.equal(f.calls[0][1].viewers, 2);
  for (let index = 0; index < 4; index++) await chat('cool-' + index, String(index + 1));
  assert.equal(f.calls.length, 1);
  await f.tick(); await f.tick();
  await chat('later-1', '1'); await chat('later-2', '2'); await chat('later-3', '2'); await chat('later-4', '2');
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify({ state: f.signals.state(), calls: f.calls }).includes('PRIVATE'));
  f.signals.offline(); await chat('offline', '3'); assert.equal(f.calls.length, 2);
  f.signals.close();
});

test('chat ignores unverified, stale, cross-channel and shared-chat events', async () => {
  const f = fixture(); f.signals.start();
  const event = { broadcaster_user_id: '456', chatter_user_id: '1' };
  await f.signals.chat(event, 'before-live'); assert.equal(f.signals.state().bufferedMessages, 0);
  await f.tick();
  await f.signals.chat({ ...event, broadcaster_user_id: '999' }, 'foreign');
  await f.signals.chat({ ...event, source_broadcaster_user_id: '999' }, 'shared');
  f.setClock(f.clock() + 60001); await f.signals.chat(event, 'stale');
  assert.equal(f.signals.state().bufferedMessages, 0); f.signals.close();
});

test('offline fences an in-flight verification result and never wraps or creates a session', async () => {
  const f = fixture({ age: 20 * 60000 }); let resolve;
  f.setDeferred(new Promise(done => { resolve = done; }));
  f.signals.start();
  const [key, timer] = f.timers.entries().next().value; f.timers.delete(key); timer.fn();
  f.signals.offline(); resolve({ data: [live()] });
  while (f.signals.polling) await new Promise(done => setImmediate(done));
  assert.equal(f.calls.length, 0); assert.equal(f.signals.state().status, 'offline');
  f.signals.close(); assert.equal(f.timers.size, 0);
});

test('online hints never invent timestamps or poll faster than thirty seconds', async () => {
  const f = fixture(); f.setStream(null); f.signals.start(); await f.tick();
  f.setStream(live()); f.signals.online({ id: 'stream-1', broadcaster_user_id: '456', started_at: new Date(START).toISOString() });
  assert.equal(f.signals.state().verified, false);
  assert.ok([...f.timers.values()][0].ms >= 30000);
  await f.tick(); assert.equal(f.signals.state().verified, true); f.signals.close();
});

test('disabled per-detector config avoids clip requests and chat retention', async () => {
  const config = defaults(); config.signals.clip_poll_enabled = false; config.signals.chat_spike.enabled = false;
  const f = fixture({ config }); f.signals.start(); await f.tick();
  await f.signals.chat({ broadcaster_user_id: '456', chatter_user_id: '1' }, 'disabled');
  assert.equal(f.requests.length, 1); assert.equal(f.signals.state().bufferedMessages, 0); f.signals.close();
});


test('chat storage bounds user identities and never stores text or names', async () => {
  const config = defaults(); config.signals.clip_poll_enabled = false;
  config.signals.chat_spike.min_messages = 10000; config.signals.chat_spike.min_viewers = 1000;
  const f = fixture({ config }); f.signals.start(); await f.tick();
  for (let index = 0; index < 2010; index++) await f.signals.chat({ broadcaster_user_id: '456',
    chatter_user_id: String(index + 1), message: { text: 'PRIVATE BODY' }, chatter_user_name: 'PRIVATE NAME',
  }, 'bounded-' + index);
  assert.equal(f.signals.viewers.size, 2000);
  assert.equal(f.signals.messages.length, 2010);
  assert.ok(f.signals.messages.every(timestamp => typeof timestamp === 'number'));
  assert.ok(!JSON.stringify(f.signals.messages).includes('PRIVATE'));
  assert.equal(f.calls.length, 0); f.signals.close();
});

test('a delayed online event cannot revive an ended stream; a new verified stream can resume', async () => {
  const f = fixture(); f.signals.start(); await f.tick();
  f.signals.offline(); f.signals.online({ id: 'stream-1', broadcaster_user_id: '456' }); await f.tick();
  assert.equal(f.signals.state().status, 'offline'); assert.equal(f.signals.state().verified, false);
  f.setStream(live('stream-2', f.clock())); await f.tick();
  assert.equal(f.signals.state().status, 'live'); assert.equal(f.signals.state().streamId, 'stream-2');
  f.signals.close();
});

test('offline before the first verification fences stale streams even after a delayed old online hint', async () => {
  const f = fixture({ age: 20 * 60000 }); let resolve;
  f.setDeferred(new Promise(done => { resolve = done; }));
  f.signals.start();
  const [key, timer] = f.timers.entries().next().value;
  f.timers.delete(key); timer.fn();
  f.signals.offline();
  const offlineAt = f.clock();
  resolve({ data: [live()] });
  while (f.signals.polling) await new Promise(done => setImmediate(done));
  f.setDeferred(undefined);
  // This was sent before offline but delivered after it. The old stream was never observed locally.
  f.signals.online({ id: 'stream-1', broadcaster_user_id: '456' });
  await f.tick();
  assert.equal(f.calls.length, 0, 'stale live metadata must not emit a duration occurrence');
  assert.equal(f.signals.state().verified, false);
  assert.equal(f.signals.state().status, 'offline');
  assert.equal(f.requests.filter(request => request.endpoint.startsWith('/clips?')).length, 0);
  // A changed id alone does not establish recency, and equality is not after offline.
  f.setStream(live('renamed-old-stream', offlineAt)); await f.tick();
  assert.equal(f.signals.state().verified, false);
  assert.equal(f.calls.length, 0);
  f.setStream(live('genuinely-new-stream', offlineAt + 1000)); await f.tick();
  assert.equal(f.signals.state().verified, true);
  assert.equal(f.signals.state().streamId, 'genuinely-new-stream');
  assert.equal(f.calls.length, 0);
  f.signals.close();
});


test('Helix can independently establish a strictly newer stream when the online notification is missing', async () => {
  const f = fixture(); f.signals.start(); f.signals.offline();
  f.setStream(live('new-after-offline', f.clock() + 1000));
  f.setClock(f.clock() + 2000); await f.tick();
  assert.equal(f.signals.state().verified, true);
  assert.equal(f.signals.state().streamId, 'new-after-offline');
  assert.equal(f.calls.length, 0); f.signals.close();
});
