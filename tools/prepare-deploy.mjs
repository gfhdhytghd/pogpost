import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

export const ROOT = path.resolve(import.meta.dirname, '..');

export function publicOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(value)) throw Error('Provide one HTTPS origin without credentials, port, path or query.');
  const url = new URL(value);
  const host = url.hostname;
  const labels = host.split('.');
  if (isIP(host) || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host) || /(?:^|\.)example\.(?:com|net|org)$/.test(host) ||
      /(?:^|\.)(?:openai\.com|chatgpt\.com|twitch\.tv|ext-twitch\.tv|twitchcdn\.net|ttvnw\.net)$/.test(host))
    throw Error('Provide a public DNS hostname.');
  return url.origin;
}

export function relayPort(value) {
  if (!/^[1-9][0-9]{0,4}$/.test(String(value))) throw Error('Provide a relay port from 1024 to 65535.');
  const port = Number(value);
  if (port < 1024 || port > 65535 || [8787, 8788, 18787].includes(port)) throw Error('Choose a distinct relay port from 1024 to 65535.');
  return port;
}

function servicePath(value) {
  if (!path.isAbsolute(value) || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..')) throw Error('Service paths must be absolute and contain only letters, digits, slash, dot, underscore or hyphen.');
  return value;
}

export function renderDeployment({ origin, port, workdir = ROOT, node = process.execPath, nginxTemplate }) {
  const host = new URL(publicOrigin(origin)).hostname;
  const listener = relayPort(port);
  servicePath(workdir);
  servicePath(node);
  if (!nginxTemplate?.includes('NOTES_DOMAIN') || !nginxTemplate.includes('NEW_NPS_RELAY_PORT')) throw Error('The nginx template is missing deployment placeholders.');
  const nginx = nginxTemplate.replaceAll('NOTES_DOMAIN', host).replaceAll('NEW_NPS_RELAY_PORT', String(listener));
  const service = `[Unit]\nDescription=Sealed Notes loopback application\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${workdir}\nExecStart=${node} ${workdir}/server/index.js --port=8788\nEnvironment="PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin"\nUMask=0077\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  const npc = `# TEMPLATE ONLY: npc does not expand environment variables.\n# Use tools/nps-tunnel.mjs with its anonymous-memory configuration helper.\n# Read NPS_VKEY only from the project .env; never render a secret file.\n[common]\nserver_addr=wilflin.me:8025\nconn_type=tls\nvkey=\${NPS_VKEY}\n\n[sealed-notes-web]\nmode=tcp\nserver_ip=127.0.0.1\nserver_port=${listener}\ntarget_addr=127.0.0.1:8788\n`;
  return { 'nginx.conf': nginx, 'sealed-notes.service': service, 'npc.conf.template': npc };
}

export async function prepareDeployment(options, { root = ROOT } = {}) {
  const nginxTemplate = await readFile(path.join(root, 'deploy/nginx.conf.example'), 'utf8');
  const files = renderDeployment({ ...options, nginxTemplate });
  const output = path.join(root, 'dist/deploy');
  await mkdir(output, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(output, name), content, { mode: 0o600 });
  return Object.keys(files).map(name => `dist/deploy/${name}`);
}

export function argumentsFor(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!allowed.includes(name) || Object.hasOwn(options, name)) throw Error('Unknown or duplicate option.');
    if (['--network', '--local'].includes(name)) options[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error('Missing option value.');
      options[name] = value;
    }
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = argumentsFor(process.argv.slice(2), ['--origin', '--relay-port', '--workdir', '--node']);
    const files = await prepareDeployment({ origin: args['--origin'], port: args['--relay-port'], workdir: args['--workdir'] || ROOT, node: args['--node'] || process.execPath });
    console.log(JSON.stringify({ staged: files, applied: false, relayPortAllocationVerified: false }, null, 2));
  } catch {
    console.error('Deployment staging failed. Supply --origin https://YOUR-PUBLIC-HOST --relay-port NEW-PORT; use safe absolute service paths.');
    process.exitCode = 1;
  }
}
