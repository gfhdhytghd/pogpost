import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TwitchAPI,
  saveEnv,
  deviceAuthorize,
  inspectAuthorization,
} from "../server/twitch-api.js";
import { TwitchAuthLog, tokenHash } from "../server/twitch-auth-log.js";
import { TwitchCredentials } from "../server/twitch-credentials.js";
import { readEnv } from "../server/env-store.js";
import { monitorTwitchAuth } from "../server/twitch-lifecycle.js";
import { ConfigStore } from "../server/config.js";
import { SetupService } from "../server/setup.js";

async function fixture() {
  await mkdir("testdata/phase29", { recursive: true });
  const root = await mkdtemp(path.resolve("testdata/phase29/auth-"));
  const file = path.join(root, ".env");
  const env = {
    TWITCH_CLIENT_ID: "mock-client",
    TWITCH_USER_ID: "mock-user",
    TWITCH_BROADCASTER_ID: "mock-user",
    TWITCH_TOKEN: "mock-access-old",
    TWITCH_REFRESH_TOKEN: "mock-refresh-old",
  };
  await saveEnv(file, { ...env, KEEP: "untouched" });
  const journal = new TwitchAuthLog(path.join(root, "runs/twitch-auth.jsonl"));
  return { root, file, env, journal };
}
const fresh = () =>
  Response.json({
    access_token: "mock-access-new",
    refresh_token: "mock-refresh-new",
    expires_in: 14400,
  });
async function rows(journal) {
  return (await readFile(journal.file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("rotation commits durably, logs hashes/status/expiry, and never logs tokens or provider error bodies", async () => {
  const f = await fixture();
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    fetcher: async () => fresh(),
  });
  await api.refresh("startup");
  const saved = await readEnv(f.file);
  assert.equal(saved.TWITCH_TOKEN, "mock-access-new");
  assert.equal(saved.TWITCH_REFRESH_TOKEN, "mock-refresh-new");
  assert.equal(saved.KEEP, "untouched");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.ok(Number(saved.TWITCH_EXPIRES_AT) > Date.now());
  const events = await rows(f.journal);
  const response = events.find(
    (row) => row.event === "refresh" && row.phase === "response",
  );
  assert.equal(response.http_status, 200);
  assert.equal(response.expires_in, 14400);
  assert.equal(response.refresh_returned, true);
  assert.equal(response.refresh_rotated, true);
  assert.equal(response.access_hash, tokenHash("mock-access-new"));
  assert.equal(response.previous_refresh_hash, tokenHash("mock-refresh-old"));
  assert.ok(
    events.some((row) => row.event === "persist" && row.phase === "committed"),
  );
  const text = await readFile(f.journal.file, "utf8");
  for (const value of [
    "mock-access-old",
    "mock-access-new",
    "mock-refresh-old",
    "mock-refresh-new",
  ])
    assert.ok(!text.includes(value));
  assert.ok(
    events.every(
      (row) => row.pid === process.pid && row.timestamp && row.trigger,
    ),
  );
});

test("concurrent refreshes and late 401s share a rotation rather than spending the new refresh twice", async () => {
  const f = await fixture();
  let calls = 0;
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return fresh();
    },
  });
  await Promise.all([api.refresh("401"), api.refresh("startup")]);
  assert.equal(calls, 1);
  await api.refresh("401", "mock-access-old");
  assert.equal(calls, 1);
  assert.equal(f.env.TWITCH_REFRESH_TOKEN, "mock-refresh-new");
  assert.ok(
    (await rows(f.journal)).some((row) => row.phase === "peer-adopted"),
  );
});

test("separate API instances re-read the locked file and adopt the winner's rotated pair", async () => {
  const f = await fixture();
  let calls = 0;
  const fetcher = async (_, request) => {
    calls++;
    assert.equal(request.body.get("refresh_token"), "mock-refresh-old");
    await new Promise((resolve) => setTimeout(resolve, 30));
    return fresh();
  };
  const a = new TwitchAPI(
    { ...f.env },
    { envFile: f.file, journal: f.journal, fetcher },
  );
  const b = new TwitchAPI(
    { ...f.env },
    { envFile: f.file, journal: f.journal, fetcher },
  );
  await Promise.all([a.refresh("startup"), b.refresh("401")]);
  assert.equal(calls, 1);
  assert.equal(b.env.TWITCH_TOKEN, "mock-access-new");
  assert.equal(a.env.TWITCH_TOKEN, b.env.TWITCH_TOKEN);
});

test("dead refresh or an uncertain prior attempt requires device authorization without automatic respend", async () => {
  const f = await fixture();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("private rejected credential", { status: 400 });
  };
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    fetcher,
  });
  await assert.rejects(api.refresh("expiry"), /needs re-authorization/);
  assert.equal(api.authState().status, "reauthorization-required");
  const restarted = new TwitchAPI(
    { ...f.env },
    { envFile: f.file, journal: f.journal, fetcher },
  );
  await assert.rejects(restarted.validateToken(), /needs re-authorization/);
  await assert.rejects(restarted.refresh(), /needs re-authorization/);
  assert.equal(calls, 1);
  const text = await readFile(f.journal.file, "utf8");
  assert.ok(!text.includes("private rejected credential"));
  assert.ok(
    (await rows(f.journal)).some(
      (row) => row.event === "failure" && row.http_status === 400,
    ),
  );
});

test("proactive refresh uses expires_in ten minutes early and keeps hourly validation", async () => {
  const f = await fixture();
  let clock = 1000000,
    refreshes = 0;
  const timers = new Map();
  let id = 0;
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    now: () => clock,
    fetcher: async (url) => {
      if (url.endsWith("/token")) {
        refreshes++;
        return fresh();
      }
      return Response.json({
        client_id: "mock-client",
        user_id: "mock-user",
        expires_in: 3600,
      });
    },
  });
  await api.validateToken("startup");
  const stop = monitorTwitchAuth(api, {
    now: () => clock,
    setTimer: (fn, ms) => {
      const key = ++id;
      timers.set(key, { fn, ms });
      return key;
    },
    clearTimer: (key) => timers.delete(key),
  });
  try {
    const expiry = [...timers.values()].find((timer) => timer.ms === 3000000);
    assert.ok(
      expiry,
      "A 3600s lifetime must refresh at 3000s, not at the hourly validation",
    );
    assert.ok([...timers.values()].some((timer) => timer.ms === 3600000));
    api.publish("degraded", "validation-unavailable");
    assert.ok(
      [...timers.values()].includes(expiry),
      "A transient hourly failure must not remove proactive refresh",
    );
    clock += expiry.ms;
    expiry.fn();
    const deadline = Date.now() + 3000;
    while (!refreshes && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    while (api.refreshing) await api.refreshing;
    assert.equal(refreshes, 1);
    assert.ok(
      (await rows(f.journal)).some(
        (row) => row.event === "refresh" && row.trigger === "expiry",
      ),
    );
  } finally {
    stop();
  }
});

test("a crash after refresh before save leaves an explicit uncertain marker; a new Device pair recovers", async () => {
  const f = await fixture();
  const store = new TwitchCredentials(f.file, { journal: f.journal });
  await assert.rejects(
    store.refresh(f.env, f.env.TWITCH_TOKEN, "startup", async () => {
      throw Error("simulated lost response after provider spent token");
    }),
  );
  await assert.rejects(store.load({ ...f.env }), /needs re-authorization/);
  const values = {
    ...f.env,
    TWITCH_TOKEN: "mock-device-access",
    TWITCH_REFRESH_TOKEN: "mock-device-refresh",
  };
  await store.install(values);
  const adopted = await store.load({ ...f.env });
  assert.equal(adopted.TWITCH_TOKEN, "mock-device-access");
  assert.equal(adopted.TWITCH_REFRESH_TOKEN, "mock-device-refresh");
});

test("recovery route uses saved Client ID, preserves consent scopes, and never exposes OAuth tokens", async () => {
  const f = await fixture();
  const config = await new ConfigStore(f.root, f.env).load();
  let finish;
  const setup = new SetupService({
    root: f.root,
    env: f.env,
    config,
    features: { configure() {}, refresh() {} },
    authorize: async (_, options) => {
      options.onCode({
        verification_uri: "https://www.twitch.tv/activate",
        user_code: "MOCK-29",
        expires_in: 600,
      });
      await new Promise((resolve) => {
        finish = resolve;
      });
      return {
        access_token: "mock-device-access",
        refresh_token: "mock-device-refresh",
      };
    },
    apiFactory: () => ({
      authBase: "https://mock.invalid",
      fetcher: async () =>
        Response.json({
          client_id: "mock-client",
          user_id: "mock-user",
          scopes: [
            "user:read:chat",
            "user:write:chat",
            "user:bot",
            "clips:edit",
            "channel:read:redemptions",
          ],
        }),
      identity: async () => ({
        login: "MockStreamer",
        scopes: [],
        eligible: false,
      }),
    }),
  });
  try {
    setup.twitch.status = "reauthorization-required";
    const result = await setup.handle(
      "POST",
      "/api/setup/twitch/reauthorize",
      {},
    );
    assert.equal(result.flow.userCode, "MOCK-29");
    assert.ok(!JSON.stringify(setup.state()).includes("mock-device-access"));
    finish();
    await setup.authorization;
    assert.equal(setup.state().twitch.status, "authorized");
    assert.equal((await readEnv(f.file)).TWITCH_TOKEN, "mock-device-access");
    assert.ok(!JSON.stringify(setup.state()).includes("mock-device-refresh"));
  } finally {
    setup.close();
  }
});

async function processHarness(f, { hold = false } = {}) {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  let calls = 0,
    activeRefresh = "mock-refresh-old",
    activeAccess = "mock-access-old",
    release;
  const spent = new Set();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const refresh = new URLSearchParams(body).get("refresh_token");
    calls++;
    if (refresh !== activeRefresh || spent.has(refresh)) {
      response.writeHead(400);
      response.end("{}");
      return;
    }
    spent.add(refresh);
    activeRefresh = "mock-refresh-new";
    activeAccess = "mock-access-new";
    if (hold)
      await new Promise((resolve) => {
        release = resolve;
      });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        access_token: activeAccess,
        refresh_token: activeRefresh,
        expires_in: 14400,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.ok(![8787, 8911].includes(port));
  const children = [];
  function start(mode = "normal") {
    const child = spawn(
      process.execPath,
      [
        path.resolve("test/fixtures/twitch-refresh-process.mjs"),
        f.root,
        `http://127.0.0.1:${port}`,
        mode,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    );
    const state = { child, output: "", error: "", exit: null };
    state.closed = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        state.exit = { code, signal };
        resolve();
      }),
    );
    child.stdout.on("data", (chunk) => {
      state.output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      state.error += chunk;
    });
    children.push(state);
    return state;
  }
  async function waitFor(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Mock child process did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return {
    start,
    waitFor,
    calls: () => calls,
    spent,
    activeAccess: () => activeAccess,
    release: () => release?.(),
    async close() {
      release?.();
      for (const state of children)
        if (!state.exit) state.child.kill("SIGKILL");
      await Promise.all(children.map((state) => state.closed));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("two real processes serialize a one-time rotating refresh under the same kernel lock", async () => {
  const f = await fixture(),
    h = await processHarness(f);
  try {
    const a = h.start(),
      b = h.start();
    await h.waitFor(
      () => a.output.includes("ready") && b.output.includes("ready"),
    );
    a.child.stdin.write("go\n");
    b.child.stdin.write("go\n");
    await Promise.all([a.closed, b.closed]);
    assert.equal(h.calls(), 1);
    assert.ok(a.output.includes("saved") && b.output.includes("saved"));
    assert.equal(a.error + b.error, "");
    const log = await rows(f.journal);
    assert.ok(new Set(log.map((row) => row.pid)).size >= 2);
    assert.equal(
      (await readEnv(f.file)).TWITCH_REFRESH_TOKEN,
      "mock-refresh-new",
    );
  } finally {
    await h.close();
  }
});

test("restart while refresh is in progress waits for graceful drain and adopts the saved pair", async () => {
  const f = await fixture(),
    h = await processHarness(f, { hold: true });
  try {
    const old = h.start();
    await h.waitFor(() => old.output.includes("ready"));
    old.child.stdin.write("go\n");
    await h.waitFor(() => h.calls() === 1);
    old.child.kill("SIGTERM");
    const next = h.start();
    await h.waitFor(() => next.output.includes("ready"));
    next.child.stdin.write("go\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.calls(), 1);
    h.release();
    await Promise.all([old.closed, next.closed]);
    assert.ok(old.output.includes("saved") && next.output.includes("saved"));
    assert.equal(h.calls(), 1);
    assert.equal(old.error + next.error, "");
  } finally {
    await h.close();
  }
});

test("SIGKILL after the provider responds but before save explains a dead saved pair and fences restart", async () => {
  const f = await fixture(),
    h = await processHarness(f);
  await saveEnv(f.file, { TWITCH_EXPIRES_AT: String(Date.now() - 1000) });
  try {
    const dying = h.start("crash-after-response");
    await h.waitFor(() => dying.output.includes("ready"));
    dying.child.stdin.write("go\n");
    await h.waitFor(() => dying.output.includes("response-received"));
    dying.child.kill("SIGKILL");
    await dying.closed;
    const saved = await readEnv(f.file);
    assert.ok(
      Number(saved.TWITCH_EXPIRES_AT) < Date.now(),
      "The saved access token was already expired",
    );
    assert.ok(
      saved.TWITCH_TOKEN !== h.activeAccess(),
      "Saved access remains old while provider has issued a new pair",
    );
    assert.ok(
      h.spent.has(saved.TWITCH_REFRESH_TOKEN),
      "Saved refresh has already been consumed",
    );
    const restarted = h.start();
    await h.waitFor(() => restarted.output.includes("ready"));
    restarted.child.stdin.write("go\n");
    await restarted.closed;
    assert.ok(restarted.output.includes("reauthorize"));
    assert.equal(
      h.calls(),
      1,
      "Restart must never retry the consumed refresh token",
    );
    const log = await rows(f.journal);
    assert.ok(!log.some((row) => row.event === "persist"));
    assert.ok(log.some((row) => row.reason === "refresh-outcome-uncertain"));
  } finally {
    await h.close();
  }
});

test("a generic env writer in another process cannot overwrite a refresh with a stale whole-file snapshot", async () => {
  const f = await fixture(),
    h = await processHarness(f, { hold: true });
  try {
    const refresh = h.start();
    await h.waitFor(() => refresh.output.includes("ready"));
    refresh.child.stdin.write("go\n");
    await h.waitFor(() => h.calls() === 1);
    const writer = h.start("save-other");
    await h.waitFor(() => writer.output.includes("ready"));
    writer.child.stdin.write("go\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!writer.output.includes("saved"));
    h.release();
    await Promise.all([refresh.closed, writer.closed]);
    const saved = await readEnv(f.file);
    assert.equal(saved.TWITCH_TOKEN, "mock-access-new");
    assert.equal(saved.TWITCH_REFRESH_TOKEN, "mock-refresh-new");
    assert.equal(saved.OBS_PASSWORD, "mock-camera-password");
  } finally {
    await h.close();
  }
});

test("legacy unlocked whole-file overwrite can reproduce a spent refresh on disk; atomic rename alone cannot prevent it", async () => {
  const { atomicPrivateFile } = await import("../server/env-store.js");
  const f = await fixture();
  await saveEnv(f.file, { TWITCH_EXPIRES_AT: String(Date.now() - 1000) });
  const stale = await readFile(f.file, "utf8");
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    fetcher: async () => fresh(),
  });
  await api.refresh("401");
  // Reproduce the old algorithm: another process read before rotation, then renamed afterwards.
  await atomicPrivateFile(
    f.file,
    stale + '\nOBS_PASSWORD="mock-camera-password"\n',
  );
  const saved = await readEnv(f.file);
  assert.equal(saved.TWITCH_REFRESH_TOKEN, "mock-refresh-old");
  assert.ok(saved.TWITCH_REFRESH_TOKEN !== f.env.TWITCH_REFRESH_TOKEN);
  assert.ok(Number(saved.TWITCH_EXPIRES_AT) < Date.now());
});

test("validation audit hashes identify the token actually sent despite a concurrent rotation", async () => {
  const f = await fixture();
  let release, requested;
  const api = new TwitchAPI(f.env, {
    envFile: f.file,
    journal: f.journal,
    fetcher: async (url, options) => {
      if (url.endsWith("/token")) return fresh();
      if (options.headers.Authorization.includes("mock-access-old")) {
        requested = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        return Response.json({}, { status: 401 });
      }
      return Response.json({
        client_id: "mock-client",
        user_id: "mock-user",
        expires_in: 14400,
      });
    },
  });
  const validation = api.validateToken("startup");
  while (!requested) await new Promise((resolve) => setTimeout(resolve, 5));
  await api.refresh("expiry");
  release();
  await validation;
  const log = await rows(f.journal);
  const failedValidation = log.find(
    (row) => row.event === "validate" && row.http_status === 401,
  );
  assert.equal(failedValidation.access_hash, tokenHash("mock-access-old"));
  assert.ok(
    log.some(
      (row) =>
        row.event === "validate" &&
        row.access_hash === tokenHash("mock-access-new") &&
        row.http_status === 200,
    ),
  );
  assert.equal(
    log.filter((row) => row.event === "refresh" && row.phase === "request")
      .length,
    1,
  );
});

test("malformed Device responses expose fixed errors and retain HTTP status without response fragments", async () => {
  const f = await fixture();
  const malformed = () =>
    new Response("private-fixture-response", { status: 200 });
  await assert.rejects(
    deviceAuthorize("mock-client", {
      fetcher: async () => malformed(),
      authBase: "https://mock.invalid",
      journal: f.journal,
    }),
    { message: "Twitch device authorization failed; request a new code" },
  );
  await assert.rejects(
    inspectAuthorization(
      { fetcher: async () => malformed(), authBase: "https://mock.invalid" },
      {
        access_token: "mock-device-access",
        refresh_token: "mock-device-refresh",
      },
      f.journal,
      "mock-client",
    ),
    { message: "Twitch needs re-authorization" },
  );
  const text = await readFile(f.journal.file, "utf8");
  for (const value of [
    "private-fixture-response",
    "mock-device-access",
    "mock-device-refresh",
  ])
    assert.ok(!text.includes(value));
  assert.equal(
    (await rows(f.journal)).filter(
      (row) => row.event === "failure" && row.http_status === 200,
    ).length,
    2,
  );
});
