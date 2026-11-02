import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ExtensionService, actionBody } from "../server/extension/service.js";
import {
  decodeSecret,
  signExtensionJWT,
  verifyExtensionJWT,
} from "../server/extension/auth.js";
import { ExtensionPublisher } from "../server/extension/publisher.js";
import { ExtensionRounds } from "../server/extension/rounds.js";
import { ExtensionNames } from "../server/extension/identity.js";
import { Participation } from "../server/participation.js";
import { DecisionsClient } from "../server/decisions.js";
import { RoundController } from "../server/round.js";
import { createRematch } from "../engine/rematch.js";
import reference from "../engine/rematch-reference.js";
import { proveRematch } from "../gen/rematch-proof.js";
import { createHTTP } from "../server/http.js";
import { executionCredit } from "../overlay/rematch-credit.js";
import { codexEnvironment } from "../gen/child-env.js";
import { packageExtension } from "../tools/extension/zip.mjs";

const secret = Buffer.alloc(32, 91);
const env = {
  TWITCH_EXT_CLIENT_ID: "mockextension",
  TWITCH_EXT_SECRET: secret.toString("base64"),
  TWITCH_EXT_OWNER_ID: "123",
  TWITCH_BROADCASTER_ID: "456",
};
const origin = "https://mockextension.ext-twitch.tv";
const identity = (opaqueId = "Uone", userId = null) => ({
  opaqueId,
  userId,
  role: "viewer",
});
const payload = (extra = {}) => ({
  exp: Math.floor(Date.now() / 1000) + 300,
  channel_id: "456",
  role: "viewer",
  opaque_user_id: "Uone",
  ...extra,
});
const jwt = (extra = {}) => signExtensionJWT(payload(extra), secret);
const publisher = () => ({
  stats: { sent: 0, failed: 0 },
  snapshots: [],
  whispers: [],
  snapshot(value) {
    this.snapshots.push(value);
  },
  whisper(opaque, value) {
    this.whispers.push({ opaque, value });
  },
  close() {},
});
function participation() {
  const client = new DecisionsClient({ enabled: false, keyReader: () => null });
  const inputs = new Participation(client, () => {}, { coalesceMs: 0 });
  inputs.start();
  return inputs;
}
function roundFixture() {
  let clock = 100000;
  const push = publisher(),
    inputs = participation();
  const rounds = new ExtensionRounds({
    enabled: true,
    publisher: push,
    now: () => clock,
  });
  rounds.begin(inputs, clock + 26500);
  rounds.open();
  const action = (intent = "aim", extra = {}) => ({
    roundId: rounds.id,
    intent,
    latency: 8,
    ...extra,
  });
  return {
    rounds,
    inputs,
    push,
    action,
    setClock: (n) => {
      clock = n;
    },
    now: () => clock,
  };
}
async function httpFixture() {
  const push = publisher();
  const service = new ExtensionService(env, {
    publisher: push,
    resolveName: async () => "SharedName",
  });
  const inputs = participation();
  service.rounds.begin(inputs, Date.now() + 26500);
  service.rounds.open();
  const server = createHTTP(
    process.cwd(),
    { list: async () => [], score: async () => ({}) },
    { extension: service },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.ok(![8787, 8911].includes(port));
  const base = "http://127.0.0.1:" + port;
  const request = (route = "/ebs/state", init = {}) =>
    fetch(base + route, {
      ...init,
      headers: {
        Origin: origin,
        Authorization: "Bearer " + jwt(),
        ...init.headers,
      },
    });
  return {
    service,
    push,
    inputs,
    base,
    request,
    async close() {
      service.close();
      inputs.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("extension JWT verifies HS256, expiry, channel, roles and shared identity without accepting forged headers", () => {
  assert.equal(verifyExtensionJWT(jwt(), secret, "456").opaqueId, "Uone");
  assert.equal(
    verifyExtensionJWT(jwt({ user_id: "123456789" }), secret, "456").userId,
    "123456789",
  );
  for (const token of [
    jwt({ exp: 1 }),
    jwt({ channel_id: "999" }),
    jwt({ role: "external" }),
    jwt({ opaque_user_id: "bad/id" }),
    jwt({ user_id: "forged-name" }),
    signExtensionJWT(payload(), Buffer.alloc(32, 92)),
    "eyJhbGciOiJub25lIn0.e30.",
  ])
    assert.throws(() => verifyExtensionJWT(token, secret, "456"), {
      code: "invalid_authorization",
    });
  assert.throws(() => decodeSecret("bad"), {
    code: "extension_not_configured",
  });
});

test("EBS CORS permits only the extension origin and all data endpoints require a JWT", async () => {
  const f = await httpFixture();
  try {
    assert.equal((await f.request()).status, 200);
    for (const route of [
      "/ebs/state",
      "/ebs/action",
      "/ebs/config",
      "/ebs/result?roundId=a",
    ])
      assert.equal(
        (await f.request(route, { headers: { Authorization: "" } })).status,
        401,
      );
    for (const value of [
      "https://evil.invalid",
      "null",
      "https://mockextension.ext-twitch.tv.evil.invalid",
    ])
      assert.equal(
        (await f.request("/ebs/state", { headers: { Origin: value } })).status,
        403,
      );
    const preflight = await f.request("/ebs/action", {
      method: "OPTIONS",
      headers: { Authorization: "" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Credentials"),
      null,
    );
    assert.equal((await f.request("/ebs/config")).status, 403);
    assert.equal(
      (
        await f.request("/ebs/config", {
          headers: { Authorization: "Bearer " + jwt({ role: "broadcaster" }) },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/ebs/state?token=not-accepted")).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("EBS enforces strict JSON/body bounds and per-opaque/global request budgets", async () => {
  const f = await httpFixture();
  try {
    const post = (body, headers = {}) =>
      f.request("/ebs/action", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json", ...headers },
      });
    assert.equal((await post("x".repeat(1025))).status, 413);
    assert.equal((await post("{}")).status, 400);
    assert.equal(
      (await post("{}", { "Content-Type": "text/plain" })).status,
      415,
    );
    for (const value of [
      { roundId: "a", intent: "aim", latency: 8, user_id: "99" },
      { roundId: "a", intent: "zone", latency: 8, target: { x: -1, y: 0 } },
      { roundId: "a", intent: "aim", latency: 99 },
    ])
      assert.throws(() => actionBody(value));
    f.service.limiter = new f.service.limiter.constructor({
      perIdentity: 1,
      global: 2,
    });
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.request()).status, 429);
    assert.equal(
      (
        await f.request("/ebs/state", {
          headers: {
            Authorization: "Bearer " + jwt({ opaque_user_id: "Utwo" }),
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/ebs/state", {
          headers: {
            Authorization: "Bearer " + jwt({ opaque_user_id: "Uthree" }),
          },
        })
      ).status,
      429,
    );
  } finally {
    await f.close();
  }
});

test("PubSub signs external broadcast and private whisper permissions and shares one message/second", async () => {
  let clock = 100000,
    next = 0;
  const timers = new Map(),
    calls = [];
  const pub = new ExtensionPublisher({
    secret,
    clientId: "mockextension",
    ownerId: "123",
    channelId: "456",
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (id) => timers.delete(id),
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.twitch.tv/helix/extensions/pubsub");
      const claims = JSON.parse(
        Buffer.from(
          init.headers.Authorization.slice(7).split(".")[1],
          "base64url",
        ),
      );
      assert.equal(
        init.headers.Authorization.slice(7),
        signExtensionJWT(claims, secret),
      );
      calls.push({ claims, body: JSON.parse(init.body), at: clock });
      return new Response(null, { status: 204 });
    },
  });
  async function tick() {
    const [key, timer] = timers.entries().next().value;
    timers.delete(key);
    clock += timer.ms;
    timer.fn();
    while (pub.busy) await new Promise((resolve) => setImmediate(resolve));
  }
  pub.snapshot({ type: "round", version: 1 });
  pub.snapshot({ type: "round", version: 2 });
  pub.whisper("Uone", { type: "personal", message: "Your shield saved them" });
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body.message).version, 2);
  assert.deepEqual(
    calls.map((call) => call.claims.pubsub_perms.send),
    [["broadcast"], ["whisper-Uone"]],
  );
  assert.ok(calls[1].at - calls[0].at >= 1000);
  assert.ok(
    calls.every(
      (call) =>
        call.claims.role === "external" &&
        call.claims.user_id === "123" &&
        call.claims.channel_id === "456",
    ),
  );
  pub.close();
});

test("latency-aware loading gives an eight-second-behind viewer sixteen seconds with a hard trigger budget", () => {
  const f = roundFixture();
  assert.equal(f.rounds.deadline(0), 108000);
  assert.equal(f.rounds.deadline(8), 116000);
  f.setClock(108001);
  assert.throws(
    () =>
      f.rounds.select(identity(), f.action("aim", { latency: 0 }), "unused"),
    { code: "window_closed" },
  );
  f.rounds.select(identity(), f.action(), "unused");
  f.setClock(116000);
  assert.throws(() => f.rounds.select(identity(), f.action(), "unused"), {
    code: "window_closed",
  });
  f.inputs.close();
});

test("anonymous choices replace before lock, and a shared identity deduplicates chat plus extension once per round", async () => {
  const f = roundFixture();
  await f.inputs.receive("123456789", "!aim", "ChatName", () => true);
  assert.equal(f.inputs.magazine.length, 1);
  f.rounds.select(
    identity(),
    f.action("zone", { target: { x: 0.3, y: 0.7 } }),
    "forged-name",
  );
  assert.equal(f.inputs.magazine.length, 2);
  assert.equal(f.inputs.magazine[1].displayName, "a viewer");
  f.rounds.select(
    identity("Uone", "123456789"),
    f.action("rescue"),
    "SharedName",
  );
  assert.equal(f.inputs.magazine.length, 1);
  assert.equal(f.inputs.magazine[0].displayName, "SharedName");
  await f.inputs.receive("123456789", "!zone", "ChatName", () => true);
  assert.equal(f.inputs.magazine.length, 1);
  assert.equal(f.inputs.rows.at(-1).disposition, "extension selected");
  f.rounds.select(identity("Utwo", "123456789"), f.action("aim"), "SharedName");
  assert.equal(f.inputs.magazine.length, 1);
  assert.deepEqual(f.inputs.snapshot().counts, {
    shots: 1,
    traps: 0,
    shields: 0,
  });
  f.rounds.lock();
  f.inputs.drain();
  assert.throws(() => f.rounds.select(identity(), f.action(), "unused"), {
    code: "window_closed",
  });
  assert.equal(executionCredit("a viewer", "viewer"), "a viewer");
  f.inputs.close();
});

test("verified EBS actions use Helix-filtered shared names and never accept a client-provided name", async () => {
  const f = await httpFixture();
  try {
    const response = await f.request("/ebs/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + jwt({ user_id: "123456789" }),
      },
      body: JSON.stringify({
        roundId: f.service.rounds.id,
        intent: "aim",
        latency: 8,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(f.inputs.magazine[0].displayName, "SharedName");
    const names = new ExtensionNames(async () => "person@example.com");
    assert.equal(await names.get("123"), "a viewer");
    assert.equal(await names.get(null), "a viewer");
    const state = await (await f.request()).json();
    assert.ok(!JSON.stringify(state).includes("TWITCH_EXT_SECRET"));
  } finally {
    await f.close();
  }
});

test("extension target reaches actual worker physics and keeps the existing zone and shield caps", async () => {
  const f = roundFixture();
  f.rounds.select(
    identity(),
    f.action("zone", { target: { x: 0.25, y: 0.4 } }),
    "unused",
  );
  const worker = new Worker(
    new URL("../engine/live-worker.js", import.meta.url),
    {
      workerData: {
        source: "export default " + JSON.stringify(reference),
        assets: {},
      },
      execArgv: [],
    },
  );
  try {
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("No extension zone in worker")),
        3000,
      );
      worker.on("error", reject);
      worker.on("message", (message) => {
        if (message.rematch?.zones?.length) {
          clearTimeout(timer);
          resolve(message);
        }
      });
      worker.postMessage({ type: "magazine", inputs: f.inputs.drain() });
    });
    const zone = state.rematch.zones[0];
    assert.equal(zone.x, 265);
    assert.equal(zone.y, 250);
    assert.equal(zone.name, "a viewer");
    assert.equal(zone.actionId, "extension-1");
    assert.equal(zone.radius, 68);
    const game = createRematch(reference);
    assert.equal(
      game.input("one", "tap", "a viewer", "rescue", {
        source: "extension",
        actionId: "extension-1",
      }),
      true,
    );
    assert.equal(
      game.input("two", "tap", "a viewer", "rescue", {
        source: "extension",
        actionId: "extension-2",
      }),
      false,
    );
    assert.equal(game.state().rematch.rescue.totalCap, 3);
  } finally {
    await worker.terminate();
    f.inputs.close();
  }
});

test("personal impact credit uses action IDs rather than names and does not expose another viewer's result", () => {
  const f = roundFixture();
  for (const [opaque, intent] of [
    ["Uone", "aim"],
    ["Utwo", "rescue"],
    ["Uthree", "zone"],
  ])
    f.rounds.select(
      identity(opaque),
      f.action(intent, intent === "zone" ? { target: { x: 0.5, y: 0.5 } } : {}),
      "unused",
    );
  f.rounds.lock();
  f.rounds.observe({
    rematch: { rescue: { lastSave: { actionId: "extension-2" } } },
  });
  f.rounds.observe({
    result: "lose",
    rematch: { hit: { actionId: "extension-1", kind: "aimed" } },
  });
  assert.equal(
    f.rounds.result(identity("Uone"), f.rounds.id).kind,
    "execution",
  );
  assert.equal(f.rounds.result(identity("Utwo"), f.rounds.id).kind, "save");
  assert.equal(f.rounds.result(identity("Uthree"), f.rounds.id).kind, "miss");
  assert.equal(
    f.rounds.result(identity("Uother"), f.rounds.id).kind,
    "spectator",
  );
  assert.equal(f.push.whispers.length, 2);
  f.inputs.close();
});

test("public EBS/assets cannot expose local controls, setup, auth journal, or private files through a relay", async () => {
  const f = await httpFixture();
  try {
    for (const route of [
      "/controls",
      "/api/setup",
      "/runs/twitch-auth.jsonl",
      "/.env",
      "/extension/../.env",
    ])
      assert.equal(
        (
          await fetch(f.base + route, {
            headers: { "X-Forwarded-For": "203.0.113.1" },
          })
        ).status,
        404,
      );
    const asset = await fetch(f.base + "/extension/video_overlay.html", {
      headers: { "X-Forwarded-For": "203.0.113.1" },
    });
    assert.equal(asset.status, 200);
    assert.ok(
      asset.headers
        .get("Content-Security-Policy")
        .includes("https://extension-files.twitch.tv"),
    );
    assert.ok(!(await asset.text()).includes("operator-token"));
    assert.equal((await fetch(f.base + "/controls")).status, 200);
  } finally {
    await f.close();
  }
});

test("extension archive contains only the bundled upload frontend and no tokens, mocks or server source", async () => {
  const archive = await packageExtension("testdata/phase30/unit-extension.zip");
  const listing = execFileSync("unzip", ["-Z1", archive.output], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(listing, [...archive.files].sort());
  for (const file of archive.files) {
    const text = await readFile(path.join("extension", file), "utf8");
    assert.ok(!text.includes("TWITCH_EXT_SECRET"));
    assert.ok(!text.includes("eval("));
  }
  const childEnv = codexEnvironment({
    TWITCH_EXT_SECRET: "mock-only",
    TWITCH_EXT_CLIENT_ID: "mock",
    TWITCH_EXT_OWNER_ID: "123",
  });
  assert.equal(childEnv.TWITCH_EXT_SECRET, undefined);
  assert.equal(childEnv.TWITCH_EXT_CLIENT_ID, undefined);
});

test("sample/setup/private rounds do not publish or lengthen their original loading window", () => {
  const f = roundFixture();
  f.rounds.begin(f.inputs, f.now() + 26500, { allowed: false });
  f.rounds.open();
  f.rounds.vision({ culprit: "private" });
  assert.equal(f.rounds.enabled, false);
  assert.equal(f.rounds.waitMs(), 0);
  assert.equal(f.rounds.snapshot().phase, "idle");
  const before = f.push.snapshots.length;
  f.rounds.changed();
  assert.equal(f.push.snapshots.length, before);
  f.inputs.close();
});

test("reference physics retain all existing twenty-one validator proofs with extension metadata absent", () => {
  const proof = proveRematch("export default " + JSON.stringify(reference));
  assert.equal(proof.length, 21);
});

test("real collisions give personal shot, trap and shield credit to the exact anonymous action", () => {
  for (const mode of ["aim", "zone", "rescue"]) {
    const f = roundFixture();
    f.rounds.select(
      identity(),
      f.action(
        mode,
        mode === "zone" ? { target: { x: 170 / 860, y: 0.5 } } : {},
      ),
      "unused",
    );
    f.rounds.lock();
    const game = createRematch(reference);
    const metadata = {
      source: "extension",
      actionId: "extension-1",
      target: { x: 170 / 860, y: 0.5 },
    };
    if (mode !== "rescue")
      game.input("ext:uone", "tap", "a viewer", mode, metadata);
    else game.input("attacker", "!aim", "Attacker", "aim");
    for (let tick = 0; tick < 300 && !game.state().result; tick++) {
      if (mode === "rescue" && tick === 100)
        game.input("ext:uone", "tap", "a viewer", "rescue", metadata);
      game.control({ x: 0, y: 0 });
      game.step();
      f.rounds.observe(game.state());
    }
    assert.equal(
      f.rounds.result(identity(), f.rounds.id).kind,
      { aim: "execution", zone: "trap", rescue: "save" }[mode],
    );
    f.inputs.close();
  }
});

test("RoundController opens extension loading, locks it before play, and drains the same authoritative worker", async () => {
  let clock = Date.now();
  const push = publisher();
  const extension = new ExtensionRounds({
    enabled: true,
    publisher: push,
    now: () => clock,
  });
  const record = {
    id: "1793400000000-extension",
    assets: {},
    snapshots: [],
    integrations: {},
  };
  const packets = [];
  const round = new RoundController({
    env: { INTRO_SECONDS: "0", DEMO_TEMPLATE: "1" },
    decisions: new DecisionsClient({ enabled: false, keyReader: () => null }),
    extension,
    broadcast: (message) => packets.push(message),
    logger: { error() {} },
    museum: {
      archive: async () => record,
      write: async () => {},
      score: async () => ({}),
    },
    captureFn: async ({ onFrame }) => {
      onFrame({ index: 0, frame: "assets/sample/frame.png" });
      extension.select(
        identity(),
        { roundId: extension.id, intent: "aim", latency: 8 },
        "unused",
      );
      clock += 16000;
      return { pack: "assets/sample", metadata: { mode: "mock-obs" } };
    },
    generateFn: async () => ({
      source: "export default " + JSON.stringify(reference),
      assets: {},
      log: {
        id: record.id,
        validation: { ok: true },
        event: { culprit: "hammer" },
      },
    }),
  });
  try {
    await round.trigger({ type: "operator" });
    const end = Date.now() + 3000;
    while (
      !packets.some((packet) => packet.rematch?.fired === 1) &&
      Date.now() < end
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      packets.some(
        (packet) => packet.rematch?.shots[0]?.actionId === "extension-1",
      ),
    );
    assert.equal(extension.phase, "play");
    assert.equal(round.participation.snapshot().counts.shots, 1);
    assert.ok(record.timings.trigger_to_play_ms < 30000);
  } finally {
    round.close();
  }
});

test("case-sensitive anonymous opaque IDs remain separate identities and private results", () => {
  const f = roundFixture();
  f.rounds.select(identity("UCase"), f.action("aim"), "unused");
  f.rounds.select(identity("Ucase"), f.action("rescue"), "unused");
  assert.equal(f.inputs.magazine.length, 2);
  assert.notEqual(f.inputs.magazine[0].user, f.inputs.magazine[1].user);
  f.rounds.lock();
  f.rounds.observe({
    result: "lose",
    rematch: { hit: { actionId: "extension-1" } },
  });
  assert.equal(
    f.rounds.result(identity("UCase"), f.rounds.id).kind,
    "execution",
  );
  assert.equal(f.rounds.result(identity("Ucase"), f.rounds.id).kind, "miss");
  f.inputs.close();
});
