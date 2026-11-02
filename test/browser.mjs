import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../server/index.js';

// No .env loader, provider credentials, Twitch account, or external requests.
const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });
let compilerCalls = 0;
const app = await createApplication({ demo: true, env: {}, compiler: {
  enabled: true,
  async compile() { compilerCalls++; return { ok: true, moment_id: 'margit', condition: { type: 'count', count: 3 } }; },
  state: () => ({ status: 'simulated', enabled: true }),
} });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: '/tmp' },
});
const results = [], captures = [], failures = [], external = [];
const check = (name, condition) => { assert.ok(condition, name); results.push(name); };
const contexts = [];

async function viewer(role = 'viewer', viewer = 'one', latency = 0) {
  const auth = await (await fetch(`${origin}/demo/auth?viewer=${viewer}&role=${role}&shared=1`)).json();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  contexts.push(context);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: '/* Twitch.ext is supplied by the browser test. */' });
      return route.continue();
    }
    external.push(`${url.origin}${url.pathname}`);
    if (url.hostname === 'extension-files.twitch.tv') return route.fulfill({ contentType: 'text/javascript', body: '/* Offline Twitch helper fixture. */' });
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(({ auth, latency }) => {
    const authorized = [], contexts = [], listeners = new Map();
    let current = { token: auth.token, channelId: auth.channelId, userId: '101', clientId: 'offline-browser-test' };
    const state = { authorizeCallbacks: 0, contextCallbacks: 0, broadcastCallbacks: 0, shares: 0, bitsCalls: 0 };
    window.Twitch = { ext: {
      onAuthorized(fn) { authorized.push(fn); state.authorizeCallbacks++; queueMicrotask(() => fn(current)); },
      onContext(fn) { contexts.push(fn); state.contextCallbacks++; queueMicrotask(() => fn({ hlsLatencyBroadcaster: latency }, ['hlsLatencyBroadcaster'])); },
      listen(topic, fn) { listeners.set(topic, fn); state.broadcastCallbacks++; },
      unlisten(topic) { listeners.delete(topic); },
      actions: { requestIdShare() { state.shares++; window.dispatchEvent(new Event('sealed-identity-shared')); } },
      bits: { useBits() { state.bitsCalls++; throw new Error('Live Bits must remain disabled in browser tests'); }, onTransactionComplete() {}, onTransactionCancelled() {} },
      configuration: { broadcaster: { content: '{}' }, onChanged(fn) { fn(); } },
    } };
    window.__twitchMock = {
      state,
      authorize() { authorized.forEach(fn => fn(current)); },
      context(value) { contexts.forEach(fn => fn(value, Object.keys(value))); },
      publish(value) { listeners.get('broadcast')?.('broadcast', 'application/json', JSON.stringify(value)); },
    };
  }, { auth, latency });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  return { context, page, auth };
}

async function screenshot(page, name, focus) {
  for (const [width, height] of [[1920, 1080], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    if (focus) await focus.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `${name}-${width}x${height}.png`), animations: 'disabled' });
    captures.push(`${name}-${width}x${height}.png`);
    check(`${name}: no horizontal overflow at ${width}×${height}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
}

async function transparent(page, name) {
  await page.setViewportSize({ width: 640, height: 360 });
  const buffer = await page.screenshot({ path: path.join(shots, `${name}-transparent-640x360.png`), omitBackground: true });
  const alpha = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  }, [...buffer]);
  check(`${name} has true transparent background (corner alpha=${alpha})`, alpha === 0);
}

async function operator(page, action) {
  const response = await page.request.post(`${origin}/api/operator/action`, { headers: { 'X-Sealed-Action': '1' }, data: action });
  assert.equal(response.status(), 200, `Operator action ${action.action}`);
  return response.json();
}

async function ebs(auth, route, body) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Authorization: `Bearer ${auth.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status !== 429 || body !== undefined) break;
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  assert.equal(response.status, 200, `EBS ${route}`);
  return response.json();
}

try {
  // The user-facing flow follows below. All writes use the production HTTP routes.
  const metrics = await run();
  check('No unhandled browser errors', failures.length === 0);
  check('No external service requests', external.length === 0);
  await writeFile(path.join(root, 'docs/browser-evidence.md'), evidence({ results, captures, ...metrics }));
  console.log(`Browser verification passed: ${results.length} checks; ${captures.length} viewport screenshots; 2 alpha proofs.`);
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await app.close();
}

async function run() {
  const user = await viewer();
  const panel = user.page;
  await panel.goto(`${origin}/panel.html?demo=1`);
  await panel.getByRole('button', { name: /Prediction/ }).waitFor();
  const beforeMatch = await ebs(user.auth, '/ebs/state');
  const matchWrites = [];
  const observeMatch = request => {
    if (request.method() === 'POST' && ['/ebs/quote', '/ebs/notes'].includes(new URL(request.url()).pathname)) matchWrites.push(request.url());
  };
  panel.on('request', observeMatch);
  await panel.getByText('Describe a condition (optional)', { exact: true }).click();
  await panel.getByLabel('When would you like the note to open?').fill('Open on the third time we beat Margit');
  await panel.getByRole('button', { name: 'Match a moment', exact: true }).click();
  await panel.getByText('Matched: Beat Margit. Review the selected condition, then seal your note.', { exact: true }).waitFor();
  const afterMatch = await ebs(user.auth, '/ebs/state');
  check('Condition matching uses the injected compiler fixture once', compilerCalls === 1);
  check('Condition matching selects the third Margit occurrence', await panel.locator('#moment').inputValue() === 'margit' && await panel.locator('#condition-type').inputValue() === 'count' && await panel.getByRole('spinbutton', { name: 'Occurrence number', exact: true }).inputValue() === '3');
  check('Condition matching leaves wallet and notes unchanged', JSON.stringify(afterMatch.wallet) === JSON.stringify(beforeMatch.wallet) && afterMatch.notes.length === beforeMatch.notes.length);
  check('Condition matching makes no quote or seal request', matchWrites.length === 0);
  panel.off('request', observeMatch);
  await panel.locator('#condition-type').selectOption('moment');
  await panel.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = false; }));
  await panel.getByLabel('What would you like to say?').fill('I predict a clean victory. Chat believes in this run.');
  await panel.getByRole('button', { name: /Prediction/ }).click();
  await panel.getByLabel(/^Open when/).selectOption('margit');
  await panel.getByLabel('Show my Twitch name').check();
  await panel.setViewportSize({ width: 318, height: 640 });
  check('Twitch panel fits a 318px iframe without horizontal overflow', await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot(panel, 'panel-compose', panel.getByLabel('What would you like to say?'));
  await screenshot(panel, 'test-mode-prices', panel.getByLabel('Seal with'));
  check('Every payment option discloses test mode', await panel.getByLabel('Seal with').locator('option').evaluateAll(options => options.every(option => option.textContent.includes('TEST MODE — no real charge'))));
  const lifecycle = await panel.evaluate(() => window.__twitchMock.state);
  check('Extension subscribes to authorization, context, and broadcast', lifecycle.authorizeCallbacks > 0 && lifecycle.contextCallbacks > 0 && lifecycle.broadcastCallbacks > 0);
  check('Identity sharing calls Twitch.ext.actions.requestIdShare', lifecycle.shares === 1);
  await panel.evaluate(() => { window.__twitchMock.authorize(); window.__twitchMock.publish({ type: 'sealed_count', sealedCount: 0 }); });

  let lastSeal = 0;
  async function seal(body, category = 'prediction', moment = 'margit', payment = 'sim_points') {
    // Keep fixture traffic within the same ingress limits as real viewers.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1250 - (Date.now() - lastSeal))));
    lastSeal = Date.now();
    await panel.getByRole('tab', { name: 'Write a note' }).click();
    await panel.getByLabel('What would you like to say?').fill(body);
    await panel.getByRole('button', { name: new RegExp(category, 'i') }).click();
    await panel.getByLabel(/^Open when/).selectOption(moment);
    await panel.getByLabel('Seal with').selectOption(payment);
    const submission = panel.waitForResponse(response => new URL(response.url()).pathname === '/ebs/notes' && response.request().method() === 'POST');
    await panel.getByRole('button', { name: /Seal this note/ }).click();
    const response = await submission;
    assert.equal(response.status(), 200, 'Seal request succeeded');
    const result = await response.json(), note = result.note || result;
    await panel.locator('#receipt').waitFor({ state: 'visible' });
    await panel.waitForFunction(() => document.querySelector('#note-body').value === '');
    check(`${category} submission response hides the body`, !JSON.stringify(result).includes(body));
    check(`${category} sealed DOM hides the body`, await panel.evaluate(body => !document.body.innerText.includes(body) && [...document.querySelectorAll('input,textarea')].every(node => !node.value.includes(body)), body));
    check(`${category} viewer state hides the body`, !JSON.stringify(await ebs(user.auth, '/ebs/state')).includes(body));
    return note;
  }

  const prediction = await seal('I predict a clean victory. Chat believes in this run.', 'prediction', 'margit', 'free');
  check('First note uses the configured free allowance', prediction.payment?.mode === 'free');
  await screenshot(panel, 'sealed-receipt', panel.locator('#receipt'));

  const privateViewer = await viewer('viewer', 'one', 0.8);
  const privatePage = privateViewer.page;
  await privatePage.goto(`${origin}/video_overlay.html?demo=1`);
  await privatePage.waitForResponse(response => new URL(response.url()).pathname === '/ebs/events');
  await screenshot(privatePage, 'overlay-chip');
  await transparent(privatePage, 'video-overlay');
  await privatePage.evaluate(() => window.__twitchMock.context({ hlsLatencyBroadcaster: 0.8 }));
  await privatePage.evaluate(() => {
    window.__toastSeenAt = 0;
    new MutationObserver(() => {
      if (!window.__toastSeenAt && document.querySelector('.toast strong')?.textContent === 'Your note was opened') window.__toastSeenAt = Date.now();
    }).observe(document.body, { childList: true, subtree: true });
  });
  const unrelated = await viewer('viewer', 'three');
  await unrelated.page.goto(`${origin}/video_overlay.html?demo=1`);
  await unrelated.page.waitForResponse(response => new URL(response.url()).pathname === '/ebs/events');
  let deliveredAt = 0;
  privatePage.on('response', async response => {
    if (new URL(response.url()).pathname !== '/ebs/events') return;
    const value = await response.json().catch(() => ({}));
    if (value.events?.some(event => event.type === 'opened' && event.note_id === prediction.id)) deliveredAt ||= Date.now();
  });

  const operatorView = await viewer();
  const consolePage = operatorView.page;
  await consolePage.goto(`${origin}/console`);
  await consolePage.request.get(`${origin}/api/operator/bootstrap`);
  const obs = (await viewer()).page;
  await obs.goto(`${origin}/overlay`);
  await consolePage.getByLabel('What just happened?').fill('A clean victory. The prediction came true.');
  const momentAction = consolePage.waitForResponse(response => new URL(response.url()).pathname === '/api/operator/action' && response.request().postDataJSON()?.action === 'moment');
  // The offline demo runs Beat Margit as a current-profile event; there is no history list to open.
  await consolePage.locator('.moment-row').filter({ hasText: 'Beat Margit' }).getByRole('button', { name: 'Declare moment' }).click();
  assert.equal((await momentAction).status(), 200, 'Console declares the moment through HTTP');
  await obs.getByText('CALLED IT', { exact: true }).waitFor();
  check('Declared moment reveals the prediction', await obs.locator('.reveal-body').innerText() === 'I predict a clean victory. Chat believes in this run.');
  const predictionColor = await obs.locator('.reveal-card').evaluate(node => node.style.getPropertyValue('--category'));
  await screenshot(obs, 'reveal-prediction-called-it', obs.locator('.reveal-card'));
  await transparent(obs, 'obs-overlay');
  await privatePage.getByText('Your note was opened', { exact: true }).waitFor({ timeout: 10000 });
  const toastAt = await privatePage.evaluate(() => window.__toastSeenAt);
  check('Private notification follows its server event', deliveredAt > 0);
  check('Private notification honors broadcaster latency', toastAt - deliveredAt >= 650 && toastAt - deliveredAt <= 1600);
  check('Another viewer does not receive the private toast', await unrelated.page.locator('.toast').count() === 0 && !(await ebs(unrelated.auth, '/ebs/events')).events.some(event => event.note_id === prediction.id));
  await screenshot(privatePage, 'private-toast', privatePage.locator('.toast'));
  await operator(consolePage, { action: 'skip' });

  const fixtures = [
    ['advice', 'Try rolling toward the attack. Save a little stamina.'],
    ['joke', 'That boss owes chat a refund.'],
    ['encouragement', 'You have got this. Keep going, we believe in you.'],
  ];
  const observedColors = new Set();
  for (const [category, body] of fixtures) {
    const note = await seal(body, category);
    check(`Approved ${category} note uses simulated points`, note.payment?.mode === 'sim_points' && note.status === 'sealed');
    await operator(consolePage, { action: 'moment', moment_id: 'margit', context: 'Streamer confirmed this clean victory.' });
    await obs.getByText(body, { exact: true }).waitFor();
    observedColors.add(await obs.locator('.reveal-card').evaluate(node => node.style.getPropertyValue('--category')));
    await screenshot(obs, `reveal-${category}`, obs.locator('.reveal-card'));
    await operator(consolePage, { action: 'skip' });
  }
  observedColors.add(predictionColor);
  check('All four category envelope colors differ', observedColors.size === 4);

  const archive = (await viewer()).page;
  await archive.goto(`${origin}/archive`);
  await archive.getByText('I predict a clean victory. Chat believes in this run.', { exact: true }).waitFor();
  const publicArchive = await (await fetch(`${origin}/api/archive`)).json();
  check('Public archive contains each revealed category', fixtures.every(([category]) => publicArchive.notes.some(note => note.category_id === category)) && publicArchive.notes.some(note => note.id === prediction.id));

  // The hidden 'never' moment is no longer offered. Key never occurs in this run, so wrap-up still reels and refunds it.
  const neverNote = await seal('A secret for a moment that never came.', 'joke', 'key');
  const held = await seal('[demo:hold] Please let a moderator review this encouragement.', 'encouragement', 'key');
  check('Uncertain moderation holds without charge', ['held', 'pending_review'].includes(held.status) && !held.payment?.txn_id);
  await consolePage.reload();
  await consolePage.getByText('[demo:hold] Please let a moderator review this encouragement.', { exact: true }).waitFor();
  await screenshot(consolePage, 'console-review-queue', consolePage.locator('#review-queue'));
  const reviewAction = consolePage.waitForResponse(response => new URL(response.url()).pathname === '/api/operator/action');
  await consolePage.locator('#review-queue').getByRole('button', { name: 'Reject', exact: true }).click();
  assert.equal((await reviewAction).status(), 200, 'Console rejects the held note through HTTP');
  const afterReview = await ebs(user.auth, '/ebs/state');
  check('Operator rejection updates the private receipt', afterReview.notes.some(note => note.id === held.id && note.status === 'rejected'));

  const configPage = (await viewer('broadcaster')).page;
  await configPage.goto(`${origin}/config.html?demo=1&role=broadcaster`);
  await configPage.getByText('Your rules are ready to edit.', { exact: true }).waitFor();
  await configPage.getByLabel(/^Strictness/).selectOption('strict');
  await configPage.getByLabel('Open clip moments when a new clip appears').check();
  await configPage.getByLabel('Open chat moments when activity rises').check();
  await configPage.getByLabel('Chat window in seconds').fill('12');
  await configPage.getByLabel('Messages in that window').fill('7');
  await configPage.getByLabel('Minimum different viewers').fill('3');
  await configPage.getByLabel('Seconds between chat moments').fill('45');
  const timer = configPage.locator('.moment-editor').filter({ has: configPage.locator('select[data-key="trigger_type"] option[value="stream_minutes"]:checked') });
  await timer.getByLabel('Stream minute').fill('22');
  const saveAction = configPage.waitForResponse(response => new URL(response.url()).pathname === '/ebs/config' && response.request().method() === 'POST');
  await configPage.getByRole('button', { name: 'Save changes' }).click();
  assert.equal((await saveAction).status(), 200, 'Broadcaster saves settings through HTTP');
  check('Broadcaster moderation configuration persists', (await ebs((await viewer('broadcaster')).auth, '/ebs/config')).config.moderation.strictness === 'strict');
  const savedConfig = app.engine.config;
  check('Clip and chat signal toggles persist without a live connection', savedConfig.signals.clip_poll_enabled === true && savedConfig.signals.chat_spike.enabled === true);
  check('Chat activity thresholds persist from the configuration UI', savedConfig.signals.chat_spike.window_seconds === 12 && savedConfig.signals.chat_spike.min_messages === 7 && savedConfig.signals.chat_spike.min_viewers === 3 && savedConfig.signals.chat_spike.cooldown_seconds === 45);
  check('Stream timer minute persists from the configuration UI', savedConfig.moments.find(moment => moment.id === 'stream-15')?.trigger?.minutes === 22);
  await screenshot(configPage, 'config', configPage.locator('#signals'));

  await operator(consolePage, { action: 'wrap' });
  await obs.getByText(/never happened/i).first().waitFor();
  // The reel opens its sample first, then displays the count card.
  await operator(consolePage, { action: 'skip' });
  await obs.locator('.reel-count').waitFor();
  await screenshot(obs, 'never-opened-reel');
  check('Never-opened reel refunds the simulated payment', (await ebs(user.auth, '/ebs/state')).notes.find(note => note.id === neverNote.id)?.payment?.refund_reason === 'never');
  check('Live Bits were never invoked', await panel.evaluate(() => window.__twitchMock.state.bitsCalls === 0));

  return { deliveredAt, toastAt, observedColors };
}

function evidence({ results, captures, deliveredAt, toastAt, observedColors }) {
  return `# Browser evidence\n\nGenerated by \`npm run test:browser\` on ${new Date().toISOString()}.\n\nThe harness runs the real HTTP application with an in-memory demo store and an independent Twitch Extension mock. It never loads \`.env\`. Chromium receives a minimal environment. Requests outside the loopback application are blocked. No Twitch, Helix, PubSub, Decisions, or payment service is contacted.\n\n## Results\n\n${results.map(name => `- PASS: ${name}`).join('\n')}\n\nPrivate event delivery to toast: **${toastAt - deliveredAt} ms**, with **800 ms** of mocked broadcaster latency. Category colors: ${[...observedColors].map(color => `\`${color}\``).join(', ')}.\n\n## Screenshots\n\nEach scene has an exact 1920×1080 capture and an exact 640×360 capture. Compose and pricing captures scroll to the relevant control. These are viewport captures, not full-page images.\n\n| Scene | 1920×1080 | 640×360 |\n| --- | --- | --- |\n${captures.filter(name => name.endsWith('1920x1080.png')).map(name => { const scene = name.replace('-1920x1080.png', ''); return `| ${scene} | [View](../shots/${name}) | [View](../shots/${scene}-640x360.png) |`; }).join('\n')}\n\nAdditional alpha-channel proofs: [OBS overlay](../shots/obs-overlay-transparent-640x360.png), [Extension video overlay](../shots/video-overlay-transparent-640x360.png). Both corner pixels have alpha 0.\n\n## Scope\n\nThe checks cover browser composition, real HTTP submission, private receipts, manual moment declaration, canonical reveal, the public archive, hold/reject review, simulated prices, the wrap-up reel, and mocked Extension authorization/context/broadcast lifecycle. The screenshot fixtures include four category colors and the CALLED IT verdict. The configuration captures show saved clip/chat toggles and activity thresholds. A saved stream-timer minute is also checked.\n\nThe condition-matching test injects an enabled fake compiler that returns a third-occurrence Margit condition. It verifies the UI result, unchanged wallet and notes, and the absence of quote/seal requests. This is a fixture test, not proof that Codex ran a runtime compilation. No compiler child process is started.\n\nTwitch Hosted Test, real Extension PubSub delivery, live Decisions judgements, an OBS Browser Source, real viewer latency, and a live broadcast remain unverified. The demonstrated prediction verdict and moderation marker are deterministic demo fixtures.\n`;
}
