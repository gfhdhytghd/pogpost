import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';

// Isolated UI fixture: no application bootstrap, .env, credential store, or OAuth client.
const root = path.resolve(import.meta.dirname, '..');
let current = { stage: 'idle' }, starts = 0, saves = 0;
const server = await createHTTP({ root, engine: {}, credentials: {
  status: async () => ({ present: { TWITCH_EXT_CLIENT_ID: true, TWITCH_EXT_SECRET: true, TWITCH_EXT_OWNER_ID: true, TWITCH_BROADCASTER_ID: false } }),
  save: async () => { saves++; return { ok: true, present: {} }; },
}, authFlow: {
  status: () => structuredClone(current),
  async start() {
    starts++;
    current = { stage: 'waiting', user_code: 'MOCK-1234', verification_uri: 'https://www.twitch.tv/activate', expires_at: Date.now() + 60000 };
    return structuredClone(current);
  },
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], authWrites = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push('blocked'); return route.abort('blockedbyclient');
});
await context.addInitScript(() => {
  window.__privateClipboardWrites = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    async writeText(value) { window.__privateClipboardWrites.push(value); },
  } });
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/operator/auth') authWrites.push('start');
});

try {
  await page.goto(`${origin}/setup`);
  await page.getByText('Ready. Start authorization when you are ready to approve it on Twitch.', { exact: true }).waitFor();
  check('Opening setup never starts authorization', starts === 0 && authWrites.length === 0);
  check('Opening setup never copies an activation code', await page.evaluate(() => window.__privateClipboardWrites.length === 0));
  check('Idle code field is empty and copying is disabled', await page.locator('#device-user-code').inputValue() === '' && await page.locator('#copy-device-code').isDisabled());

  await page.getByRole('button', { name: 'Start Twitch authorization', exact: true }).click();
  await page.getByText('Waiting for your approval on Twitch. Keep the activation code private.', { exact: true }).waitFor();
  check('Only the explicit Start action begins the synthetic flow', starts === 1 && authWrites.length === 1);
  check('Waiting code uses a read-only password input', await page.locator('#device-user-code').evaluate(node => node.type === 'password' && node.readOnly && node.value === 'MOCK-1234'));
  check('Waiting body text never shows the activation code', !(await page.locator('body').innerText()).includes('MOCK-1234'));
  check('Waiting state never auto-copies the code', await page.evaluate(() => window.__privateClipboardWrites.length === 0));
  check('Activation link is the fixed trusted Twitch URL', await page.getByRole('link', { name: 'Open Twitch activation', exact: true }).getAttribute('href') === 'https://www.twitch.tv/activate');

  await page.getByRole('button', { name: 'Copy activation code', exact: true }).click();
  await page.getByText('Activation code copied. Paste it only on the Twitch activation page.', { exact: true }).waitFor();
  check('Copy action writes only to the window-local clipboard fake', await page.evaluate(() => window.__privateClipboardWrites.length === 1 && window.__privateClipboardWrites[0] === 'MOCK-1234'));
  check('Copy confirmation never shows the code', !(await page.locator('body').innerText()).includes('MOCK-1234'));

  current = { stage: 'authorized', userId: '1001', scopes: ['user:read:chat', 'moderator:read:followers'] };
  await page.getByText('Authorized broadcaster user ID: 1001. Provider features remain disabled.', { exact: true }).waitFor();
  check('Authorization polling clears the code and disables Copy', await page.locator('#device-user-code').inputValue() === '' && await page.locator('#copy-device-code').isDisabled());
  check('Terminal status contains no activation code or token', await page.locator('#twitch-auth-status').evaluate(node => !/MOCK-1234|access_token|refresh_token|bearer/i.test(node.textContent)));
  check('Terminal state removes the activation link', await page.getByRole('link', { name: 'Open Twitch activation', exact: true }).count() === 0);
  check('Polling never repeats authorization or copies again', starts === 1 && await page.evaluate(() => window.__privateClipboardWrites.length === 1));
  check('No credential save was requested', saves === 0);

  await mkdir(path.join(root, 'shots'), { recursive: true });
  const screenshots = [];
  for (const [width, height] of [[1920, 1080], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#twitch-auth-status').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#device-user-code').inputValue(), '', 'Screenshot code field must be empty');
    const filename = `private-auth-safe-authorized-${width}x${height}.png`;
    await page.screenshot({ path: path.join(root, 'shots', filename) }); screenshots.push(filename);
    check(`Terminal setup fits ${width}×${height} without horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  check('No external requests were attempted', external.length === 0);
  check('No unhandled browser errors occurred', errors.length === 0);
  await writeFile(path.join(root, 'docs/private-auth-evidence.md'), `# Private authorization UI evidence\n\nGenerated by \`node test/private-auth-browser.mjs\` on ${new Date().toISOString()}.\n\n## Isolation\n\nThe test creates only \`createHTTP\` with an empty engine, an in-memory credentials fake, and a synthetic authorization flow on an ephemeral loopback port. It does not create the application, load \`.env\`, access the real authorization server, contact Twitch, or save credentials. Headless Chromium uses its own temporary profile and a minimal environment. Every external browser request is blocked.\n\nThe clipboard API is replaced before page scripts run. Copy writes only to a test array inside this browser window. The test does not use the system clipboard. The activation code and broadcaster ID in this test are synthetic.\n\n## Results\n\n${checks.map(name => `- PASS: ${name}`).join('\n')}\n\n## Safe screenshots\n\nOnly the terminal synthetic authorized state is captured. The password input is empty before every capture. No waiting-state or activation-code screenshot is saved.\n\n${screenshots.map(name => `- [${name}](../shots/${name})`).join('\n')}\n\n## Boundary\n\nThese checks verify the private setup UI lifecycle, masked code field, explicit copy action, and terminal cleanup. They do not prove real Twitch authorization, token persistence, account ownership, provider scopes, or a live connection. No real user Chrome profile or live authorization session was touched.\n`);
  console.log(`Private authorization UI passed: ${checks.length} checks; ${screenshots.length} safe terminal screenshots.`);
} finally {
  await context.close(); await browser.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
