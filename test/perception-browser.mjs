import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// UI acceptance only. The detection switch talks to a local mock of the
// perception_set contract; no OBS, Decisions, Twitch, .env or real watcher.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
let perception = { profile: 'ksp', enabled: false, controllable: true, unavailable_reason: null, status: 'disabled' };
let resets = 0;
const watcher = { prompts: () => [], confirm: () => null, reset() { resets++; } };
const server = await createHTTP({ root, engine, demo: true, watcher, integrations: () => (perception ? { perception: { ...perception } } : {}) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], sets = [], stateReads = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };

// Mock backend for perception_set. Each request waits for the test to release it.
let release = null, nextOutcome = 'ok';
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
  if (url.pathname === '/api/operator/state') stateReads.push(Date.now());
  const body = request.method() === 'POST' && url.pathname === '/api/operator/action' ? JSON.parse(request.postData() || '{}') : null;
  if (body?.action !== 'perception_set') return route.continue();
  const headers = await request.allHeaders();
  sets.push({ body, at: Date.now(), header: headers['x-sealed-action'], cookie: /(?:^|;\s*)\w/.test(headers.cookie || '') });
  await new Promise(resolve => { release = resolve; });
  release = null;
  if (nextOutcome === 'ok') {
    perception = { ...perception, enabled: body.enabled === true, status: body.enabled ? 'watching' : 'disabled' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { enabled: perception.enabled } }) });
  }
  return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'perception_unavailable' }) });
});

const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const toggle = page.locator('#perception-toggle');
const text = async selector => (await page.locator(selector).textContent()).trim();
const waitFor = async (predicate, timeout = 6000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await page.waitForTimeout(50); } return false; };
const pending = () => waitFor(() => release !== null);
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

try {
  await page.goto(`${origin}/console`);
  await page.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();

  // Layout: the switch sits in Quick controls (below the Stage and the event column), apart from Reset.
  check('Detection control appears inside observation controls in Quick controls, below the suggestions column',
    await page.locator('#operator-controls #observation-controls #perception-control').isVisible() &&
    await page.evaluate(() => !!(document.querySelector('#ai-prompts').compareDocumentPosition(document.querySelector('#observation-controls')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  check('Off and controllable: Start detection is enabled', await text('#perception-toggle') === 'Start detection' && await toggle.isEnabled() &&
    await text('#perception-state') === 'Off. No pictures are checked.' && await page.locator('#perception-reason').isHidden());
  check('Reset stays a separate button and says it does not stop detection',
    await page.getByRole('button', { name: 'Reset observations', exact: true }).isVisible() &&
    (await text('#observation-controls .perception-reset p')).endsWith('Reset does not stop detection.'));
  check('Loading the desk never sends perception_set', sets.length === 0);

  // Start: disabled while in flight, then re-read state.
  await toggle.click();
  check('Start sends perception_set enabled=true with the operator header and cookie', await pending() &&
    sets.length === 1 && sets[0].body.enabled === true && Object.keys(sets[0].body).sort().join() === 'action,enabled' && sets[0].header === '1' && sets[0].cookie);
  check('Button is disabled and busy while the request is in flight', await toggle.isDisabled() && await toggle.getAttribute('aria-busy') === 'true' &&
    await text('#perception-state') === 'Starting detection…');
  await page.waitForTimeout(2300);
  check('A poll during the request keeps the button disabled and does not resend', await toggle.isDisabled() && await text('#perception-toggle') === 'Start detection' && sets.length === 1);
  const releasedAt = Date.now(); release();
  check('Success re-reads state and shows Stop detection', await waitFor(async () => await text('#perception-toggle') === 'Stop detection' && await toggle.isEnabled()) &&
    stateReads.some(at => at >= releasedAt) && await text('#perception-state') === 'On. Matching events appear in Event suggestions for you to confirm.' &&
    await text('#status') === 'Detection is on.');
  await page.locator('#operator-controls').screenshot({ path: path.join(shots, 'perception-on.png') });

  // Failed stop: the server state (on) stays visible, with the error.
  nextOutcome = 'fail';
  await toggle.focus(); await page.keyboard.press('Enter');
  check('Keyboard Enter sends perception_set enabled=false', await pending() && sets.length === 2 && sets[1].body.enabled === false);
  check('Stopping shows progress', await toggle.isDisabled() && await text('#perception-state') === 'Stopping detection…');
  release();
  check('Failure shows the error and keeps the real server state', await waitFor(async () => await page.locator('#perception-error').isVisible()) &&
    await text('#perception-error') === 'Detection did not stop: perception unavailable' &&
    await waitFor(async () => await text('#perception-toggle') === 'Stop detection' && await toggle.isEnabled()) && perception.enabled === true);
  await page.locator('#operator-controls').screenshot({ path: path.join(shots, 'perception-error.png') });

  // Server-side change arrives by polling.
  perception = { ...perception, enabled: false, status: 'disabled' };
  check('Polling follows a server-side stop', await waitFor(async () => await text('#perception-toggle') === 'Start detection'));

  // Not controllable while off: start is blocked with the server's reason.
  perception = { ...perception, controllable: false, unavailable_reason: 'OBS capture is not configured on this server.' };
  check('Not controllable and off: Start is disabled and the reason is shown', await waitFor(async () => await toggle.isDisabled()) &&
    await page.locator('#perception-reason').isVisible() && await text('#perception-reason') === 'OBS capture is not configured on this server.' &&
    (await toggle.getAttribute('aria-describedby')).split(' ').includes('perception-reason'));
  perception = { ...perception, unavailable_reason: null };
  check('A missing reason falls back to a plain explanation', await waitFor(async () => await text('#perception-reason') === 'Detection cannot be started on this server.'));

  // Not controllable but on: stopping must still work.
  nextOutcome = 'ok'; perception = { ...perception, enabled: true, status: 'watching' };
  check('Not controllable but on: Stop detection stays enabled', await waitFor(async () => await text('#perception-toggle') === 'Stop detection' && await toggle.isEnabled()) &&
    await page.locator('#perception-reason').isHidden());
  await toggle.click(); await pending(); release();
  check('Stop succeeds, then Start is blocked again with the reason', await waitFor(async () => await text('#perception-toggle') === 'Start detection' && await toggle.isDisabled()) &&
    sets.length === 3 && sets[2].body.enabled === false && await page.locator('#perception-error').isHidden() && await page.locator('#perception-reason').isVisible());

  // Reset is independent of the switch.
  const before = sets.length;
  await page.getByRole('button', { name: 'Reset observations', exact: true }).click();
  check('Reset observations sends reset_perception only', await waitFor(() => resets === 1) && sets.length === before);

  // Narrow layout.
  await page.setViewportSize({ width: 390, height: 900 });
  const fits = await page.evaluate(() => { const box = document.querySelector('#perception-control').getBoundingClientRect(); return box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
  check('Detection control fits a 390 px viewport without horizontal scroll', fits);
  await page.locator('#operator-controls').screenshot({ path: path.join(shots, 'perception-narrow.png') });

  // No perception integration: the switch is absent.
  perception = null;
  const noPerception = await context.newPage();
  await noPerception.goto(`${origin}/console`);
  await noPerception.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();
  check('Without a perception integration the switch is hidden', await noPerception.locator('#perception-control').isHidden());
  await noPerception.close();

  check('No external requests and no page errors', external.length === 0 && errors.length === 0);
  console.log(`Perception switch browser passed: ${checks.length} checks; perception_set=${sets.length}, resets=${resets}; screenshots=shots/perception-{on,error,narrow}.png.`);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
