import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';

// Quick controls acceptance. Real operator HTTP routes and an in-memory engine;
// perception_set and debug_set are answered by a local mock of their contract.
// No .env, OBS capture, Decisions, Twitch, debug recorder or user browser profile.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
const eventSystem = new EventSystem({ engine });
let resets = 0;
const watcher = { prompts: () => eventSystem.prompts(), reset: () => { resets++; return eventSystem.reset(); }, confirm: id => eventSystem.confirm(id) };
let perception = { profile: 'ksp', enabled: false, controllable: true, unavailable_reason: null, status: 'disabled' };
let debug = { available: true, enabled: false };
const server = await createHTTP({ root, engine, demo: true, watcher, eventSystem,
  integrations: () => ({ perception: { ...perception }, ...(debug ? { debug: { ...debug } } : {}) }) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], sent = [], stateReads = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };

// Mocked switches wait until the test releases them.
let release = null, outcome = 'ok';
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
  if (url.pathname === '/api/operator/state') stateReads.push(Date.now());
  const body = request.method() === 'POST' && url.pathname === '/api/operator/action' ? JSON.parse(request.postData() || '{}') : null;
  if (body) sent.push(body.action === 'events_presets' ? null : body);
  if (!['perception_set', 'debug_set'].includes(body?.action)) return route.continue();
  await new Promise(resolve => { release = resolve; });
  release = null;
  if (outcome !== 'ok') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'debug_unavailable' }) });
  if (body.action === 'debug_set') debug = { ...debug, enabled: body.enabled === true };
  else perception = { ...perception, enabled: body.enabled === true };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { enabled: body.enabled === true } }) });
});

const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const text = async selector => (await page.locator(selector).textContent()).trim();
const waitFor = async (predicate, timeout = 6000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await page.waitForTimeout(50); } return false; };
const switches = () => sent.filter(item => item && ['perception_set', 'debug_set'].includes(item.action));
const debugToggle = page.locator('#debug-toggle');
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

try {
  await page.goto(`${origin}/console`);
  await page.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();

  // Position (operator desk layout): below the Stage and the event column, first in the lower area,
  // above connections and the note queues.
  const order = await page.evaluate(() => {
    const at = selector => document.querySelector(selector);
    const before = (a, b) => !!(at(a).compareDocumentPosition(at(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    const stage = at('#stage-section').getBoundingClientRect(), controls = at('#operator-controls').getBoundingClientRect();
    return before('#stage-section', '#operator-controls') && before('#console-side', '#operator-controls') &&
      at('#console-lower').firstElementChild === at('#operator-controls') && controls.top >= stage.bottom &&
      before('#operator-controls', '#connections-section') && before('#operator-controls', '#sealed-queue');
  });
  check('Quick controls sit first below the Stage and event column, above connections and the queues', order && await page.locator('#operator-controls').isVisible());
  check('Quick controls state that they do not control the Twitch broadcast',
    (await text('#operator-controls .section-title p')) === 'These controls do not start or stop your Twitch broadcast.');
  check('Detection, Reset and Debug each exist once, inside quick controls',
    await page.locator('#perception-toggle').count() === 1 && await page.locator('#operator-controls #perception-toggle').count() === 1 &&
    await page.getByRole('button', { name: 'Reset observations', exact: true }).count() === 1 && await page.locator('#operator-controls #reset-perception').count() === 1 &&
    await page.locator('#operator-controls #debug-toggle').count() === 1 && await page.locator('#ai-section button').count() === 0);
  check('No Twitch or global AI switch was added', await page.locator('#operator-controls button').evaluateAll(nodes => nodes.map(node => node.textContent.trim())).then(labels =>
    JSON.stringify(labels) === JSON.stringify(['Start detection', 'Reset observations', 'Start recording', 'Change profile'])));
  check('Wrap up and new session stay in place', await page.locator('.page-heading #wrap').count() === 1 && await page.locator('#new-session').evaluate(node => !node.closest('#operator-controls')));
  check('Debug page and OBS overlay links are offered', await page.locator('#operator-controls a[href="/debug"]').textContent() === 'Open debug page' &&
    await page.locator('#operator-controls a[href="/overlay"]').getAttribute('target') === '_blank');
  check('Current game profile name is shown', await waitFor(async () => await text('#profile-quick-name') === 'Kerbal Space Program'));
  check('Debug off and available: Start recording is enabled', await text('#debug-toggle') === 'Start recording' && await debugToggle.isEnabled() &&
    await text('#debug-state') === 'Off. Nothing new is recorded.' && await page.locator('#debug-reason').isHidden());
  check('Debug note says turning off keeps history and does not stop detection', (await text('#debug-control > p.small.muted:last-child')).includes('keeps saved history and does not stop detection'));
  check('Loading the desk sends no switch request', switches().length === 0);
  await page.locator('#operator-controls').screenshot({ path: path.join(shots, 'operator-controls.png') });

  // Debug start: disabled in flight, re-reads state, no optimistic label.
  await debugToggle.click();
  check('Start recording sends debug_set enabled=true only', await waitFor(() => release !== null) &&
    JSON.stringify(switches()) === JSON.stringify([{ action: 'debug_set', enabled: true }]));
  check('Recording button is disabled and busy in flight', await debugToggle.isDisabled() && await debugToggle.getAttribute('aria-busy') === 'true' &&
    await text('#debug-state') === 'Starting recording…' && await text('#debug-toggle') === 'Start recording');
  await page.waitForTimeout(2300);
  check('Polling during the request keeps the button disabled', await debugToggle.isDisabled() && switches().length === 1);
  let releasedAt = Date.now(); release();
  check('Success re-reads state and shows Stop recording', await waitFor(async () => await text('#debug-toggle') === 'Stop recording' && await debugToggle.isEnabled()) &&
    stateReads.some(at => at >= releasedAt) && await text('#debug-state') === 'Recording. Frames and model answers are kept on this machine.' &&
    await page.locator('#debug-control').evaluate(node => node.classList.contains('on')));
  check('Debug and detection switches are independent', await text('#perception-toggle') === 'Start detection' && perception.enabled === false);

  // Debug stop fails: server state stays on, the error is clear.
  outcome = 'fail';
  await debugToggle.click(); await waitFor(() => release !== null); release();
  check('Failed stop shows the error and keeps the real state', await waitFor(async () => await page.locator('#debug-error').isVisible()) &&
    await text('#debug-error') === 'Debug recording did not stop: debug unavailable' &&
    await waitFor(async () => await text('#debug-toggle') === 'Stop recording' && await debugToggle.isEnabled()) && debug.enabled === true);

  // Server-side changes arrive by polling.
  outcome = 'ok'; debug = { ...debug, enabled: false };
  check('Polling follows a server-side stop', await waitFor(async () => await text('#debug-toggle') === 'Start recording'));
  debug = { available: false, enabled: false };
  check('Unavailable and off: Start recording is disabled with a reason', await waitFor(async () => await debugToggle.isDisabled()) &&
    await text('#debug-reason') === 'Debug recording is not available on this server.');
  debug = { available: false, enabled: true };
  check('Unavailable but on: Stop recording stays enabled', await waitFor(async () => await text('#debug-toggle') === 'Stop recording' && await debugToggle.isEnabled()) &&
    await page.locator('#debug-reason').isHidden());
  releasedAt = Date.now(); await debugToggle.click(); await waitFor(() => release !== null); release();
  check('Stop succeeds and the error from before clears', await waitFor(async () => await text('#debug-toggle') === 'Start recording' && await debugToggle.isDisabled()) &&
    await page.locator('#debug-error').isHidden() && switches().at(-1).enabled === false);
  debug = null;
  check('Without a debug integration the recording control is hidden', await waitFor(async () => await page.locator('#debug-control').isHidden()));

  // Detection start from the top.
  await page.locator('#perception-toggle').click(); await waitFor(() => release !== null); release();
  check('Start detection sends perception_set enabled=true from the top', await waitFor(async () => await text('#perception-toggle') === 'Stop detection') &&
    JSON.stringify(switches().at(-1)) === JSON.stringify({ action: 'perception_set', enabled: true }));
  await page.locator('#reset-perception').click();
  check('Reset observations sends reset_perception and leaves detection on', await waitFor(() => resets === 1) && perception.enabled === true &&
    await text('#perception-toggle') === 'Stop detection');

  // Profile shortcut: navigate to the protected selector, never apply.
  const before = sent.length;
  await page.locator('#profile-quick-change').click();
  check('Change profile scrolls to and focuses the existing profile selector', await waitFor(() => page.evaluate(() => document.activeElement?.id === 'event-preset-select')) &&
    await page.locator('#event-preset-select').isVisible() && await page.locator('#event-preset-select').evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
  check('The shortcut itself sends no operator action', sent.slice(before).every(item => item === null));
  await page.selectOption('#event-preset-select', 'builtin:generic');
  check('Choosing another profile only previews it; nothing is applied', await page.locator('#event-preset-preview').isVisible() &&
    await page.locator('#event-preset-apply').isVisible() && !sent.slice(before).some(item => item?.action === 'events_profile_activate') &&
    engine.state.event_profile_active_ref?.id === 'ksp' && await text('#profile-quick-name') === 'Kerbal Space Program');
  await page.locator('#event-preset-cancel').click();

  // Narrow layout.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => scrollTo(0, 0));
  const fits = await page.evaluate(() => [...document.querySelectorAll('#operator-controls .control-tile:not([hidden]), #operator-controls button')]
    .every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }) && document.documentElement.scrollWidth <= innerWidth);
  check('Quick controls fit a 390 px viewport without horizontal scroll', fits);
  await page.locator('#operator-controls').screenshot({ path: path.join(shots, 'operator-controls-narrow.png') });

  check('No external requests and no page errors', external.length === 0 && errors.length === 0);
  console.log(`Operator quick controls browser passed: ${checks.length} checks; switch requests=${switches().length}, resets=${resets}; screenshots=shots/operator-controls{,-narrow}.png.`);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
