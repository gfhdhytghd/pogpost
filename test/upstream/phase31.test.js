import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { createHTTP } from "../server/http.js";
import {
  publicMuseumFixture,
  PUBLIC_ROUND,
  PRIVATE_ROUND,
  canary,
} from "./fixtures/public-museum.mjs";

const forwarded = { "X-Forwarded-For": "203.0.113.20" };
async function fixture() {
  const data = await publicMuseumFixture();
  const server = createHTTP(data.root, data.museum);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.ok(![8787, 8911].includes(port));
  const base = `http://127.0.0.1:${port}`;
  return {
    ...data,
    server,
    base,
    request: (route, options = {}) =>
      fetch(base + route, {
        ...options,
        headers: { ...forwarded, ...options.headers },
      }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("forwarded GET/HEAD reach the museum, inspector and every required read-only asset", async () => {
  const f = await fixture();
  try {
    const routes = [
      "/museum",
      "/api/museum",
      "/api/museum/" + PUBLIC_ROUND,
      "/inspect/" + PUBLIC_ROUND,
      "/api/inspect/" + PUBLIC_ROUND,
      "/overlay/museum.js",
      "/overlay/museum.css",
      "/overlay/render.js",
      "/overlay/inspect.js",
      "/overlay/inspect.css",
      "/overlay/demo-backdrop.svg",
      "/engine/content.js",
      "/assets/sample/frame.png",
      "/assets/illustration/face.svg",
      "/assets/captures/public/frame.png",
      "/assets/captures/public/voice.wav",
      ...[
        "frame.png",
        "strip-0.jpg",
        "face.png",
        "culprit.png",
        "voice.wav",
        "chat.txt",
        "transcript.txt",
        "level.js",
      ].map((file) => `/museum/${PUBLIC_ROUND}/${file}`),
    ];
    for (const route of routes) {
      const get = await f.request(route);
      assert.equal(get.status, 200, route);
      const head = await f.request(route, { method: "HEAD" });
      assert.equal(head.status, 200, route);
      assert.equal(await head.text(), "");
      assert.equal(
        head.headers.get("content-type"),
        get.headers.get("content-type"),
      );
      assert.ok(Number(head.headers.get("content-length")) > 0);
    }
    assert.equal(
      (
        await f.request("/museum", {
          headers: { Host: "twitchapi.wilflin.me" },
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("forwarded museum POST/PUT/DELETE are read-only while operator and socket routes remain private", async () => {
  const f = await fixture();
  try {
    for (const method of ["POST", "PUT", "DELETE"])
      for (const route of [
        "/museum",
        "/api/museum",
        `/api/museum/${PUBLIC_ROUND}`,
        `/inspect/${PUBLIC_ROUND}`,
        `/api/inspect/${PUBLIC_ROUND}`,
        "/overlay/museum.js",
        `/museum/${PUBLIC_ROUND}/frame.png`,
      ])
        assert.equal((await f.request(route, { method })).status, 405, route);
    for (const route of [
      "/controls",
      "/api/setup",
      "/api/setup/twitch/reauthorize",
      "/ws",
      "/ws/controls",
      "/",
      "/overlay/controls.html",
      "/overlay/controls.js",
      "/overlay/controls.css",
      "/overlay/controls-setup.js",
      "/overlay/controls-twitch.js",
      "/overlay/control-status.js",
      "/overlay/operator.js",
      "/overlay/rematch-pad.js",
      "/overlay/app.js",
      "/server/controls-recovery.js",
      "/.env",
      "/config.json",
      "/runs/twitch-auth.jsonl",
    ])
      assert.equal((await f.request(route)).status, 404, route);
  } finally {
    await f.close();
  }
});

test("public pages hide operator links and public JSON projects away credentials and private source metadata", async () => {
  const f = await fixture();
  const old = process.env.WARIO_PHASE31_SECRET;
  process.env.WARIO_PHASE31_SECRET = canary;
  try {
    const record = await f.museum.get(PUBLIC_ROUND);
    record.title = "The " + canary + " hammer";
    record.snapshots[0].instruction = canary;
    await f.museum.write(record);
    for (const page of ["/museum", `/inspect/${PUBLIC_ROUND}`]) {
      const response = await f.request(page);
      const html = await response.text();
      assert.ok(!html.includes('href="/controls"'));
      assert.ok(!html.includes("Streamer controls"));
      assert.ok(
        html.includes(page === "/museum" ? 'id="gallery"' : 'id="evidence"'),
      );
      assert.ok(!html.includes("operator-token"));
      assert.ok(
        !response.headers
          .get("content-security-policy")
          .includes("ws://localhost"),
      );
    }
    assert.ok(
      (await (await fetch(f.base + "/museum")).text()).includes(
        "Streamer controls",
      ),
    );
    assert.ok(
      (
        await (await fetch(f.base + `/inspect/${PUBLIC_ROUND}`)).text()
      ).includes("Streamer controls"),
    );
    for (const route of [
      "/api/museum",
      `/api/museum/${PUBLIC_ROUND}`,
      `/api/inspect/${PUBLIC_ROUND}`,
    ]) {
      const text = await (await f.request(route)).text();
      for (const value of [
        canary,
        "/home/private-user",
        '"capture"',
        '"generation"',
        '"trigger"',
        '"env"',
        '"operator"',
        '"integrations"',
      ])
        assert.ok(!text.includes(value), "Private metadata must be absent");
    }
    const list = await (await f.request("/api/museum")).json();
    assert.deepEqual(
      list.records.map((record) => record.id),
      [PUBLIC_ROUND],
    );
    assert.deepEqual(list.score, { chat: 0, streamer: 1 });
    const replay = await (
      await f.request(`/api/museum/${PUBLIC_ROUND}`)
    ).json();
    assert.equal(replay.snapshots.length, 1);
    assert.equal(replay.assets.frame, `museum/${PUBLIC_ROUND}/frame.png`);
  } finally {
    await f.close();
    if (old === undefined) delete process.env.WARIO_PHASE31_SECRET;
    else process.env.WARIO_PHASE31_SECRET = old;
  }
});

test("private archives, raw recordings, diagnostics and symlink escapes stay unavailable publicly", async () => {
  const f = await fixture();
  try {
    for (const route of [
      `/api/museum/${PRIVATE_ROUND}`,
      `/api/inspect/${PRIVATE_ROUND}`,
      `/inspect/${PRIVATE_ROUND}`,
      `/museum/${PRIVATE_ROUND}/frame.png`,
      `/museum/${PRIVATE_ROUND}/voice.wav`,
      `/museum/${PUBLIC_ROUND}/culprit-diagnostic.png`,
      `/museum/${PUBLIC_ROUND}/record.json`,
      ...[
        "recording.mp4",
        "speech.wav",
        "webcam.png",
        "culprit-diagnostic.png",
        "capture.json",
      ].map((file) => "/assets/captures/public/" + file),
    ])
      assert.equal((await f.request(route)).status, 404, route);
    assert.equal(
      (await (await f.request(`/api/inspect/${PUBLIC_ROUND}`)).json())
        .diagnostic,
      null,
    );
    assert.ok(
      (await (await fetch(f.base + `/api/inspect/${PUBLIC_ROUND}`)).json())
        .diagnostic,
    );
    await symlink(
      path.join(f.root, ".env"),
      path.join(f.root, "assets/sample/leak.png"),
    );
    assert.equal((await f.request("/assets/sample/leak.png")).status, 404);
    await symlink(
      path.join(f.root, ".env"),
      path.join(f.root, "museum", PUBLIC_ROUND, "faceWin.png"),
    );
    assert.equal(
      (await f.request(`/museum/${PUBLIC_ROUND}/faceWin.png`)).status,
      404,
    );
    assert.equal(
      (await f.request("/assets/captures/public/../../.env")).status,
      404,
    );
    const source = await (
      await f.request(`/museum/${PUBLIC_ROUND}/level.js`)
    ).text();
    assert.ok(source.startsWith("export default "));
    assert.ok(!source.includes(canary));
    assert.ok(
      (
        await (await f.request(`/museum/${PUBLIC_ROUND}/chat.txt`)).text()
      ).includes("That hammer owns you"),
    );
  } finally {
    await f.close();
  }
});

test("legacy private file provenance is excluded without rewriting archive records", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "museum", PUBLIC_ROUND, "record.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    delete record.privateRun;
    record.generation.reveal_frames = ["testdata/private/strip-0.jpg"];
    await writeFile(file, JSON.stringify(record));
    await writeFile(
      file + ".summary",
      JSON.stringify({
        id: record.id,
        assets: record.assets,
        capture: record.capture,
      }),
    );
    const before = await readFile(file, "utf8");
    assert.deepEqual(
      (await (await f.request("/api/museum")).json()).records,
      [],
    );
    assert.equal((await f.request(`/api/museum/${PUBLIC_ROUND}`)).status, 404);
    assert.equal(await readFile(file, "utf8"), before);
    // Old summaries can lack the top-level flag after media was copied into the museum.
    delete record.generation.reveal_frames;
    record.capture.privateRun = true;
    await writeFile(file, JSON.stringify(record));
    assert.equal((await f.request(`/api/museum/${PUBLIC_ROUND}`)).status, 404);
    assert.equal(
      (await f.request(`/museum/${PUBLIC_ROUND}/frame.png`)).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("production WebSocket upgrades reject forwarded traffic even with a valid local operator cookie", async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { mkdir, chmod } = await import("node:fs/promises");
  const { WebSocket } = await import("ws");
  const f = await publicMuseumFixture();
  const binaryFolder = path.join(f.root, "bin");
  await mkdir(binaryFolder);
  await writeFile(path.join(binaryFolder, "codex"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(binaryFolder, "codex"), 0o700);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  assert.ok(![8787, 8911].includes(port));
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server/index.js", "--sample"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: binaryFolder + path.delimiter + process.env.PATH,
      PORT: String(port),
      CI: "true",
      DEMO_TEMPLATE: "1",
    },
  });
  const stopped = new Promise((resolve) => child.once("close", resolve));
  let ready = false,
    exited = false;
  child.stdout.on("data", (data) => {
    if (String(data).includes("WarioStream http://")) ready = true;
  });
  child.stderr.on("data", () => {});
  child.on("exit", () => {
    exited = true;
  });
  async function opens(route, headers = {}) {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}` + route, {
        headers,
      });
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(false);
      }, 3000);
      socket.once("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }
  try {
    const deadline = Date.now() + 8000;
    while (!ready && !exited && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      ready,
      true,
      "Isolated sample server must start without real service credentials",
    );
    const controls = await fetch(`http://127.0.0.1:${port}/controls`);
    const cookie = controls.headers.get("set-cookie").split(";")[0];
    assert.equal(await opens("/ws"), true);
    assert.equal(await opens("/ws/controls", { Cookie: cookie }), true);
    assert.equal(await opens("/ws", forwarded), false);
    assert.equal(
      await opens("/ws/controls", { Cookie: cookie, ...forwarded }),
      false,
    );
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    await stopped;
    clearTimeout(timer);
  }
});

test("new archives mark private asset provenance before rewriting asset URLs", async () => {
  const f = await fixture();
  try {
    const { mkdir, cp } = await import("node:fs/promises");
    await mkdir(path.join(f.root, "testdata/private"), { recursive: true });
    await cp(
      "assets/sample/frame.png",
      path.join(f.root, "testdata/private/frame.png"),
    );
    const archived = await f.museum.archive(
      {
        source: await readFile("engine/rematch-reference.js", "utf8"),
        assets: {
          frame: "testdata/private/frame.png",
          face: "assets/sample/face.png",
          voice: "assets/sample/voice.wav",
          transcript: "Original sample",
          chat: "testdata/ is a folder name",
        },
        log: {
          id: "1793400000002-private",
          api_version: 6,
          validation: { ok: true },
          reveal_frames: [],
        },
      },
      { mode: "source-ring" },
      {},
    );
    assert.equal(archived.privateRun, true);
    assert.equal((await f.request("/api/museum/" + archived.id)).status, 404);
    assert.equal(
      (await fetch(f.base + "/api/museum/" + archived.id)).status,
      200,
    );
  } finally {
    await f.close();
  }
});
