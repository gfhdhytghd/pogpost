import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { DecisionsClient } from "../server/decisions.js";
import { DecisionsTransport } from "../server/decisions-transport.js";
import { DecisionsMetrics } from "../server/decisions-metrics.js";
import { Participation } from "../server/participation.js";
import { RoundController } from "../server/round.js";
import { ConfigStore } from "../server/config.js";
import { SetupService } from "../server/setup.js";

const answer = (choice = "aim") => ({ ok: true,
  json: async () => ({ answers: [{ choice, confidence: 0.98 }] }) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "Mock operation did not settle");
    await pause(5);
  }
}

test("native HTTPS transport reuses one authenticated TLS connection and recovers from provider errors", async () => {
  await mkdir("testdata/phase28", { recursive: true });
  const folder = await mkdtemp(path.resolve("testdata/phase28/tls-"));
  const key = path.join(folder, "local.key"), cert = path.join(folder, "local.pem");
  // Disposable local mock certificate; no real credential enters this child.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", key, "-out", cert], { stdio: "ignore", env: { PATH: process.env.PATH } });
  let connections = 0;
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    assert.equal(req.url, "/v1/decisions");
    assert.equal(req.headers.authorization, "Bearer local-mock-only");
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    if (data.input[0].content.includes("reject")) {
      res.writeHead(429); res.end("private provider detail must not escape"); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ answers: [{ choice: "ignore", confidence: 0.99 }] }));
  });
  server.on("secureConnection", () => { connections++; });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  assert.ok(![8787, 8911].includes(port));
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1,
    maxFreeSockets: 1, ca: await readFile(cert) });
  const transport = new DecisionsTransport({ agent,
    requestFn: (_, options, callback) => https.request(`https://127.0.0.1:${port}/v1/decisions`, options, callback) });
  const client = new DecisionsClient({ keyReader: () => "local-mock-only", fetchFn: transport.fetch.bind(transport) });
  try {
    const cold = await client.warmup();
    assert.equal(cold.source, "decisions");
    assert.equal(cold.connection.reused, false);
    assert.ok(cold.connection.connect_ms >= 0);
    const warm = await client.classify("hello");
    assert.equal(warm.source, "decisions");
    assert.equal(warm.connection.reused, true);
    assert.equal(connections, 1);
    const error = await client.classify("reject");
    assert.equal(error.reason, "service error");
    assert.equal(client.state().status, "degraded");
    assert.ok(!JSON.stringify(error).includes("private provider detail"));
    assert.equal((await client.classify("hello")).connection.reused, true);
    assert.equal(client.state().status, "ready");
    assert.equal(connections, 1);
    assert.equal(client.state().rolling.samples, 3, "Warm-up must not skew chat latency/fallback metrics");
  } finally {
    client.close(); transport.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("replay/live budgets start before fetch setup and can be configured without changing models", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const [phase, budget] of [["replay", 1500], ["play", 500]]) {
      let signal;
      const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: async (_, init) => {
        signal = init.signal;
        context.mock.timers.tick(budget);
        return new Promise(() => {});
      } });
      const row = await client.classify("!save", {}, { phase });
      assert.equal(row.deadline_ms, budget);
      assert.equal(row.reason, "timeout");
      assert.ok(signal.aborted);
      client.configure({ replayMs: 1800, playMs: 650 });
      assert.deepEqual(client.state().deadlines, { replayMs: 1800, playMs: 650 });
      assert.throws(() => client.configure({ replayMs: 1800, playMs: 50 }));
      assert.equal(client.state().deadlines.playMs, 650, "Invalid patch must be atomic");
      client.close();
    }
  } finally { context.mock.timers.reset(); }
});

test("eight in-flight calls bound work and excess immediately uses rules", async () => {
  const releases = [];
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: () =>
    new Promise((resolve) => releases.push(resolve)) });
  try {
    const pending = Array.from({ length: 8 }, () => client.classify("roast"));
    assert.equal(client.state().in_flight, 8);
    const overflow = await client.classify("!zone");
    assert.equal(overflow.source, "rules");
    assert.equal(overflow.reason, "busy");
    assert.equal(overflow.intent, "zone");
    assert.equal(releases.length, 8);
    for (const release of releases) release(answer());
    assert.ok((await Promise.all(pending)).every((row) => row.source === "decisions"));
    assert.equal(client.state().in_flight, 0);
    assert.equal(client.state().rolling.fallbacks, 1);
  } finally { client.close(); }
});

test("same-viewer bursts classify only the latest queued text and discard stale in-flight intent", async () => {
  const sent = [], texts = [];
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: async (_, init) => {
    texts.push(JSON.parse(JSON.parse(init.body).input[0].content).message);
    return answer("rescue");
  } });
  const p = new Participation(client);
  p.start();
  try {
    const pending = [];
    for (let index = 0; index < 10; index++)
      pending.push(p.receive("same", index === 9 ? "!save" : "!aim", "Same", () => true,
        (input) => { sent.push(input); return true; }));
    await Promise.all(pending);
    assert.deepEqual(texts, ["!save"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].intent, "rescue");
    assert.equal(p.rows.filter((row) => row.disposition === "superseded").length, 9);
    assert.equal(client.state().rolling.coalesced, 9);
  } finally { p.close(); client.close(); }
  let release;
  const activeClient = new DecisionsClient({ keyReader: () => "mock", fetchFn: async (_, init) => {
    const text = JSON.parse(JSON.parse(init.body).input[0].content).message;
    if (text === "old") return new Promise((resolve) => { release = resolve; });
    return answer("rescue");
  } });
  const active = new Participation(activeClient);
  active.start();
  const delivered = [];
  try {
    const first = active.receive("same", "old", "Same", () => true,
      (input) => { delivered.push(input); return true; });
    await until(() => release);
    const next = active.receive("same", "!save", "Same", () => true,
      (input) => { delivered.push(input); return true; });
    release(answer("aim"));
    await Promise.all([first, next]);
    assert.equal(active.rows[0].disposition, "superseded");
    assert.deepEqual(delivered.map((row) => row.intent), ["rescue"]);
  } finally { active.close(); activeClient.close(); }
});

test("a queued live message never waits for an older replay request's longer budget", async () => {
  let phase = "replay", release, calls = 0;
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  } });
  const p = new Participation(client, () => {}, { phase: () => phase });
  p.start();
  const sent = [];
  try {
    const old = p.receive("same", "old roast", "Same", () => true,
      (input) => { sent.push(input); return true; });
    await until(() => release);
    phase = "play";
    const start = performance.now();
    const latest = p.receive("same", "!save", "Same", () => true,
      (input) => { sent.push(input); return true; });
    client.configure({ playMs: 1000 });
    await latest;
    assert.ok(performance.now() - start < 900);
    assert.equal(calls, 1, "Expired queue entry must not make another provider request");
    assert.equal(p.rows[1].source, "rules");
    assert.equal(p.rows[1].deadline_ms, 500);
    assert.deepEqual(sent.map((row) => row.intent), ["rescue"]);
    release(answer("aim"));
    await old;
    assert.equal(p.rows[0].disposition, "superseded");
  } finally { p.close(); client.close(); }
});

test("rolling p50/p95/fallback rates use bounded chat rows, with per-phase breakdown", () => {
  const metrics = new DecisionsMetrics();
  for (let index = 1; index <= 110; index++) metrics.add({
    phase: index % 2 ? "replay" : "play", latency_ms: index,
    source: index % 10 ? "decisions" : "rules",
  });
  const value = metrics.state();
  assert.equal(value.samples, 100);
  assert.equal(value.p50_ms, 60);
  assert.equal(value.p95_ms, 105);
  assert.equal(value.fallback_rate, 0.1);
  assert.equal(value.play.samples, 50);
  assert.equal(value.replay.samples, 50);
});

test("capture starts a single tiny warm-up without waiting and cancellation closes it", async () => {
  const order = [];
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.input[0].content.includes("warm-up"));
    assert.equal(body.questions[0].choices.length, 2);
    order.push("warmup");
    return new Promise(() => {});
  } });
  const round = new RoundController({ decisions: client, env: {}, museum: {}, broadcast() {}, logger: { error() {} },
    captureFn: async () => { order.push("capture"); throw Error("mock capture cancellation"); } });
  try {
    await round.trigger({ type: "unit" });
    await until(() => !client.state().warming);
    assert.deepEqual(order, ["warmup", "capture"]);
    assert.equal(client.state().warmup.reason, "closed");
    assert.equal(client.state().rolling.samples, 0);
  } finally { round.close(); }
});

test("authenticated settings validate/persist budgets atomically and survive a fresh client", async () => {
  await mkdir("testdata/phase28", { recursive: true });
  const folder = await mkdtemp(path.resolve("testdata/phase28/config-"));
  const config = await new ConfigStore(folder, {}).load();
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: async () => answer() });
  const setup = new SetupService({ root: folder, env: {}, config, decisions: client, features: {} });
  try {
    await setup.handle("POST", "/api/setup/decisions", { enabled: false, replayMs: 1900, playMs: 600 });
    assert.deepEqual(setup.state().decisions.deadlines, { replayMs: 1900, playMs: 600 });
    await assert.rejects(setup.handle("POST", "/api/setup/decisions", { enabled: true, playMs: 9000 }));
    assert.equal(client.enabled, false);
    assert.equal(client.deadlines.playMs, 600);
    await assert.rejects(setup.handle("POST", "/api/setup/decisions", { endpoint: "bad" }));
    const loaded = await new ConfigStore(folder, {}).load();
    const restored = new DecisionsClient({ keyReader: () => "", deadlines: loaded.value.decisionsDeadlines });
    assert.deepEqual(restored.deadlines, { replayMs: 1900, playMs: 600 });
    restored.close();
  } finally { setup.close(); client.close(); }
});

test("typed choices preserve reported confidence while ordinary chatter and negation stay inert", async () => {
  const cases = new Map([
    ["That hammer owns you", ["aim", 0.72]],
    ["You got this, shield our runner", ["rescue", 0.44]],
    ["Drop a zone on the path", ["zone", 0.73]],
    ["How long is the stream", ["ignore", 0.93]],
    ["don't shield him", ["ignore", 0.53]],
  ]);
  const client = new DecisionsClient({ keyReader: () => "mock", fetchFn: async (_, init) => {
    const message = JSON.parse(JSON.parse(init.body).input[0].content).message;
    const [choice, confidence] = cases.get(message);
    return { ok: true, json: async () => ({ answers: [{ choice, confidence }] }) };
  } });
  const p = new Participation(client);
  p.start();
  const actions = [];
  try {
    let index = 0;
    for (const [message, [intent, confidence]] of cases) {
      await p.receive("viewer-" + index++, message, "Viewer", () => true,
        (input) => { actions.push(input); return true; });
      assert.equal(p.rows.at(-1).intent, intent);
      assert.equal(p.rows.at(-1).confidence, confidence);
      assert.equal(p.rows.at(-1).source, "decisions");
    }
    assert.deepEqual(actions.map((row) => row.intent), ["aim", "rescue", "zone"]);
    assert.equal(p.rows.filter((row) => row.disposition === "ignored").length, 2);
  } finally { p.close(); client.close(); }
});
