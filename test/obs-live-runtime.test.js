import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { obsRuntimeEnv } from '../tools/start-obs-live.mjs';

test('explicit OBS launch reuses private credentials without rewriting files or enabling other providers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sealed-obs-'));
  const envFile = path.join(dir, '.env'), obsFile = path.join(dir, 'obs.json');
  const original = 'OPENAI_API_KEY=synthetic-key\nDECISIONS_LIVE=false\nTWITCH_CONNECT=false\nPAYMENTS_LIVE=false\n';
  const obs = { server_enabled: true, auth_required: true, server_password: 'synthetic-obs-secret', server_port: 4455 };
  try {
    await writeFile(envFile, original, { mode: 0o600 });
    await writeFile(obsFile, JSON.stringify(obs));
    const options = { sourceName: '屏幕采集(PipeWire)', envFile, obsFile };
    const env = await obsRuntimeEnv(options);
    assert.equal(env.OBS_PASSWORD, obs.server_password);
    assert.equal(env.OBS_WS_URL, 'ws://127.0.0.1:4455');
    assert.equal(env.OBS_SOURCE_NAME, options.sourceName);
    assert.equal(env.DECISIONS_LIVE, 'true');
    assert.equal(env.OBS_FRAME_WATCHER, 'true');
    assert.equal(env.TWITCH_CONNECT, 'false');
    assert.equal(env.PAYMENTS_LIVE, 'false');
    assert.equal(await readFile(envFile, 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(obsFile, 'utf8')), obs);
    await assert.rejects(obsRuntimeEnv({ ...options, sourceName: '' }), /explicit OBS source/);
    for (const invalid of [{ auth_required: false }, { server_enabled: false }, { server_port: 0 }, { server_password: '' }]) {
      await writeFile(obsFile, JSON.stringify({ ...obs, ...invalid }));
      await assert.rejects(obsRuntimeEnv(options), /authenticated OBS/);
    }
    await chmod(envFile, 0o644);
    await assert.rejects(obsRuntimeEnv(options), /mode 0600/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
