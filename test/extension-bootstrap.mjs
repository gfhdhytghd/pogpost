import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { DEFAULT_CONFIG } from '../server/config.js';

// This tests the actual archive in a cold browser, not the local demo harness.
const root = path.resolve(import.meta.dirname, '..');
const zip = path.join(root, 'dist/extension.zip');
const temp = await mkdtemp(path.join(os.tmpdir(), 'sealed-bootstrap-'));
const helperURL = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';
const helperTag = /<script\b[^>]*\bsrc=["']https:\/\/extension-files\.twitch\.tv\/helper\/v1\/twitch-ext\.min\.js["'][^>]*>\s*<\/script>/i;
const entries = execFileSync('/usr/bin/unzip', ['-Z1', zip], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim().split('\n');
assert.ok(entries.every(name => /^[a-zA-Z0-9_.-]+$/.test(name)), 'Archive contains only flat asset names');
execFileSync('/usr/bin/unzip', ['-q', zip, '-d', temp], { env: { PATH: '/usr/bin:/bin' } });
const archiveMD5 = createHash('md5').update(await readFile(zip)).digest('hex');
const checks = [], errors = [], unexpected = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = url.pathname.slice(1);
  if (!entries.includes(file)) { response.writeHead(404).end(); return; }
  let body = await readFile(path.join(temp, file));
  if (url.searchParams.get('bootstrap') === 'dynamic' && file.endsWith('.html')) body = Buffer.from(body.toString().replace(helperTag, ''));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-store' }); response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const helper = `(() => {
  const callbacks = [];
  const state = window.__helperFixture = { loadedWhen: document.readyState, dclFired: false, authorized: 0, registeredBeforeDCL: [], contexts: 0, broadcasts: 0 };
  window.Twitch = { ext: {
    onAuthorized(fn) { callbacks.push(fn); state.registeredBeforeDCL.push(!window.__hostDCL); },
    onContext(fn) { state.contexts++; fn({hlsLatencyBroadcaster:0}, ['hlsLatencyBroadcaster']); },
    listen() { state.broadcasts++; }, unlisten() {}, onError() {},
    actions: { requestIdShare() {} }, bits: { useBits() { throw Error('Live Bits are disabled'); }, onTransactionComplete() {}, onTransactionCancelled() {} },
    configuration: { broadcaster: { content:'{}' }, onChanged(fn) { fn(); } }
  }};
  document.addEventListener('DOMContentLoaded', () => {
    state.dclFired = true;
    callbacks.forEach(fn => { state.authorized++; fn({token:'offline-bootstrap-token',channelId:'123456',userId:'offline',clientId:'offline'}); });
  }, {once:true});
})();`;

async function freshSurface(file, dynamic = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(6000);
  await context.addInitScript(() => {
    window.__hostDCL = false;
    document.addEventListener('DOMContentLoaded', () => { window.__hostDCL = true; }, { once: true });
  });
  const ebs = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.url() === helperURL) {
      // Parsing must wait for a synchronous helper. A dynamic helper loses DCL.
      await new Promise(resolve => setTimeout(resolve, dynamic ? 300 : 150));
      return route.fulfill({ contentType: 'text/javascript', body: helper });
    }
    if (url.origin === origin) return route.continue();
    if (url.pathname.startsWith('/ebs/')) {
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      ebs.push({ path: url.pathname, authorized: request.headers().authorization === 'Bearer offline-bootstrap-token' });
      const state = { config: structuredClone(DEFAULT_CONFIG), moments: structuredClone(DEFAULT_CONFIG.moments), wallet: { points: 10000, bits: 1000 }, notes: [], events: [], free_remaining: 1, sealedCount: 7, features: { conditionCompiler: false } };
      const payload = url.pathname === '/ebs/config' ? { config: state.config } : url.pathname === '/ebs/events' ? { events: [] } : state;
      return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(payload) });
    }
    unexpected.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/${file}${dynamic ? '?bootstrap=dynamic' : ''}`);
  return { context, page, ebs };
}

try {
  for (const file of ['panel.html', 'config.html', 'video_overlay.html']) {
    const html = await readFile(path.join(temp, file), 'utf8');
    const tag = html.match(helperTag)?.[0] || '';
    check(`${file}: packaged helper is synchronous and before module execution`, !!tag && !/\b(?:async|defer|type\s*=)/i.test(tag) && html.indexOf(tag) < html.indexOf('type="module"'));
    const { context, page, ebs } = await freshSurface(file);
    try {
      if (file === 'panel.html') await page.getByText('Your words stay hidden until the seal breaks.', { exact: true }).waitFor();
      else if (file === 'config.html') await page.getByText('Your rules are ready to edit.', { exact: true }).waitFor();
      else await page.getByText('7 notes sealed', { exact: true }).waitFor();
      const lifecycle = await page.evaluate(() => window.__helperFixture);
      check(`${file}: cold authorization callback runs before auth-dependent requests`, lifecycle.loadedWhen === 'loading' && lifecycle.dclFired && lifecycle.authorized === 1 && lifecycle.registeredBeforeDCL.every(Boolean) && ebs.length > 0 && ebs.every(request => request.authorized));
      check(`${file}: context and broadcast listeners register`, lifecycle.contexts === 1 && lifecycle.broadcasts === 1);
      if (file === 'config.html') check('Config top-level await does not deadlock DOMContentLoaded', await page.evaluate(() => window.__hostDCL === true) && ebs.some(request => request.path === '/ebs/config'));
    } finally { await context.close(); }
  }

  // Reverse check: exactly remove the packaging fix, preserving the old dynamic
  // fallback. Delaying that helper until after DCL must reproduce the auth stall.
  const negative = await freshSurface('panel.html', true);
  try {
    await negative.page.waitForFunction(() => window.__hostDCL && window.__helperFixture?.registeredBeforeDCL.length === 1);
    await negative.page.waitForTimeout(100);
    const lifecycle = await negative.page.evaluate(() => window.__helperFixture);
    check('Original dynamic helper reproduces the missed-DCL authorization stall', lifecycle.loadedWhen !== 'loading' && !lifecycle.dclFired && lifecycle.authorized === 0 && lifecycle.registeredBeforeDCL[0] === false && negative.ebs.length === 0);
    check('Negative control remains on the connecting state', await negative.page.locator('#status').innerText() === 'Connecting to your channel…');
  } finally { await negative.context.close(); }
  check('No unexpected network traffic or unhandled browser errors', unexpected.length === 0 && errors.length === 0);
  console.log(`Extension bootstrap passed: ${checks.length} checks; ${entries.length} packaged assets; archive MD5=${archiveMD5}; panel/config/video ready; dynamic-helper negative control reproduced.`);
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true });
}
