import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TwitchAPI, saveEnv, deviceAuthorize, requiredScopes } from "../server/twitch-api.js";
import { TwitchAuthLog } from "../server/twitch-auth-log.js";
import { readEnv } from "../server/env-store.js";
import { connectTwitch } from "../server/twitch.js";
import { createTwitchAdapter } from "../server/twitch-adapter.js";
import { authorizeTwitch } from "../server/twitch-auth.js";
import { monitorTwitchAuth } from "../server/twitch-lifecycle.js";

const env = () => ({ TWITCH_CONNECT: "true", TWITCH_CLIENT_ID: "mock-client", TWITCH_TOKEN: "mock-access-old",
  TWITCH_REFRESH_TOKEN: "mock-refresh-old", TWITCH_BROADCASTER_ID: "456", TWITCH_USER_ID: "456" });
const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = { log() {}, error() {} };
class Socket extends EventEmitter {
  message(type, payload, id = "event-1") {
    this.emit("message", JSON.stringify({ metadata: { message_type: type, message_id: id }, payload }));
  }
  close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  terminate() { this.close(); }
}
function fakeAPI() {
  const listeners = new Set();
  const api = { authChanged: state => { for (const fn of listeners) fn(state); }, calls: [], validateToken: async () => ({}),
    subscribe: async (...args) => { api.calls.push(args); },
    onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  return api;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sealed-twitch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".env"), values = env();
  await saveEnv(file, { ...values, KEEP: "untouched" });
  const journal = new TwitchAuthLog(path.join(root, "auth.jsonl"));
  return { root, file, values, journal };
}

test("durable refresh shares one rotating exchange across concurrent instances and late 401s", async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetcher = async () => { calls++; await tick(); return Response.json({ access_token: "mock-access-new",
    refresh_token: "mock-refresh-new", expires_in: 14400 }); };
  const a = new TwitchAPI({ ...f.values }, { envFile: f.file, journal: f.journal, fetcher });
  const b = new TwitchAPI({ ...f.values }, { envFile: f.file, journal: f.journal, fetcher });
  await Promise.all([a.refresh(), a.refresh(), b.refresh()]);
  await b.refresh("401", "mock-access-old");
  assert.equal(calls, 1);
  const saved = await readEnv(f.file);
  assert.equal(saved.TWITCH_TOKEN, "mock-access-new");
  assert.equal(saved.KEEP, "untouched");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const journal = await readFile(f.journal.file, "utf8");
  for (const token of ["mock-access-old", "mock-refresh-old", "mock-access-new", "mock-refresh-new"])
    assert.ok(!journal.includes(token));
  assert.ok(journal.includes('"phase":"committed"'));
});

test("uncertain refresh fences restart and never reuses a spent refresh token", async t => {
  const f = await fixture(t); let calls = 0;
  const fetcher = async () => { calls++; throw Error("mock private provider payload"); };
  const a = new TwitchAPI({ ...f.values }, { envFile: f.file, journal: f.journal, fetcher });
  await assert.rejects(a.refresh(), /re-authorization/);
  const b = new TwitchAPI({ ...f.values }, { envFile: f.file, journal: f.journal, fetcher });
  await assert.rejects(b.refresh(), /re-authorization/);
  assert.equal(calls, 1);
  const marker = await readFile(f.file + ".twitch-refresh.json", "utf8");
  assert.ok(!marker.includes("mock-refresh-old"));
  assert.equal((await stat(f.file + ".twitch-refresh.json")).mode & 0o777, 0o600);
  assert.ok(!(await readFile(f.journal.file, "utf8")).includes("private provider"));
});

test("Helix subscription conditions and versions match Twitch EventSub contracts", async () => {
  const values = { ...env(), PAYMENTS_LIVE: "true", TWITCH_REWARD_ID: "reward" };
  const api = new TwitchAPI(values, { journal: { write: async () => {} } });
  const requests = []; api.request = async (url, options) => { requests.push(options.body); return {}; };
  for (const type of ["channel.raid", "channel.follow", "channel.poll.end", "channel.subscribe", "channel.chat.message",
    "channel.channel_points_custom_reward_redemption.add"]) await api.subscribe(type, "session");
  assert.deepEqual(requests[0].condition, { to_broadcaster_user_id: "456" });
  assert.equal(requests[1].version, "2");
  assert.equal(requests[1].condition.moderator_user_id, "456");
  assert.equal(requests[4].condition.user_id, "456");
  assert.equal(requests[5].condition.reward_id, "reward");
  assert.throws(() => api.subscribe("unknown", "session"), /Unsupported/);
});

test("reward creation and repair disable user input and reject simulated mode", async () => {
  const api = new TwitchAPI(env());
  await assert.rejects(api.ensureReward(100), /disabled/);
  api.env.PAYMENTS_LIVE = "true";
  const requests = [];
  api.request = async (url, options) => { requests.push({ url, options });
    return options ? { data: [{ id: "reward", title: "Seal a note", cost: 100 }] }
      : { data: [{ id: "reward", title: "Seal a note", is_user_input_required: true }] }; };
  const reward = await api.ensureReward(100);
  assert.equal(reward.created, false);
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.body.is_user_input_required, false);
  await api.updateRedemption("redeem", "CANCELED", "reward");
  assert.equal(requests[2].options.body.status, "CANCELED");
});

test("EventSub handoff preserves subscriptions, filters wrong channels and deduplicates replay", async t => {
  const sockets = [], api = fakeAPI(), events = [];
  const connection = connectTwitch(event => events.push(event), env(), {
    api, logger: quiet, socketFactory: url => { const socket = new Socket(); socket.url = url; sockets.push(socket); return socket; },
  });
  t.after(() => connection.close()); await tick();
  sockets[0].message("session_welcome", { session: { id: "first" } }); await tick();
  const count = api.calls.length;
  sockets[0].message("session_reconnect", { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?handoff=1" } });
  sockets[1].message("session_welcome", { session: { id: "second" } }); await tick();
  assert.equal(api.calls.length, count);
  assert.equal(sockets[0].closed, true);
  const payload = { subscription: { type: "channel.raid" }, event: { to_broadcaster_user_id: "456", viewers: 30 } };
  sockets[1].message("notification", payload); sockets[1].message("notification", payload);
  sockets[1].message("notification", { ...payload, event: { to_broadcaster_user_id: "other" } }, "wrong-channel");
  await tick(); assert.equal(events.length, 1);
  sockets[1].message("session_reconnect", { session: { reconnect_url: "wss://attacker.invalid/ws" } });
  await tick(); assert.equal(sockets.length, 2);
});

test("authorization revocation stops sockets and publishes bounded status", async t => {
  const api = fakeAPI(), sockets = [];
  const connection = connectTwitch(() => {}, env(), { api, logger: quiet,
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  t.after(() => connection.close()); await tick();
  api.authChanged({ status: "reauthorization-required", reason: "refresh-rejected" });
  assert.equal(connection.status.connection, "reauthorization-required");
  assert.equal(sockets[0].closed, true);
});

test("adapter authenticates command badges and never wraps on offline or leaks raw redemption input", async t => {
  const sockets = [], calls = [], credits = [], api = fakeAPI();
  const values = { ...env(), PAYMENTS_LIVE: "true", TWITCH_REWARD_ID: "reward", TWITCH_POLLS: "true", TWITCH_SUBSCRIPTIONS: "true" };
  const adapter = createTwitchAdapter({ occur: async (...args) => calls.push(args), newSession() { throw Error("unexpected session"); } }, values,
    { api, logger: quiet, onRedemption: event => credits.push(event), socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  t.after(() => adapter.close()); await tick();
  let next = 0;
  const emit = (type, event, id = `id-${++next}`) => sockets[0].message("notification", {
    subscription: { type }, event: { broadcaster_user_id: "456", ...event } }, id);
  emit("channel.chat.message", { chatter_user_id: "123", message: { text: "!moment margit" }, badges: [] });
  emit("channel.chat.message", { chatter_user_id: "123", message: { text: "!moment margit" }, badges: [{ set_id: "moderator" }] }, "mod-command");
  emit("channel.chat.message", { chatter_user_id: "123", message: { text: "!moment margit" }, badges: [{ set_id: "moderator" }] }, "mod-command");
  emit("channel.chat.message", { chatter_user_id: "123", source_broadcaster_user_id: "other", message: { text: "!moment margit" }, badges: [{ set_id: "moderator" }] });
  emit("channel.chat.message", { chatter_user_id: "123", message: { text: "!moment margit" }, badges: [{ set_id: "broadcaster" }] });
  emit("channel.follow", { user_id: "123" });
  emit("channel.poll.end", { id: "poll-1", title: "private arbitrary text" });
  emit("channel.subscribe", { user_id: "123" });
  emit("channel.raid", { to_broadcaster_user_id: "456", viewers: 30 });
  emit("channel.channel_points_custom_reward_redemption.add", { id: "redeem", user_id: "123", user_input: "PRIVATE NOTE", reward: { id: "reward", cost: 100 } });
  emit("stream.online", { id: "stream-1" }); emit("stream.offline", {});
  await tick();
  assert.deepEqual(calls.map(call => call[0]), ["margit", "new-follower", "poll-ended", "new-sub", "raid"]);
  assert.equal(calls[0][2], "moderator");
  assert.equal(adapter.state().stream, "offline");
  assert.equal(credits.length, 1);
  assert.ok(!JSON.stringify({ calls, credits, state: adapter.state() }).includes("PRIVATE NOTE"));
  assert.ok(!JSON.stringify(calls).includes("private arbitrary text"));
});

test("adapter flags fail closed and do not validate or connect", () => {
  let calls = 0;
  const api = { validateToken: () => { calls++; } };
  for (const value of [undefined, "false", "1", "TRUE"])
    createTwitchAdapter({}, { ...env(), TWITCH_CONNECT: value }, { api });
  assert.equal(calls, 0);
  assert.deepEqual(requiredScopes({}).sort(), ["moderator:read:followers", "user:read:chat"]);
});

test("auth monitor schedules proactive refresh and hourly validation without keeping process alive", async () => {
  const timers = new Map(); let next = 0, refreshes = 0;
  const stop = monitorTwitchAuth({ authState: () => ({ status: "ready", refreshAt: 3000000 }),
    refresh: async () => { refreshes++; }, validateToken: async () => {} }, {
    now: () => 0, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  assert.ok([...timers.values()].some(timer => timer.ms === 3600000));
  await [...timers.values()].find(timer => timer.ms === 3000000).fn();
  assert.equal(refreshes, 1); stop();
});

test("device authorization requires consent scopes and exposes fixed errors only", async () => {
  let n = 0;
  const token = await deviceAuthorize("mock-client", { journal: { write: async () => {} }, sleep: async () => {},
    requiredScopes: ["user:read:chat"], fetcher: async () => ++n === 1
      ? Response.json({ device_code: "private-device", user_code: "MOCK", verification_uri: "https://example.invalid", expires_in: 20 })
      : Response.json({ access_token: "mock-access", refresh_token: "mock-refresh", scope: ["user:read:chat"] }) });
  assert.equal(token.access_token, "mock-access");
  await assert.rejects(deviceAuthorize("mock", { journal: { write: async () => {} }, fetcher: async () => { throw Error("PRIVATE TOKEN"); } }),
    error => !error.message.includes("PRIVATE TOKEN"));
});


test("new device authorization validates the broadcaster before atomic installation", async t => {
  const f = await fixture(t);
  const scopes = requiredScopes({}); let requests = 0;
  const fetcher = async url => {
    requests++;
    if (url.endsWith("/device")) return Response.json({ device_code: "private-device", user_code: "MOCK-CODE",
      verification_uri: "https://example.invalid", expires_in: 30, interval: 1 });
    if (url.endsWith("/token")) return Response.json({ access_token: "mock-device-access", refresh_token: "mock-device-refresh", scope: scopes });
    return Response.json({ client_id: "mock-client", user_id: "456", scopes, expires_in: 3600 });
  };
  const result = await authorizeTwitch(f.values, { envFile: f.file, fetcher, journal: f.journal, sleep: async () => {} });
  assert.equal(requests, 3);
  assert.equal(result.userId, "456");
  assert.equal((await readEnv(f.file)).TWITCH_TOKEN, "mock-device-access");
  assert.ok(!JSON.stringify(result).includes("mock-device"));
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(f.journal.file, "utf8")).includes("mock-device-access"));
  await assert.rejects(authorizeTwitch({ ...f.values, TWITCH_BROADCASTER_ID: "999" }, {
    envFile: f.file, fetcher, journal: f.journal, sleep: async () => {},
  }), /configured broadcaster/);
  assert.equal((await readEnv(f.file)).TWITCH_BROADCASTER_ID, "456");
});

test("opt-in stream session management deduplicates distinct deliveries for one stream", async t => {
  let sessions = 0; const sockets = [];
  const adapter = createTwitchAdapter({ newSession: async () => { sessions++; } }, { ...env(), TWITCH_AUTO_SESSION: "true" }, {
    api: fakeAPI(), logger: quiet, socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  t.after(() => adapter.close()); await tick();
  for (const id of ["delivery-1", "delivery-2"]) sockets[0].message("notification", {
    subscription: { type: "stream.online" }, event: { id: "stream-1", broadcaster_user_id: "456" },
  }, id);
  await tick(); assert.equal(sessions, 1);
});


test("adapter exposes opt-in signals and forwards trusted chat and offline lifecycle", async t => {
  const api = fakeAPI(), sockets = [], timers = new Map(); let next = 0;
  const now = Date.parse('2026-10-30T12:00:00Z');
  api.request = async endpoint => ({ data: endpoint.startsWith('/streams?')
    ? [{ id: 'signal-stream', user_id: '456', started_at: new Date(now).toISOString() }] : [] });
  const calls = [];
  const engine = { config: { moments: [{ id: 'chat-spike', kind: 'twitch' }], signals: { chat_spike: {
    enabled: true, window_seconds: 10, min_messages: 2, min_viewers: 2, cooldown_seconds: 60,
  } } }, occur: async (...args) => calls.push(args) };
  const adapter = createTwitchAdapter(engine, { ...env(), TWITCH_SIGNALS: 'true' }, {
    api, logger: quiet, socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    signalsOptions: { now: () => now, setTimer: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
      clearTimer: id => timers.delete(id) },
  });
  t.after(() => adapter.close()); await tick();
  const [key, timer] = timers.entries().next().value; timers.delete(key); timer.fn();
  while (adapter.signals.polling) await tick();
  for (const user of ['1', '2']) sockets[0].message('notification', {
    subscription: { type: 'channel.chat.message' }, event: { broadcaster_user_id: '456', chatter_user_id: user,
      badges: [], message: { text: 'ordinary viewer chat' } },
  }, 'signal-chat-' + user);
  await tick(); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'chat-spike');
  sockets[0].message('notification', { subscription: { type: 'stream.offline' }, event: { broadcaster_user_id: '456' } }, 'signal-offline');
  await tick(); assert.equal(adapter.state().signals.status, 'offline');
  adapter.close(); assert.equal(timers.size, 0); assert.equal(adapter.signals.state().status, 'closed');
});
