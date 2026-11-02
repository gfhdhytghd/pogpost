import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, createApplication } from '../server/index.js';

/** Explicit local launch only. Existing secrets remain in memory and never enter argv or logs. */
export async function obsRuntimeEnv({ sourceName, envFile = path.join(ROOT, '.env'),
  obsFile = path.join(os.homedir(), '.config/obs-studio/plugin_config/obs-websocket/config.json') } = {}) {
  if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName.length > 256) throw Error('An explicit OBS source is required.');
  if (((await stat(envFile)).mode & 0o777) !== 0o600) throw Error('The .env file must have mode 0600.');
  const env = parseEnv(await readFile(envFile, 'utf8'));
  const obs = JSON.parse(await readFile(obsFile, 'utf8'));
  if (obs.server_enabled !== true || obs.auth_required !== true || typeof obs.server_password !== 'string' || !obs.server_password ||
    !Number.isInteger(obs.server_port) || obs.server_port < 1 || obs.server_port > 65535) throw Error('An enabled, authenticated OBS WebSocket server is required.');
  return { ...env, DECISIONS_LIVE: 'true', OBS_FRAME_WATCHER: 'true', OBS_SOURCE_NAME: sourceName,
    OBS_WS_URL: `ws://127.0.0.1:${obs.server_port}`, OBS_PASSWORD: obs.server_password };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !arg.startsWith('--source=') && !arg.startsWith('--port=') && arg !== '--standby')) throw Error('Unsupported launch option.');
    const sourceName = args.find(arg => arg.startsWith('--source='))?.slice(9);
    const port = Number(args.find(arg => arg.startsWith('--port='))?.slice(7) || 8788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port.');
    const env = await obsRuntimeEnv({ sourceName });
    if(args.includes('--standby'))env.OBS_FRAME_WATCHER='false';
    const app = await createApplication({ env });
    app.server.on('error', async () => { await app.close(); process.exitCode = 1; });
    app.server.listen(port, '127.0.0.1', () => console.log(`Sealed Notes with OBS controls: http://127.0.0.1:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch {
    console.error('Live OBS startup unavailable. Check source, private configuration, and authenticated local OBS.');
    process.exitCode = 1;
  }
}
