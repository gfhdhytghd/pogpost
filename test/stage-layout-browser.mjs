import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// Stage layout (movable rope ends), end to end on the real local HTTP app and an in-memory engine:
// console Edit layout / Save / Cancel / Reset, the operator preview's handles, OBS and the panel's
// Watch view following the saved rope, and the geometry at several sizes.
// No OBS, Twitch, Decisions, .env or user browser profile.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
for (const [index, moment] of ['margit', 'key', 'margit', 'key', 'margit'].entries())
  await engine.submit({ opaqueId: 'Ulayout', role: 'viewer' }, { body: `Layout note ${index}`, category_id: 'advice', moment_id: moment, payment_mode: 'sim_points' });
const server = await createHTTP({ root, engine, demo: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [], layoutRequests = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });
const DEFAULT = { left: { x: 0, y: 0.025 }, right: { x: 1, y: 0.025 } };
const rope = () => structuredClone(engine.config.reveal.rope);
const near = (a, b, tolerance = 0.006) => Math.abs(a - b) <= tolerance;
const sameLayout = (a, b, tolerance) => ['left', 'right'].every(side => near(a[side].x, b[side].x, tolerance) && near(a[side].y, b[side].y, tolerance));

async function context(viewport) {
  const ctx = await browser.newContext({ viewport });
  ctx.setDefaultTimeout(10000);
  await ctx.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
    if (request.method() === 'POST' && url.pathname === '/api/operator/action') { const body = JSON.parse(request.postData() || '{}'); if (body.action === 'stage_layout_set') layoutRequests.push(body); }
    return route.continue();
  });
  return ctx;
}
const until = async (predicate, timeout = 6000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 80)); } return false; };

// What a stage frame draws: the rope as fractions (from the SVG path itself), pins, tally and handles.
// What a stage frame draws: the rope ends as fractions (from the SVG path itself), and every pin and
// the tally checked against points sampled along that same rendered path.
const geometry = frame => frame.evaluate(() => {
  const W = innerWidth, H = innerHeight, path = document.querySelector('.twine-rope'), d = path.getAttribute('d'), n = d.match(/-?[\d.]+(e-?\d+)?/g).map(Number);
  const [Lx, Ly] = n, [Rx, Ry] = n.slice(-2), ew = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ew'));
  const length = path.getTotalLength(), samples = Array.from({ length: 801 }, (_, i) => path.getPointAtLength(length * i / 800));
  const distance = p => Math.min(...samples.map(q => Math.hypot(q.x - p.x, q.y - p.y)));
  const at = node => { const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform) || []; return { x: Number(m[1]), y: Number(m[2]) }; };
  const pins = [...document.querySelectorAll('.hang:not(.leaving)')].map(node => { const p = at(node); return { x: p.x, y: p.y + ew * 0.02 }; });
  const tallyNode = document.querySelector('#tally'), tallyAt = at(tallyNode), tally = document.querySelector('.tally-card').getBoundingClientRect();
  const tallyLift = Math.min(...samples.map(q => Math.abs(q.x - tallyAt.x) < 2 ? q.y : Infinity)) - tallyAt.y;
  const mid = path.getPointAtLength(length / 2), chordY = Ly + (Ry - Ly) * (mid.x - Lx) / (Rx - Lx);
  const box = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
  const numbers = [...n, ...[...document.querySelectorAll('.hang, .swing, #tally')].flatMap(node => (node.style.transform.match(/-?[\d.]+(e-?\d+)?|NaN|Infinity/g) || []).map(Number))];
  return {
    W, H, ew, finite: numbers.every(Number.isFinite) && !/NaN|Infinity/.test(d),
    sag: mid.y - chordY, mid: { x: mid.x, y: mid.y },
    rope: { left: { x: Lx / W, y: Ly / H }, right: { x: Rx / W, y: Ry / H } },
    pinsOnCurve: pins.every(pin => distance(pin) < 1.5),
    pinsInside: pins.every(pin => pin.x >= Math.min(Lx, Rx) - 0.5 && pin.x <= Math.max(Lx, Rx) + 0.5),
    pins: pins.length, covers: [...document.querySelectorAll('.hang:not(.leaving) .env')].map(box),
    tally: box(document.querySelector('.tally-card')), tallyOnRope: Number.isFinite(tallyAt.x) && tallyAt.x >= Lx - 0.5 && tallyAt.x <= Rx + 0.5 && tallyLift >= 0 && tallyLift < 40,
    tallyInView: tally.left >= -2 && tally.right <= W + 2 && tally.top >= -2,
    count: document.querySelector('#sealed-count').textContent, more: document.querySelector('#more-count').hidden ? '' : document.querySelector('#more-count').textContent,
    handles: [...document.querySelectorAll('.rope-handle')].filter(node => !node.hidden).length,
    knots: [...document.querySelectorAll('.twine-knot')].filter(node => !node.hasAttribute('hidden')).length,
  };
});

try {
  const consoleCtx = await context({ width: 1440, height: 1200 }), page = await consoleCtx.newPage();
  page.on('pageerror', error => errors.push(`console: ${error.message}`));
  await page.goto(`${origin}/console`);
  const stageFrame = async () => { const frame = await (await page.locator('#stage-frame').elementHandle()).contentFrame(); await frame.waitForSelector('.twine-rope[d]'); return frame; };
  let stage = await stageFrame();
  await until(async () => (await geometry(stage)).pins > 0);

  const obsCtx = await context({ width: 1280, height: 720 }), obs = await obsCtx.newPage();
  obs.on('pageerror', error => errors.push(`obs: ${error.message}`));
  await obs.goto(`${origin}/overlay`); await obs.waitForSelector('.hang');
  const viewerCtx = await context({ width: 340, height: 720 }), panel = await viewerCtx.newPage();
  panel.on('pageerror', error => errors.push(`panel: ${error.message}`));
  await panel.goto(`${origin}/panel.html?demo=1&viewer=two`);
  await panel.getByRole('tab', { name: 'Watch' }).click();
  const watch = await (await panel.locator('#watch-stage iframe').elementHandle()).contentFrame();
  await watch.waitForSelector('.twine-rope[d]');

  // ——— Default ———
  for (const [name, frame] of [['stage', stage], ['OBS', obs], ['Watch', watch]]) {
    const g = await geometry(frame);
    check(`${name}: default rope runs edge to edge at 2.5% height and sags`, sameLayout(g.rope, DEFAULT, 0.002) && g.knots === 0 && g.sag > 0 && g.finite);
  }
  check('No handles before editing, and none for viewers', (await geometry(stage)).handles === 0 && await obs.locator('.rope-handle').count() === 0 && await watch.locator('.rope-handle').count() === 0);

  // ——— Edit and drag: local preview only ———
  await page.getByRole('button', { name: 'Edit layout' }).click();
  check('Edit layout shows Save, Reset and Cancel', await page.locator('#layout-save').isVisible() && await page.locator('#layout-reset').isVisible() && await page.locator('#layout-cancel').isVisible() && await page.locator('#layout-edit').isHidden());
  check('The preview shows two handles', await until(async () => (await geometry(stage)).handles === 2));
  const drag = async (side, x, y) => {
    const handle = await stage.locator(`.rope-handle.${side}`).boundingBox(), frame = await page.locator('#stage-frame').boundingBox(), g = await geometry(stage);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    for (const step of [0.33, 0.66, 1]) await page.mouse.move(frame.x + (handle.x - frame.x + handle.width / 2) * (1 - step) + frame.width * x * step, frame.y + (handle.y - frame.y + handle.height / 2) * (1 - step) + frame.height * y * step, { steps: 4 });
    await page.mouse.up(); return g;
  };
  await drag('right', 0.72, 0.30);
  await drag('left', 0.12, 0.10);
  let g = await geometry(stage);
  check('Dragging moves both ends in the preview', near(g.rope.right.x, 0.72, 0.01) && near(g.rope.right.y, 0.30, 0.01) && near(g.rope.left.x, 0.12, 0.01) && near(g.rope.left.y, 0.10, 0.01));
  check('Ends inside the picture get a knot', g.knots === 2);
  check('Pins and tally follow the new rope', await until(async () => { const now = await geometry(stage); return now.pinsOnCurve && now.pinsInside && now.tallyOnRope; }, 3000));
  check('Dragging sends nothing to the server, and OBS keeps the saved rope', layoutRequests.length === 0 && sameLayout((await geometry(obs)).rope, DEFAULT, 0.002) && sameLayout(rope(), DEFAULT, 0));
  await page.screenshot({ path: path.join(shots, 'stage-layout-editing.png') });

  // Keyboard: arrows move 1%, Shift+arrow 5%; the handle names its position.
  await stage.locator('.rope-handle.left').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  g = await geometry(stage);
  check('Arrow keys nudge the focused end', near(g.rope.left.x, 0.17, 0.011) && near(g.rope.left.y, 0.13, 0.011));
  check('The handle label states its position', /^Left end of the rope: 1[67]% across, 1[23]% down\./.test(await stage.locator('.rope-handle.left').getAttribute('aria-label')));
  // The ends keep at least 10% apart.
  await drag('left', 0.95, 0.10);
  g = await geometry(stage);
  check('The left end stops 10% before the right end', g.rope.right.x - g.rope.left.x >= 0.1 - 0.002 && g.rope.right.x - g.rope.left.x < 0.115);

  // ——— Cancel: no request, back to the saved rope ———
  await page.getByRole('button', { name: 'Cancel' }).click();
  check('Cancel sends nothing and restores the saved rope', layoutRequests.length === 0 && await until(async () => { const now = await geometry(stage); return sameLayout(now.rope, DEFAULT, 0.002) && now.handles === 0; }));

  // ——— Save ———
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await until(async () => (await geometry(stage)).handles === 2);
  await drag('right', 0.80, 0.22);
  await drag('left', 0.06, 0.05);
  const preview = (await geometry(stage)).rope;
  // A forged change from the console page itself is ignored.
  await page.evaluate(() => window.postMessage({ type: 'sealed-layout-change', layout: { left: { x: 0.4, y: 0.9 }, right: { x: 0.6, y: 0.9 } } }, location.origin));
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Save layout' }).click();
  check('Save sends the previewed layout once', await until(() => layoutRequests.length === 1) && sameLayout(layoutRequests[0].layout, preview, 0.002) && Object.keys(layoutRequests[0].layout).length === 2);
  // The request is seen before the server applies it; wait for the stored value.
  check('The server stores the saved layout', await until(() => sameLayout(rope(), preview, 0.002)));
  const saved = rope();
  check('Saving leaves edit mode', await until(async () => await page.locator('#layout-edit').isVisible() && (await geometry(stage)).handles === 0));
  for (const [name, frame] of [['OBS', obs], ['Watch', watch], ['stage', stage]])
    check(`${name}: follows the saved rope, pins and tally on it`, await until(async () => { const now = await geometry(frame); return sameLayout(now.rope, saved, 0.002) && now.pinsOnCurve && now.pinsInside && now.tallyOnRope && now.tallyInView; }, 4000));
  await obs.screenshot({ path: path.join(shots, 'stage-layout-obs-saved-1280.png') });
  await panel.screenshot({ path: path.join(shots, 'stage-layout-watch-saved.png') });

  // ——— Reload: the saved rope comes back ———
  await page.reload(); stage = await stageFrame();
  check('After a reload the console preview shows the saved rope', await until(async () => sameLayout((await geometry(stage)).rope, saved, 0.002)));
  await obs.reload(); await obs.waitForSelector('.twine-rope[d]');
  check('After a reload OBS shows the saved rope', await until(async () => sameLayout((await geometry(obs)).rope, saved, 0.002)));

  // ——— Reset ———
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  check('Reset previews the default without a request', layoutRequests.length === 1 && await until(async () => sameLayout((await geometry(stage)).rope, DEFAULT, 0.002)));
  await page.getByRole('button', { name: 'Save layout' }).click();
  check('Saving a reset sends layout: null', await until(() => layoutRequests.length === 2) && layoutRequests[1].layout === null);
  check('The server and OBS return to the default rope', await until(() => sameLayout(rope(), DEFAULT, 0)) && await until(async () => sameLayout((await geometry(obs)).rope, DEFAULT, 0.002), 4000));

  // ——— Geometry at several sizes ———
  const layouts = [
    ['slanted', { left: { x: 0.1, y: 0.05 }, right: { x: 0.85, y: 0.3 } }],
    ['short', { left: { x: 0.45, y: 0.1 }, right: { x: 0.55, y: 0.1 } }],
    ['bottom', { left: { x: 0, y: 0.9 }, right: { x: 1, y: 1 } }],
  ];
  const sizeCtx = await context({ width: 1920, height: 1080 }), sized = await sizeCtx.newPage();
  sized.on('pageerror', error => errors.push(`sized: ${error.message}`));
  await sized.goto(`${origin}/overlay`); await sized.waitForSelector('.twine-rope[d]');
  for (const [name, value] of layouts) {
    await engine.setStageLayout(value);
    for (const [width, height] of [[1920, 1080], [1280, 720], [640, 360]]) {
      await sized.setViewportSize({ width, height });
      const ok = await until(async () => { const now = await geometry(sized); return sameLayout(now.rope, value, 0.002) && now.W === width; }, 4000);
      await sized.waitForTimeout(1000);   // pins glide to their new places
      const now = await geometry(sized);
      const L = value.left.x * width, R = value.right.x * width;
      // Covers may overlap and stack past a short rope's ends, but stay inside the stage and left of the tally.
      const coversInside = now.covers.every(rect => rect.left >= -1 && rect.right <= width + 1 && (name === 'short' || rect.right <= now.tally.left + 2));
      const countKept = now.count === '5 notes sealed' && now.pins + (Number(now.more.match(/\d+/)?.[0]) || 0) === 5;
      check(`${name} ${width}×${height}: rope, pins and tally agree`, ok && now.pinsOnCurve && now.pinsInside && now.tallyOnRope && coversInside && countKept);
      if (name !== 'bottom') check(`${name} ${width}×${height}: tally stays in view`, now.tallyInView);
      if (width === 1280) await sized.screenshot({ path: path.join(shots, `stage-layout-${name}-1280.png`) });
    }
  }
  check('A short rope stacks its covers inside the stage, clear of the tally, and keeps the count', await (async () => { await engine.setStageLayout(layouts[1][1]); await sized.setViewportSize({ width: 640, height: 360 }); await sized.waitForTimeout(1200); const now = await geometry(sized); return now.pins === 5 && now.more === '' && now.pinsOnCurve && now.covers.every(rect => rect.left >= 0 && rect.right <= 640) && now.tally.right - now.tally.left <= 0.1 * 640 * 0.95; })());
  await sized.screenshot({ path: path.join(shots, 'stage-layout-short-stack-640.png') });
  check('The bottom layout is kept as saved, even where the picture crops', sameLayout(rope(), layouts[1][1], 0) && (await (async () => { await engine.setStageLayout(layouts[2][1]); await sized.waitForTimeout(900); return sameLayout(rope(), layouts[2][1], 0); })()));

  check('No layout requests from viewers or OBS', layoutRequests.length === 2);
  check('No external requests', external.length === 0);
  check('No page errors', errors.length === 0);
  console.log(`Stage layout browser passed: ${checks.length} checks; screenshots=shots/stage-layout-*.png.`);
} catch (error) {
  console.error('FAILED after', checks.length, 'checks:', checks.at(-1) || '(none)');
  console.error('errors:', errors, 'external:', external, 'requests:', JSON.stringify(layoutRequests));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
