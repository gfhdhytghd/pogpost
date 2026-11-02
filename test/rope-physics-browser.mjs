import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// Rope physics in the renderer: the overlay must draw the simulated cable from public/rope-physics.js,
// not a fixed curve. Real local HTTP app and an in-memory engine. No OBS, Twitch, Decisions or .env.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
for (const [index, moment] of ['margit', 'key', 'margit'].entries())
  await engine.submit({ opaqueId: 'Urope', role: 'viewer' }, { body: `Rope note ${index}`, category_id: 'advice', moment_id: moment, payment_mode: 'sim_points' });
const server = await createHTTP({ root, engine, demo: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [], physicsLoads = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 8000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await wait(60); } return false; };

// Every frame request is counted, and how many are pending at once.
function instrument() {
  const native = window.requestAnimationFrame.bind(window);
  window.__raf = { count: 0, pending: 0, max: 0 };
  window.requestAnimationFrame = callback => { __raf.pending++; __raf.max = Math.max(__raf.max, __raf.pending); return native(time => { __raf.pending--; __raf.count++; callback(time); }); };
  // The rendered rope, read from the SVG path the viewer sees.
  window.__rope = () => {
    const path = document.querySelector('.twine-rope'), d = path?.getAttribute('d') || '';
    if (!d) return null;
    const numbers = d.match(/-?[\d.]+(e-?\d+)?|NaN|Infinity/g).map(Number), length = path.getTotalLength();
    const samples = Array.from({ length: 401 }, (_, i) => path.getPointAtLength(length * i / 400));
    const yAt = x => samples.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best).y;
    const [Lx, Ly] = numbers, [Rx, Ry] = numbers.slice(-2), mid = path.getPointAtLength(length / 2);
    const ew = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ew'));
    const transforms = [...document.querySelectorAll('.hang, .swing, #tally')].map(node => node.style.transform).join(' ');
    const pins = [...document.querySelectorAll('.hang:not(.leaving)')].map(node => { const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform); return { id: node.dataset.id, x: Number(m?.[1]), y: Number(m?.[2]) + ew * 0.02 }; });
    return {
      d, W: innerWidth, H: innerHeight, mid: mid.y, sag: mid.y - (Ly + (Ry - Ly) * (mid.x - Lx) / (Rx - Lx)), yAt: Object.fromEntries(pins.map(pin => [pin.id, yAt(pin.x)])),
      finite: numbers.every(Number.isFinite) && !/NaN|Infinity/.test(transforms),
      inBounds: samples.every(p => p.y > -innerHeight && p.y < innerHeight * 2 && p.x > -innerWidth && p.x < innerWidth * 2),
      pinsOnRope: pins.every(pin => Math.min(...samples.map(p => Math.hypot(p.x - pin.x, p.y - pin.y))) < 1.5),
      pins,
    };
  };
}
async function open(viewport, { reduce = false, url = '/overlay' } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion: reduce ? 'reduce' : 'no-preference' });
  ctx.setDefaultTimeout(10000);
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
    if (url.pathname === '/rope-physics.js') physicsLoads.push(url.pathname);
    return route.continue();
  });
  await ctx.addInitScript(instrument);
  const page = await ctx.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${url}`);
  return { ctx, page };
}
const rope = frame => frame.evaluate(() => window.__rope());
// At rest: no frame pending and the path unchanged for 600 ms.
const resting = async frame => {
  const before = await frame.evaluate(() => ({ d: window.__rope()?.d, count: __raf.count, pending: __raf.pending }));
  await wait(600);
  const after = await frame.evaluate(() => ({ d: window.__rope()?.d, count: __raf.count, pending: __raf.pending }));
  return before.d && before.d === after.d && after.pending === 0 && after.count === before.count;
};
// Record the rope for a while, one sample every animation frame of the test clock.
const record = async (frame, ms, pick) => { const values = [], end = Date.now() + ms; while (Date.now() < end) { values.push(pick(await rope(frame))); await wait(40); } return values; };

try {
  const { page } = await open({ width: 1280, height: 720 });
  await page.waitForSelector('.hang');
  check('The overlay loads the rope physics module', physicsLoads.length > 0);
  const g = await rope(page);
  check('Gravity: the rope sags below its chord', g.sag > 0.02 * g.W);
  check('Pins hang on the simulated rope', g.pinsOnRope && g.pins.length === 3 && g.finite);
  check('No infinite CSS animation and no transition on the rope', await page.evaluate(() =>
    document.getAnimations().every(animation => animation.effect.getComputedTiming().iterations !== Infinity) &&
    [...document.querySelectorAll('.swing')].every(node => getComputedStyle(node).animationName === 'none') &&
    [...document.querySelectorAll('.hang, #tally')].every(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) === 0))));
  check('At rest the frame loop sleeps', await until(() => resting(page), 15000));

  // ——— Move only the right end down after rest: the rope keeps moving for many frames, then rests ———
  const restMid = (await rope(page)).mid, rafBefore = await page.evaluate(() => __raf.count);
  await engine.setStageLayout({ left: { x: 0, y: 0.025 }, right: { x: 1, y: 0.35 } });
  check('A moved end wakes the sleeping rope', await until(async () => (await rope(page)).mid !== restMid, 3000));
  const mids = await record(page, 1200, value => value.mid);
  const distinct = new Set(mids.map(value => value.toFixed(1))).size;
  check('The rope keeps moving over many frames after the end moves', distinct >= 8 && await page.evaluate(count => __raf.count > count + 20, rafBefore));
  check('The rope comes to rest again and the loop sleeps', await until(() => resting(page), 15000));
  const settledMid = (await rope(page)).mid;
  check('It does not jump straight to its rest shape', mids.some(value => Math.abs(value - settledMid) > 2));
  check('Pins stay on the rope after it settles', (await rope(page)).pinsOnRope);

  // ——— Take one envelope off: the rope springs up there, overshoots and settles ———
  const before = await rope(page), keyId = engine.state.notes.find(note => note.moment_id === 'key').id;
  const restY = before.yAt[keyId], pinX = before.pins.find(pin => pin.id === keyId).x;
  await engine.occur('key', 'Streamer declared this moment.', 'streamer');   // auto mode: it opens and leaves the rope
  const ys = await record(page, 2500, () => null);
  const trace = [];
  for (const _ of ys) { trace.push(await page.evaluate(x => { const r = window.__rope(); const path = document.querySelector('.twine-rope'), length = path.getTotalLength(); let best = null; for (let i = 0; i <= 400; i++) { const p = path.getPointAtLength(length * i / 400); if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; } return r.finite ? best.y : NaN; }, pinX)); await wait(30); if (trace.length > 50) break; }
  check('After the load leaves, the rope there springs up', Math.min(...trace) < restY - 1);
  await until(() => resting(page), 15000);
  const after = await page.evaluate(x => { const path = document.querySelector('.twine-rope'), length = path.getTotalLength(); let best = null; for (let i = 0; i <= 400; i++) { const p = path.getPointAtLength(length * i / 400); if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; } return best.y; }, pinX);
  check('It rebounds past its new rest and settles', Math.min(...trace) < after - 0.5 && trace.some(value => value > Math.min(...trace) + 0.5) && Number.isFinite(after));
  check('Two envelopes remain on the rope', (await rope(page)).pins.length === 2 && (await rope(page)).pinsOnRope);
  check('Never more than one frame pending', await page.evaluate(() => __raf.max <= 1));

  // ——— Frozen (hidden) and back: no NaN, no blow-up ———
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await engine.setStageLayout({ left: { x: 0.05, y: 0.4 }, right: { x: 0.95, y: 0.05 } });
  await wait(2500);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  const resumed = await record(page, 1500, value => value);
  check('Hidden then visible: finite and inside bounds every frame', resumed.every(value => value.finite && value.inBounds));
  check('Hidden then visible: it settles again', await until(() => resting(page), 15000) && (await rope(page)).pinsOnRope);

  // ——— Sizes ———
  for (const [width, height] of [[1920, 1080], [640, 360], [340, 600]]) {
    await page.setViewportSize({ width, height });
    await wait(300);
    const sized = await record(page, 600, value => value);
    check(`${width}×${height}: finite, in bounds, pins on the rope`, sized.every(value => value.finite && value.inBounds && value.W === width) && await until(async () => (await rope(page)).pinsOnRope, 6000));
  }
  await page.screenshot({ path: path.join(shots, 'rope-physics-340.png'), omitBackground: true });

  // ——— Reduced motion: static balance, no loop ———
  const calm = await open({ width: 1280, height: 720 }, { reduce: true });
  await calm.page.waitForSelector('.hang');
  await wait(400);
  const calmRope = await rope(calm.page);
  check('Reduced motion: the rope still hangs under gravity, pins on it', calmRope.sag > 0 && calmRope.pinsOnRope && calmRope.finite);
  check('Reduced motion: no frame loop', await calm.page.evaluate(() => __raf.count === 0 && __raf.pending === 0) && await resting(calm.page));
  await engine.setStageLayout(null);
  check('Reduced motion: a new layout appears at rest at once', await until(async () => Math.abs((await rope(calm.page)).d.match(/-?[\d.]+/g).map(Number).slice(-1)[0] - 0.025 * 720) < 0.2, 3000) && await calm.page.evaluate(() => __raf.count === 0));

  // ——— The panel's Watch view: hidden at zero size, then shown again ———
  const viewer = await open({ width: 340, height: 720 }, { url: '/panel.html?demo=1&viewer=two' });
  await viewer.page.getByRole('tab', { name: 'Watch' }).click();
  const watch = await (await viewer.page.locator('#watch-stage iframe').elementHandle()).contentFrame();
  await watch.waitForSelector('.hang');
  await viewer.page.getByRole('tab', { name: 'Write a note' }).click();
  await engine.setStageLayout({ left: { x: 0.1, y: 0.2 }, right: { x: 0.9, y: 0.1 } });
  await wait(2200);
  check('Hidden Watch frame has no size and stops its loop', await watch.evaluate(() => innerWidth === 0 && __raf.pending === 0));
  await viewer.page.getByRole('tab', { name: 'Watch' }).click();
  check('Shown again: the Watch rope is finite and follows the saved layout', await until(async () => { const value = await rope(watch); return value?.finite && value.inBounds && value.pinsOnRope && Math.abs(value.d.match(/-?[\d.]+/g).map(Number)[1] - 0.2 * value.H) < 0.5; }, 6000));

  check('No external requests', external.length === 0);
  check('No page errors', errors.length === 0);
  console.log(`Rope physics browser passed: ${checks.length} checks; screenshot=shots/rope-physics-340.png.`);
} catch (error) {
  console.error('FAILED after', checks.length, 'checks:', checks.at(-1) || '(none)');
  console.error('errors:', errors, 'external:', external);
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
