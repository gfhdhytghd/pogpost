import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { DebugRecorder } from '../server/debug-recorder.js';

// Debug workbench acceptance: the real debug recorder in a throwaway directory, real operator HTTP routes
// and an isolated headless browser. Frames are generated PNGs; no OBS capture, model request or Twitch call.
const root = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(os.tmpdir(), 'sealed-debug-ui-'));
const recorder = await DebugRecorder.open({ directory: path.join(directory, 'debug'), maxFrames: 104 });
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
const server = await createHTTP({ root, engine, demo: true, debugRecorder: recorder });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// A small 320×180 PNG: a sky gradient with a frame-specific horizon band.
function png(index) {
  const width = 320, height = 180, rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const band = Math.abs(y - (60 + (index * 7) % 80)) < 6, ground = y > 130;
      row.set(band ? [240, 190 - index % 60, 80] : ground ? [70 + index % 40, 110, 70] : [40 + y / 3, 70 + y / 2, 150 + x / 6], 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}
const base = Date.now() - 60_000;
const record = index => recorder.recordFrame({ id: `capture-${index}`, at: base + index * 250, dataUrl: png(index) });
const hostile = '<img src=x onerror="window.__pwned=1">Launch';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], actions = [], imageHits = new Map();
let bootstraps = 0;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push(route.request().url()); return route.abort('blockedbyclient');
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const { pathname } = new URL(request.url());
  if (pathname === '/api/operator/bootstrap') bootstraps++;
  if (pathname.startsWith('/api/operator/debug/frame/')) imageHits.set(pathname, (imageHits.get(pathname) || 0) + 1);
  if (request.method() === 'POST' && pathname === '/api/operator/action') actions.push(JSON.parse(request.postData()));
});
const feedReads = () => new Promise(resolve => page.once('response', function wait(response) {
  if (new URL(response.url()).pathname === '/api/operator/debug' && !new URL(response.url()).search.includes('_id=')) resolve(); else page.once('response', wait);
}));
const tiles = () => page.locator('#frame-grid .frame-tile');
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

try {
  // Open from the operator desk, which sets the private cookies.
  await page.goto(`${origin}/console`);
  await page.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Debug', exact: true }).click();
  await page.waitForURL(`${origin}/debug`);
  await page.locator('#recorder-state').getByText('Off. Nothing is being recorded.', { exact: true }).waitFor();
  check('The console links to /debug and the page loads its own files', await page.title() === 'Recognition debug · Sealed Notes' && await page.locator('link[href="/debug/debug.css"]').count() === 1);
  check('Recording is off by default and says nothing is kept', await page.locator('#recorder-toggle').getAttribute('aria-checked') === 'false' &&
    await page.getByText('Recording is off. Turn it on to keep the frames captured from now on.', { exact: true }).isVisible());
  const fresh = await browser.newContext(); const direct = await fresh.newPage();
  await direct.goto(`${origin}/debug`);
  await direct.locator('#recorder-state').getByText('Off. Nothing is being recorded.', { exact: true }).waitFor();
  check('Opening /debug directly signs in through bootstrap and lands on the page', new URL(direct.url()).pathname === '/debug');
  await fresh.close();
  check('A frame offered while off is not recorded', record(0) === null && recorder.state().stats.frames === 0);

  await page.click('#recorder-toggle');
  await page.locator('#recorder-toggle[aria-checked="true"]').waitFor();
  check('The switch sends debug_set and turns recording on', actions.at(-1).action === 'debug_set' && actions.at(-1).enabled === true && recorder.state().enabled === true &&
    await page.getByText('Recording. Frames appear here as the picture watcher captures them.', { exact: true }).isVisible());

  // 106 frames against a 104-frame cap: two expire. Requests use the newest seven.
  // The recorder admits at most 64 queued writes, so record in batches as a live capture loop would.
  const ids = [];
  for (let index = 1; index <= 106; index++) { ids.push(record(index)); if (index % 40 === 0) await recorder.flush(); }
  const recent = ids.slice(-7);
  const definitions = [{ id: 'ksp-launch', label: hostile, description: 'A vessel leaves the pad. <script>window.__pwned=2</script>', mode: 'persistent', min_confidence: 0.85 }];
  const screen = recorder.beginRequest({ stage: 'screen', frames: [recent[6]], definitions });
  recorder.finishRequest(screen, { outcome: 'completed', latency_ms: 412, raw: { answers: [{ name: 'scene', type: 'choice', choice: 'gameplay', confidence: 0.97 }, { name: 'event:ksp-launch', type: 'choice', choice: 'yes', confidence: 0.91 }] },
    normalized: { valid: true, scene: 'gameplay', events: { 'ksp-launch': { choice: 'yes', confidence: 0.91 } } }, usage: { input_tokens: 812, output_tokens: 40, total_tokens: 852 } });
  const order = [recent[2], recent[4], recent[3], recent[5], recent[6]];
  const review = recorder.beginRequest({ stage: 'review', frames: order, definitions });
  recorder.finishRequest(review, { outcome: 'completed', latency_ms: 655, raw: { answers: [{ name: 'continuity', type: 'choice', choice: 'same', confidence: 0.88 }, { name: 'event:ksp-launch', type: 'refusal' }, { name: 'scene', type: 'choice', choice: 'banana', confidence: 0.5 }] },
    normalized: { valid: true, continuity: 'same', events: { 'ksp-launch': { choice: 'unsure', confidence: null } } } });
  recorder.recordDecision({ kind: 'candidate', reason: 'review_confirmed', event_id: 'ksp-launch', request_id: review, confidence: 0.91, threshold: 0.85, accepted: true });
  const timeout = recorder.beginRequest({ stage: 'review', frames: recent.slice(0, 5), definitions });
  recorder.finishRequest(timeout, { outcome: 'timeout', latency_ms: 800 });
  await recorder.flush();

  await tiles().nth(99).waitFor();
  check('The newest page shows 100 frames, newest first', await tiles().count() === 100 && await tiles().first().locator('.frame-seq').textContent() === `#${recorder.frames.at(-1).seq}`);
  check('Capacity loss is shown, not silent', await page.locator('#stat-images').textContent() === '104 / 104' && await page.locator('#stat-expired').textContent() === '2' &&
    (await page.locator('#recorder-capacity').textContent()).startsWith('2 older frames were removed'));
  const newest = tiles().first();
  check('Frames carry screening and review badges', await newest.locator('.tone-screen').count() === 1 && await newest.locator('.tone-review').count() === 1 &&
    await tiles().nth(1).locator('.tone-screen').count() === 0 && await tiles().nth(1).locator('.tone-review').count() === 1 && await tiles().nth(20).getByText('Kept only', { exact: true }).count() === 1);
  await page.waitForFunction(() => [...document.querySelectorAll('#frame-grid img')].slice(0, 7).every(image => image.complete && image.naturalWidth === 320));
  check('Thumbnails load from the cookie-protected frame route', await page.evaluate(() => [...document.querySelectorAll('img')].every(image => new URL(image.src).pathname.startsWith('/api/operator/debug/frame/'))));
  await page.screenshot({ path: path.join(shots, 'debug-overview.png') });

  // Filters.
  await page.getByRole('radio', { name: 'Screening' }).click();
  check('Screening shows only frames sent for screening', await tiles().count() === 1);
  await page.keyboard.press('ArrowRight');
  check('Arrow keys move between filters; Review shows the review frames', await page.getByRole('radio', { name: 'Review' }).getAttribute('aria-checked') === 'true' && await tiles().count() === 7);
  await page.getByRole('radio', { name: 'Requests' }).click();
  check('Requests lists all three with stage and status', await page.locator('#request-list .request-row').count() === 3 && await page.locator('#request-list .tone-timeout').count() === 1);

  // Request detail: the exact ordered frames, answers and normalized result.
  await page.locator(`[data-key="request:${review}"]`).click();
  await page.locator('#inspector .frame-strip').waitFor();
  const strip = await page.locator('#inspector .strip-frame').evaluateAll(nodes => nodes.map(node => [node.dataset.position, node.dataset.key, node.querySelector('img')?.getAttribute('src')]));
  check('The review shows its five frames in the order sent', JSON.stringify(strip) === JSON.stringify(order.map((id, index) => [String(index + 1), `frame:${id}`, `/api/operator/debug/frame/${id}`])));
  const answerRow = name => page.locator('#inspector .answers tbody tr').filter({ has: page.locator('.answer-name', { hasText: new RegExp(`^${name}$`) }) });
  check('Model answers show choice and exact confidence', await page.locator('#inspector .answers tbody tr').count() === 3 && await answerRow('continuity').getByText('88%', { exact: true }).isVisible());
  check('A valid refusal reads Refused and is not called malformed', await answerRow('event:ksp-launch').getByText('Refused', { exact: true }).isVisible() &&
    await answerRow('event:ksp-launch').getByText('Malformed answer', { exact: true }).count() === 0);
  check('A truly malformed answer still reads Malformed answer', await answerRow('scene').getByText('Malformed answer', { exact: true }).isVisible());
  check('Normalized result, decision and timestamps are shown', (await page.locator('#inspector .json').first().textContent()).includes('"continuity": "same"') &&
    (await page.locator('#inspector .decision-list').textContent()).includes('candidate · ksp-launch · review_confirmed · confidence 91% of 85% · accepted') && await page.locator('#inspector .inspector-facts time').count() === 2);
  check('Hostile event text renders as text', await page.locator('#inspector .definition-list strong').textContent() === hostile && await page.evaluate(() => window.__pwned === undefined && !document.querySelector('img[src="x"]') && !document.querySelector('#inspector script')));
  await page.locator('#inspector details.raw-output summary').click();
  await feedReads(); await feedReads();
  check('Polling keeps the selected request and the open raw output', await page.locator('#inspector-title').textContent() === 'Review request' && await page.locator('#inspector details.raw-output').getAttribute('open') !== null);
  await page.locator('#inspector').screenshot({ path: path.join(shots, 'debug-request.png') });

  await page.locator(`[data-key="request:${timeout}"]`).click();
  await page.locator('#inspector .request-problem').waitFor();
  check('A timed-out request states its status and missing output', await page.locator('#inspector .request-problem').textContent() === 'Timed out: timeout. The model returned no structured output.' &&
    (await page.locator('#inspector .answers, #inspector .inspector-section p').allTextContents()).includes('No structured answers.'));

  // Frame detail with its requests; a strip frame opens the frame.
  await page.locator(`[data-key="request:${review}"]`).click();
  await page.locator(`#inspector [data-key="frame:${recent[6]}"]`).click();
  await page.locator('#inspector .frame-large img').waitFor();
  check('A frame opens large with its capture facts and both requests', await page.locator('#inspector-title').textContent() === `Frame #${recorder.frames.find(item => item.id === recent[6]).seq}` &&
    await page.locator('#inspector .linked-request').count() === 2 && await page.locator('#inspector .inspector-facts').getByText('320 × 180', { exact: true }).isVisible() &&
    await page.locator('#inspector .linked-request').getByText('frame 5 of 5 · ', { exact: true }).count() === 1);

  // Paging by the server cursor. Page 2 also exercises each image failure:
  // 404 after deletion, a 401 that renews the sign-in once, a 503, and a write still in progress.
  await page.getByRole('radio', { name: 'All frames' }).click();
  const [gone, renewed, flaky, pendingFrame] = recorder.frames.slice(0, 4), frameUrl = frame => `${origin}/api/operator/debug/frame/${frame.id}`;
  await unlink(path.join(directory, 'debug', 'frames', `${gone.id}.png`));
  let unauthorized = 2;
  await page.route(frameUrl(renewed), route => unauthorized-- > 0 ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"operator_cookie_required"}' }) : route.continue());
  await page.route(frameUrl(flaky), route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"service_unavailable"}' }));
  await page.route(url => url.pathname === '/api/operator/debug' && url.searchParams.has('before'), async route => {
    const response = await route.fetch(), body = await response.json();
    for (const frame of body.frames) if (frame.id === pendingFrame.id) frame.image_available = false;
    await route.fulfill({ response, json: body });
  });
  const beforeRenew = bootstraps;
  await page.click('#page-next');
  await page.locator('#page-label').getByText('Page 2', { exact: true }).waitFor();
  check('Older shows the remaining frames by cursor', await tiles().count() === 4 && await page.locator('#page-next').isDisabled());
  const tileText = frame => page.locator(`[data-key="frame:${frame.id}"] .frame-picture`);
  await tileText(gone).getByText('Image expired', { exact: true }).waitFor();
  await tileText(flaky).getByText('Image unavailable', { exact: true }).waitFor();
  await page.waitForFunction(id => document.querySelector(`[data-key="frame:${id}"] img`)?.naturalWidth === 320, renewed.id);
  check('A 401 image renews the sign-in once and then loads', bootstraps === beforeRenew + 1 && unauthorized <= 0);
  check('A 503 image reads unavailable; a write in progress reads not stored yet', await tileText(pendingFrame).textContent() === 'Image not stored yet');
  const goneUrl = `/api/operator/debug/frame/${gone.id}`, goneHits = imageHits.get(goneUrl);
  await page.locator(`[data-key="frame:${gone.id}"]`).click();
  await page.locator('#inspector .frame-large .frame-missing').waitFor();
  check('Only a 404 marks an image expired for good; it is not requested again', await page.locator('#inspector .frame-large').textContent() === 'Image expired' && imageHits.get(goneUrl) === goneHits && goneHits === 2);
  await page.unroute(frameUrl(flaky));
  await page.locator(`[data-key="frame:${flaky.id}"]`).click();
  await page.locator('#inspector .frame-large img').waitFor();
  check('An unavailable image is not marked expired and loads once the server recovers', await page.locator('#inspector .frame-large img').evaluate(image => image.decode().then(() => image.naturalWidth === 320, () => false)));
  await page.screenshot({ path: path.join(shots, 'debug-image-states.png') });
  await page.click('#page-prev');
  await page.locator('#page-label').getByText('Page 1', { exact: true }).waitFor();
  await tiles().nth(99).waitFor();
  const loaded = new Map(imageHits);
  await feedReads(); await feedReads();
  check('Newer returns to the live page, and polling does not reload thumbnails', await tiles().count() === 100 && [...imageHits].every(([url, count]) => loaded.get(url) === count));

  // No embedded image data anywhere.
  const feed = await page.evaluate(async () => (await fetch('/api/operator/debug?limit=5')).text());
  check('Neither the feed nor the page embeds image data', !/base64|data:image/.test(feed) && !/data:image|;base64,/.test(await page.content()));

  // A lost operator cookie is renewed once.
  const before = bootstraps;
  await context.clearCookies();
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/operator/bootstrap');
  await feedReads(); await feedReads();
  check('A 401 renews the operator cookie once and the page keeps working', bootstraps === before + 1 && !(await page.locator('#status').getAttribute('class')).includes('error'));

  await page.click('#recorder-toggle');
  await page.locator('#recorder-toggle[aria-checked="false"]').waitFor();
  const kept = recorder.state().stats.frames;
  check('Turning recording off stops new frames', actions.at(-1).enabled === false && record(500) === null && recorder.state().stats.frames === kept &&
    await page.locator('#recorder-state').textContent() === 'Off. Nothing is being recorded.');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator(`[data-key="frame:${recent[6]}"]`).click();
  await page.screenshot({ path: path.join(shots, 'debug-dark.png') });
  await page.setViewportSize({ width: 390, height: 900 });
  check('Narrow layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(shots, 'debug-narrow.png') });
  check('No external requests or browser errors occurred', external.length === 0 && errors.length === 0);
  console.log(`Debug browser passed: ${checks.length} checks; screenshots=shots/debug-{overview,request,image-states,dark,narrow}.png.`);
} finally {
  await context.close(); await browser.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await recorder.close(); await rm(directory, { recursive: true, force: true });
}
