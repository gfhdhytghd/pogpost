import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decodeSecret, signExtensionJWT, verifyExtensionJWT } from "../server/extension/auth.js";
import { ExtensionPublisher } from "../server/extension/publisher.js";
import { ExtensionNames } from "../server/extension/identity.js";
import { isLocalRequest } from "../server/local-request.js";
import { IngressLimiter } from "../engine/ingress.js";

const secret = Buffer.alloc(32, 7), now = 1000000;
const payload = extra => ({ exp: now / 1000 + 60, channel_id: "456", role: "viewer", opaque_user_id: "Uone", ...extra });
const jwt = extra => signExtensionJWT(payload(extra), secret);

test("reused JWT accepts trusted shared identity and rejects tampering, algorithm, time, role and channel", () => {
  assert.deepEqual(verifyExtensionJWT(jwt({ user_id: "123" }), secret, "456", now),
    { opaqueId: "Uone", role: "viewer", userId: "123" });
  for (const extra of [{ exp: 1 }, { nbf: 2000 }, { channel_id: "bad" }, { role: "external" },
    { opaque_user_id: "../Uone" }, { user_id: "name" }, { exp: "9999999" }])
    assert.throws(() => verifyExtensionJWT(jwt(extra), secret, "456", now));
  const [head, body] = jwt().split(".");
  assert.throws(() => verifyExtensionJWT(head + "." + body + ".invalid", secret, "456", now));
  const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + "." + body;
  const signed = none + "." + createHmac("sha256", secret).update(none).digest("base64url");
  assert.throws(() => verifyExtensionJWT(signed, secret, "456", now));
  assert.deepEqual(decodeSecret(secret.toString("base64")), secret);
  assert.throws(() => decodeSecret("short"));
});

test("Twitch opaque IDs allow hyphens and underscores without weakening JWT checks", () => {
  for (const opaque_user_id of ["U-abc_123", "A-anonymous_123", "U1594736759"]) {
    assert.equal(verifyExtensionJWT(jwt({ opaque_user_id }), secret, "456", now).opaqueId, opaque_user_id);
  }
  for (const opaque_user_id of ["U../abc", "U abc", "Uabc/def", "U", "X-abc", "U" + "a".repeat(80)]) {
    assert.throws(() => verifyExtensionJWT(jwt({ opaque_user_id }), secret, "456", now));
  }
  const publisher = new ExtensionPublisher({ secret, setTimer: () => ({ unref() {} }) });
  publisher.whisper("U-abc_123", { type: "opened" });
  assert.equal(publisher.whispers.get("U-abc_123").target, "whisper-U-abc_123");
  publisher.whisper("U../abc", { type: "opened" });
  assert.equal(publisher.whispers.size, 1);
  publisher.close();
});

test("reused publisher coalesces snapshots and private receipts under one channel message per second", async () => {
  let clock = now, next = 0;
  const timers = new Map(), calls = [];
  const publisher = new ExtensionPublisher({ secret, clientId: "mock-extension", ownerId: "123", channelId: "456",
    now: () => clock, setTimer: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    clearTimer: id => timers.delete(id), fetcher: async (url, init) => {
      const token = init.headers.Authorization.slice(7);
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
      assert.equal(token, signExtensionJWT(claims, secret));
      assert.equal(url, "https://api.twitch.tv/helix/extensions/pubsub");
      calls.push({ claims, body: JSON.parse(init.body), at: clock });
      return new Response(null, { status: 204 });
    } });
  const tick = async () => { const [key, timer] = timers.entries().next().value;
    timers.delete(key); clock += timer.ms; timer.fn();
    while (publisher.busy) await new Promise(resolve => setImmediate(resolve)); };
  publisher.snapshot({ sealed: 1 }); publisher.snapshot({ sealed: 2 });
  publisher.whisper("Uone", { noteId: "receipt", status: "opened" });
  publisher.whisper("../../invalid", { status: "ignored" });
  await tick(); await tick();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body.message).sealed, 2);
  assert.deepEqual(calls.map(call => call.claims.pubsub_perms.send), [["broadcast"], ["whisper-Uone"]]);
  assert.ok(calls[1].at - calls[0].at >= 1000);
  assert.ok(calls.every(call => call.claims.role === "external" && call.claims.channel_id === "456"));
  publisher.snapshot({ sealed: 2 }); assert.equal(timers.size, 0);
  publisher.close();
});

test("reused publisher bounds failed delivery and never throws private transport error bodies", async () => {
  const publisher = new ExtensionPublisher({ secret, clientId: "mock", ownerId: "123", channelId: "456",
    now: () => now, setTimer: () => 1, clearTimer() {}, fetcher: async () => { throw Error("mock private response"); } });
  publisher.snapshot({ sealed: 1 }); await publisher.flush();
  assert.equal(publisher.stats.failed, 1); assert.equal(publisher.nextAt, now + 2000); publisher.close();
});

test("reused name resolver filters provider names and never resolves an anonymous identity", async () => {
  let calls = 0;
  const names = new ExtensionNames(async id => { calls++; return id === "123" ? "FriendlyViewer" : "person@example.com"; });
  assert.equal(await names.get(null), "a viewer"); assert.equal(calls, 0);
  assert.equal(await names.get("123"), "FriendlyViewer");
  assert.equal(await names.get("123"), "FriendlyViewer"); assert.equal(calls, 1);
  assert.equal(await names.get("456"), "a viewer");
});

test("reused direct-loopback guard rejects relay headers, public Host and non-loopback addresses", () => {
  const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost:8788" } };
  assert.equal(isLocalRequest(request), true);
  for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"])
    assert.equal(isLocalRequest({ ...request, headers: { ...request.headers, [name]: "relay" } }), false);
  assert.equal(isLocalRequest({ ...request, headers: { host: "public.example" } }), false);
  assert.equal(isLocalRequest({ ...request, socket: { remoteAddress: "192.0.2.1" } }), false);
  assert.equal(isLocalRequest({ ...request, socket: { remoteAddress: "::1" }, headers: { host: "[::1]:8788" } }), true);
});

test("reused ingress limits share global and identity budgets and reset on the next window", () => {
  const limiter = new IngressLimiter({ perIdentity: 2, global: 3, capacity: 10, windowMs: 1000 });
  assert.equal(limiter.accept("Uone", 1000), true); assert.equal(limiter.accept("Uone", 1001), true);
  assert.equal(limiter.accept("Uone", 1002), false); assert.equal(limiter.accept("Utwo", 1002), true);
  assert.equal(limiter.accept("Uthree", 1002), false); assert.equal(limiter.accept("Uone", 2000), true);
});
