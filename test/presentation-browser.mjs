import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// Manual presentation, end to end on the real local HTTP app and an in-memory engine:
// console stage preview (operator frame), OBS overlay, and the panel's Watch tab.
// No OBS, Twitch, Decisions, .env or user browser profile.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
await engine.updateConfig({ reveal: { mode: 'manual' } });
const author = { opaqueId: 'Upresentation', role: 'viewer' };
const CANARY = 'PRESENTATION_SEALED_CANARY';
const ids = [];
for (const [index, moment] of ['margit', 'margit', 'margit', 'key'].entries()) {
  const receipt = await engine.submit(author, { body: `${CANARY} ${index} keep going`, category_id: index === 1 ? 'joke' : 'advice', moment_id: moment, payment_mode: 'sim_points' });
  ids.push(receipt.id ?? receipt.note?.id);
}
const server = await createHTTP({ root, engine, demo: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [], actions = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

// Every overlay frame counts the reveals it starts and remembers each phase it shows.
const instrument = () => {
  window.__shows = 0; window.__phases = [];
  new MutationObserver(records => { for (const record of records) {
    for (const node of record.addedNodes) if (node.classList?.contains('show')) { window.__shows++; window.__phases.push(node.dataset.phase); }
    for (const node of record.addedNodes) if (node.classList?.contains('env3d') || node.classList?.contains('ob-flap')) window.__flights = (window.__flights || 0) + 1;
    if (record.type === 'attributes' && record.target.classList?.contains('show')) window.__phases.push(record.target.dataset.phase);
  } }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] });
};
let staleSnapshot = null, override = null;
const EXTENSION_CSP = "default-src 'self'; script-src 'self'; frame-ancestors https://supervisor.ext-twitch.tv";
async function context({ width, height }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  ctx.setDefaultTimeout(10000);
  await ctx.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
    if (request.method() === 'POST' && url.pathname === '/api/operator/action') { const body = JSON.parse(request.postData() || '{}'); if (['reveal', 'skip'].includes(body.action)) actions.push(body); }
    if (url.pathname === '/api/overlay' && staleSnapshot && request.frame().url().includes('/overlay') && !request.frame().url().includes('operator=1')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleSnapshot) });
    if (url.pathname === '/api/overlay' && override) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(override()) });
    // Extension pages get a Twitch-like policy: only the supervisor may frame them, so the panel
    // cannot frame its own pages by URL, and subresources must be same-origin.
    if (['/panel.html', '/video_overlay.html'].includes(url.pathname)) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': EXTENSION_CSP } });
    }
    return route.continue();
  });
  await ctx.addInitScript(instrument);
  return ctx;
}
const until = async (predicate, timeout = 8000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 80)); } return false; };
// A narrow frame hangs fewer envelopes and counts the rest on the tally.
const onLine = () => document.querySelectorAll('.hang').length + (Number(document.querySelector('#more-count')?.textContent.match(/\d+/)?.[0]) || 0);
const phase = frame => frame.evaluate(() => document.querySelector('.show')?.dataset.phase || null);

try {
  // ——— Pages ———
  const consoleCtx = await context({ width: 1440, height: 1100 }), consolePage = await consoleCtx.newPage();
  consolePage.on('pageerror', error => errors.push(`console: ${error.message}`));
  await consolePage.goto(`${origin}/console`);
  const stageHandle = await consolePage.locator('#stage-frame').elementHandle(), stage = await stageHandle.contentFrame();
  await stage.waitForLoadState(); await stage.evaluate(() => document.fonts.ready);

  const obsCtx = await context({ width: 1280, height: 720 }), obs = await obsCtx.newPage();
  obs.on('pageerror', error => errors.push(`obs: ${error.message}`));
  await obs.goto(`${origin}/overlay`);

  const viewerCtx = await context({ width: 340, height: 720 }), panel = await viewerCtx.newPage();
  panel.on('pageerror', error => errors.push(`panel: ${error.message}`));
  await panel.goto(`${origin}/panel.html?demo=1&viewer=two`);
  check('Panel loads no overlay frame before Watch is chosen', await panel.locator('#watch-stage iframe').count() === 0);
  await panel.getByRole('tab', { name: 'Watch' }).click();
  check('Watch tab shows its view and hides the writing view', await panel.locator('#watch-view').isVisible() && await panel.locator('#compose-view').isHidden());
  const watch = await (await panel.locator('#watch-stage iframe').elementHandle()).contentFrame();
  check('Watch frame is a srcdoc document, not a framed extension URL', watch.url() === 'about:srcdoc');
  const srcdoc = await panel.locator('#watch-stage iframe').getAttribute('srcdoc');
  check('Watch template is static: no helper, no user text, embedded flag set', srcdoc.includes('data-embedded="true"') && !/twitch-ext|helper/i.test(srcdoc) && !srcdoc.includes(CANARY) && !/https?:/.test(srcdoc));
  // Negative control: under the same policy, framing the overlay by URL is refused.
  await panel.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'by-url'; frame.src = './video_overlay.html'; document.body.append(frame); });
  await panel.waitForTimeout(1200);
  const byUrl = await (await panel.locator('#by-url').elementHandle()).contentFrame();
  check('Negative control: the policy blocks framing the overlay by URL', !(await byUrl.evaluate(() => !!document.querySelector('#reveal-stage')).catch(() => false)));
  await panel.evaluate(() => document.querySelector('#by-url').remove());
  errors.splice(0, errors.length, ...errors.filter(message => !/frame-ancestors/.test(message)));
  const frameRequests = [];
  panel.on('request', request => { if (request.frame() === watch && /\/(ebs|api)\//.test(new URL(request.url()).pathname)) frameRequests.push(request.url()); });

  // ——— Before the moment: all four hang on the line, nothing is ready ———
  for (const [name, frame] of [['stage', stage], ['OBS', obs], ['Watch', watch]])
    check(`${name}: four envelopes on the line, none ready`, await until(() => frame.evaluate(`(${onLine})() === 4 && !document.querySelector('.ready-item')`)));
  check('Sealed queue opens nothing before its moment', await until(async () => await consolePage.locator('#sealed-queue').getByText('Waiting for its moment').count() === 4 && await consolePage.locator('#sealed-queue').getByRole('button', { name: 'Open this note' }).count() === 0));

  // ——— Declare: every matching envelope gets ready; nothing opens by itself ———
  await engine.occur('margit', 'Streamer declared this moment.', 'streamer');
  for (const [name, frame] of [['stage', stage], ['OBS', obs], ['Watch', watch]])
    check(`${name}: three envelopes fly to the ready row, one stays on the line`, await until(() => frame.evaluate(`document.querySelectorAll('.ready-item').length === 3 && (${onLine})() === 1`)));
  await consolePage.waitForTimeout(1200);
  check('Declaring opens no envelope', engine.state.current_id === null && !(await stage.locator('.show').count()) && !(await obs.locator('.show').count()));
  check('Only the stage preview has Open buttons', await stage.locator('button.ready-env').count() === 3 && await obs.locator('button').count() === 0 && await watch.locator('button').count() === 0);
  check('Open buttons name the sender and moment', (await stage.locator('button.ready-env').first().getAttribute('aria-label')).startsWith('Open the envelope from A viewer for Beat Margit'));
  check('Sealed queue lists three ready notes and one waiting', await until(async () => await consolePage.locator('#sealed-queue').getByRole('button', { name: 'Open this note' }).count() === 3 && await consolePage.locator('#sealed-queue').getByText('Waiting for its moment').count() === 1));
  check('Close note is unavailable with nothing open', await consolePage.locator('#skip').textContent() === 'Close note' && await consolePage.locator('#skip').isDisabled());
  for (const [name, page] of [['console', consolePage], ['OBS', obs], ['panel', panel]])
    check(`${name}: no sealed body anywhere in the DOM`, !(await Promise.all(page.frames().map(frame => frame.content()))).join('').includes(CANARY));
  await consolePage.screenshot({ path: path.join(shots, 'presentation-console-ready.png'), fullPage: false });
  await obs.screenshot({ path: path.join(shots, 'presentation-obs-ready-1280.png') });
  await panel.screenshot({ path: path.join(shots, 'presentation-panel-watch-ready.png') });

  // ——— Forged messages do nothing ———
  const target = engine.state.queue[0].id;
  await consolePage.evaluate(id => window.postMessage({ type: 'sealed-overlay-open', id }, location.origin), target);
  await watch.evaluate(id => window.parent.postMessage({ type: 'sealed-overlay-open', id }, new URL(document.baseURI).origin), target);
  await consolePage.waitForTimeout(700);
  check('Messages that are not from the stage frame open nothing', actions.length === 0 && engine.state.current_id === null);

  // ——— Open from the stage preview ———
  const openedAt = Date.now();
  await stage.locator(`.ready-item[data-id="${target}"] button`).click();
  check('The stage asks the console, and the console opens that note', await until(() => engine.state.current_id === target) && actions.length === 1 && actions[0].action === 'reveal' && actions[0].id === target);
  check('Other ready envelopes lock while a letter is open', await until(() => stage.evaluate(() => [...document.querySelectorAll('button.ready-env')].every(button => button.disabled))));
  for (const [name, frame] of [['stage', stage], ['OBS', obs], ['Watch', watch]])
    check(`${name}: the same letter opens and becomes readable`, await until(() => frame.evaluate(() => document.querySelector('.show')?.dataset.phase === 'reading'), 6000) && (await frame.locator('.show .reveal-body').textContent()).includes(`${CANARY} `));
  const opened = await Promise.all([stage, obs, watch].map(frame => frame.evaluate(() => ({ shows: window.__shows, phases: window.__phases, flights: window.__flights || 0 }))));
  check('Every view plays the opening once', opened.every(item => item.shows === 1 && item.phases.includes('opening') && item.flights > 0));
  check('Ready rows keep the other two', (await Promise.all([stage, obs, watch].map(frame => frame.locator('.ready-item').count()))).every(count => count === 2));
  const otherBodies = engine.state.notes.filter(note => note.id !== target).map(note => note.body);
  check('Unopened bodies stay out of every view', (await Promise.all([consolePage, obs, panel].flatMap(page => page.frames().map(frame => frame.content())))).every(html => otherBodies.every(body => !html.includes(body))));
  check('Close note appears only in the stage preview', await stage.locator('#close-note').isVisible() && await obs.locator('#close-note').count() === 0 && await watch.locator('#close-note').count() === 0);
  await stage.page().waitForTimeout(0);
  await consolePage.screenshot({ path: path.join(shots, 'presentation-console-open.png') });
  await obs.screenshot({ path: path.join(shots, 'presentation-obs-open-1280.png') });
  await panel.screenshot({ path: path.join(shots, 'presentation-panel-watch-open.png') });

  // ——— A viewer who joins late reads the letter at once ———
  await new Promise(resolve => setTimeout(resolve, Math.max(0, openedAt + 3200 - Date.now())));
  const lateCtx = await context({ width: 340, height: 720 }), late = await lateCtx.newPage();
  late.on('pageerror', error => errors.push(`late: ${error.message}`));
  await late.goto(`${origin}/panel.html?demo=1&viewer=three`);
  await late.getByRole('tab', { name: 'Watch' }).click();
  const lateFrame = await (await late.locator('#watch-stage iframe').elementHandle()).contentFrame();
  check('Late join skips the opening and shows the letter', await until(() => lateFrame.evaluate(() => document.querySelector('.show')?.dataset.phase === 'reading'), 4000) &&
    !(await lateFrame.evaluate(() => window.__flights || 0)));

  // ——— No automatic exit in manual mode ———
  await new Promise(resolve => setTimeout(resolve, Math.max(0, openedAt + 10500 - Date.now())));
  check('The letter stays open past the old 8 s limit', engine.state.current_id === target && (await Promise.all([stage, obs, watch].map(phase))).every(value => value === 'reading'));

  // ——— Close from the stage preview: the letter falls; the next one does not open ———
  const before = engine.state.notes.find(note => note.id === target);
  const stale = { ...engine.overlayState(), serverNow: engine.now() - 1 };
  await stage.locator('#close-note').click();
  check('The console closes the note', await until(() => engine.state.current_id === null) && actions.at(-1).action === 'skip');
  const falls = await Promise.all([stage, obs, watch].map(frame => until(() => frame.evaluate(() => window.__phases.includes('exiting')), 4000)));
  check('Every view drops the letter', falls.every(Boolean));
  const fallFrame = await obs.evaluate(() => { const anim = document.querySelector('.show[data-phase="exiting"]')?.getAnimations().at(-1); return anim ? anim.effect.getKeyframes().at(-1).transform : ''; });
  check('Closing falls off the bottom of the screen', /translateY\(\d+/.test(fallFrame) && !fallFrame.includes('-'));
  check('Fallen letters leave every view', (await Promise.all([stage, obs, watch].map(frame => until(() => frame.evaluate(() => !document.querySelector('.show')), 3000)))).every(Boolean));
  // The OBS page now keeps receiving an older snapshot that still has the letter open.
  staleSnapshot = stale;
  await obs.waitForTimeout(1600);
  check('A stale snapshot never reopens a closed letter', !(await obs.locator('.show').count()) && await obs.evaluate(() => window.__shows) === 1);
  staleSnapshot = null;
  await consolePage.waitForTimeout(1200);
  check('Closing opens nothing else', engine.state.current_id === null && (await Promise.all([stage, obs, watch].map(frame => frame.evaluate(() => window.__shows)))).every(count => count === 1) && before.status === 'revealed');
  check('Two ready envelopes wait for the streamer', (await Promise.all([stage, obs, watch].map(frame => frame.locator('.ready-item').count()))).every(count => count === 2));

  // ——— Bounded ready list uses the full count ———
  override = () => {
    const ready = Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, display_name: null, moment_label: 'Beat Margit', condition_label: 'Beat Margit', category_id: 'advice', payment_mode: 'sim_points' }));
    return { presentation_mode: 'manual', serverNow: Date.now() + 60000, current: null, current_until: null, ready_count: 20, ready_envelopes: ready, sealed_envelopes: [], sealedCount: 21, config: { categories: engine.config.categories }, queue: [] };
  };
  check('More ready envelopes than fit show the full remaining count', await until(() => obs.evaluate(() => document.querySelectorAll('.ready-item').length === 8 && document.querySelector('#ready-more')?.textContent === '+12 more ready')));
  override = null;

  check('The Watch frame made no API requests and needed no token', frameRequests.length === 0);
  check('No external requests', external.length === 0);
  check('No page errors', errors.length === 0);
  console.log(`Presentation browser passed: ${checks.length} checks; screenshots=shots/presentation-{console,obs,panel}-*.png.`);
} catch (error) {
  console.error('FAILED after', checks.length, 'checks:', checks.at(-1) || '(none)');
  console.error('errors:', errors, 'external:', external, 'actions:', actions);
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
