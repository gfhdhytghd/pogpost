import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// OBS overlay acceptance. Static files come from the real local HTTP app; /api/overlay is a
// test-controlled mock of the server contract. No OBS, Twitch, Decisions or .env.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
const server = await createHTTP({ root, engine, demo: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

const SEALED_CANARY = 'OVERLAY_SEALED_BODY_CANARY';
const config = { categories: engine.config.categories };
const envelope = (id, extra = {}) => ({ id, display_name: null, moment_label: 'Beat Margit', condition_label: 'Beat Margit', category_id: 'prediction', payment_mode: 'sim_points', ...extra });
let overlay = { current: null, current_until: 0, queue: [], sealedCount: 0, sealed_envelopes: [], config };
const respond = () => ({ ...structuredClone(overlay), serverNow: Date.now() });

async function open({ width = 1920, height = 1080, reduce = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduce ? 'reduce' : 'no-preference' });
  context.setDefaultTimeout(10000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/overlay') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(respond()) });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  // Count every reveal the page starts, so a replay of the same note is visible.
  await page.addInitScript(() => {
    window.__shows = 0;
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains('show')) window.__shows++; })
      .observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${origin}/overlay`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
const until = async (page, predicate, timeout = 8000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await page.evaluate(predicate)) return true; await page.waitForTimeout(80); } return false; };
const alphaCorners = async page => {
  const png = await page.screenshot({ omitBackground: true });
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    return [[0, bitmap.height - 1], [bitmap.width - 1, bitmap.height - 1], [Math.floor(bitmap.width / 2), bitmap.height - 2]].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
  }, [...png]);
};
const note = (id, body, extra = {}) => ({ id, body, display_name: null, moment_label: 'Beat Margit', category_id: 'prediction', category: engine.config.categories.find(item => item.id === 'prediction'), payment: { mode: 'sim_points' }, status: 'revealed', ...extra });

try {
  // ——— Empty line ———
  const { context, page } = await open();
  check('Empty overlay shows the twine and a zero count', await page.locator('#sealed-count').textContent() === '0 notes sealed' && await page.locator('.hang').count() === 0 &&
    await page.locator('.twine-rope').getAttribute('d') !== null);
  check('Empty overlay is transparent', (await alphaCorners(page)).every(alpha => alpha === 0));

  // ——— Envelopes arrive ———
  overlay = { ...overlay, sealedCount: 3, sealed_envelopes: [
    envelope('a1', { display_name: 'margitfan', condition_label: 'Beat Margit · occurrence 3', body: SEALED_CANARY }),
    envelope('a2', { moment_label: 'Find the key', condition_label: 'Find the key', category_id: 'advice' }),
    envelope('a3', { moment_label: 'End of stream', condition_label: 'after Find the key', category_id: 'joke', payment_mode: 'sim_bits' }),
  ] };
  check('Three envelopes hang on the line', await until(page, () => document.querySelectorAll('.hang').length === 3));
  const covers = await page.locator('.hang').allInnerTexts();
  check('Covers show sender, opening moment and condition', covers[0].includes('From @margitfan') && covers[0].includes('Opens when Beat Margit') && covers[0].includes('occurrence 3') &&
    covers[1].includes('From A viewer') && covers[2].includes('after Find the key'));
  check('A condition equal to the moment is not repeated', !covers[1].includes('Find the key\nFind the key'));
  check('Test Bits envelopes get the gold edge', await page.locator('.hang[data-id="a3"] .env').evaluate(node => node.classList.contains('gold')));
  check('Sealed body text never reaches the DOM', !(await page.content()).includes(SEALED_CANARY));
  // The rope simulation swings each envelope from its pin; no CSS animation runs on top of it.
  const swingNow = () => page.locator('.hang .swing').first().evaluate(node => ({ css: getComputedStyle(node).animationName, transform: node.style.transform }));
  const swingA = await swingNow(); await page.waitForTimeout(120); const swingB = await swingNow();
  check('Envelopes swing from their pins by the rope simulation', swingA.css === 'none' && /^rotate\(-?[\d.]+rad\)$/.test(swingA.transform) && swingA.transform !== swingB.transform);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, 'overlay-line-1920.png'), omitBackground: true });

  // ——— Injection ———
  overlay = { ...overlay, sealedCount: 4, sealed_envelopes: [...overlay.sealed_envelopes, envelope('a4', { display_name: '<img src=x onerror="window.__pwned=1">', moment_label: '<script>window.__pwned=2</script>Boss' })] };
  check('Injected markup renders as text only', await until(page, () => document.querySelectorAll('.hang').length === 4) &&
    await page.evaluate(() => !document.querySelector('#envelopes img, #envelopes script') && window.__pwned === undefined) &&
    (await page.locator('.hang[data-id="a4"]').innerText()).includes('<img src=x'));

  // A changed cover replaces its node once; no orphan duplicate stays.
  overlay = { ...overlay, sealed_envelopes: overlay.sealed_envelopes.map(item => item.id === 'a2' ? { ...item, display_name: 'renamed_viewer' } : item) };
  check('A changed cover is replaced by exactly one node', await until(page, () => document.querySelector('.hang[data-id="a2"]')?.innerText.includes('@renamed_viewer')) &&
    await page.locator('.hang[data-id="a2"]').count() === 1 && await page.locator('.hang').count() === 4);

  // ——— Many envelopes: a capped line plus the total ———
  overlay = { ...overlay, sealedCount: 15, sealed_envelopes: Array.from({ length: 12 }, (_, index) => envelope(`m${index}`)) };
  await until(page, () => document.querySelectorAll('.hang[data-id^="m"]').length === 12);
  await page.waitForTimeout(600);
  const shown = await page.locator('.hang').count();
  check('All twelve envelopes the server sends hang, overlapping, with the rest counted', shown === 12 && await page.locator('#more-count').textContent() === '+3 more on the line' &&
    await page.locator('#sealed-count').textContent() === '15 notes sealed');
  await page.waitForTimeout(1000);
  check('The tally tag never overlaps an envelope', await page.evaluate(() => { const tag = document.querySelector('.tally-card').getBoundingClientRect();
    return [...document.querySelectorAll('.hang .env')].every(node => node.getBoundingClientRect().right <= tag.left); }));
  check('Overlapping envelopes stack in a stable order inside the stage', await page.evaluate(() => {
    const hangs = [...document.querySelectorAll('.hang')], rects = hangs.map(node => node.querySelector('.env').getBoundingClientRect());
    return hangs.every((node, index) => Number(node.style.zIndex) === index + 1) && rects.every(rect => rect.left >= 0 && rect.right <= innerWidth) &&
      rects.slice(1).some((rect, index) => rect.left < rects[index].right); }));
  await page.screenshot({ path: path.join(shots, 'overlay-many-1920.png'), omitBackground: true });

  // ——— First reveal ———
  overlay = { ...overlay, sealedCount: 3, sealed_envelopes: [envelope('r1', { display_name: 'margitfan' }), envelope('r2'), envelope('r3')] };
  await until(page, () => document.querySelectorAll('.hang').length === 3);
  await page.waitForTimeout(900);
  const BODY = 'I predict a clean victory. Chat believes in this run.';
  const openedAt = Date.now();
  overlay = { ...overlay, current: note('r1', BODY, { display_name: 'margitfan' }), current_until: openedAt + 8000, sealedCount: 2, sealed_envelopes: [envelope('r2'), envelope('r3')] };
  check('The revealed envelope leaves the line and flies to the stage', await until(page, () => !!document.querySelector('.env3d') && !document.querySelector('.hang[data-id="r1"]'), 3000));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, 'overlay-opening-1920.png'), omitBackground: true });
  // Readable means the opening sequence finished: phase=reading, letter at full size, untransformed.
  check('The letter is open and readable within 2.8 s', await until(page, () => document.querySelector('.show')?.dataset.phase === 'reading', 2800));
  const readingAt = Date.now();
  check('The reading letter is full size with no leftover transform', await page.evaluate(() => { const card = document.querySelector('.reveal-card.letter');
    const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lw')), box = card.getBoundingClientRect();
    return ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(card).transform) && Math.abs(box.width - width) < 2 && !document.querySelector('.show .env3d, .show .ob-pocket, .show .seal-box'); }));
  check('Letter shows the body, sender and moment', await page.locator('.reveal-body').textContent() === BODY && (await page.locator('.reveal-card').innerText()).includes('margitfan') &&
    (await page.locator('.reveal-card').innerText()).includes('Opened for Beat Margit'));
  await page.screenshot({ path: path.join(shots, 'overlay-letter-1920.png'), omitBackground: true });
  // Same current across many polls: never replayed. A verdict arriving later is stamped in place.
  await page.waitForTimeout(1200);
  overlay = { ...overlay, current: { ...overlay.current, prediction_verdict: 'came_true' } };
  check('A later verdict is stamped without replaying the reveal', await until(page, () => document.querySelector('.verdict')?.textContent === 'CALLED IT') && await page.evaluate(() => window.__shows) === 1);
  overlay = { ...overlay, current: { ...overlay.current, prediction_verdict: 'missed' } };
  check('A streamer override re-inks the stamp without a replay', await until(page, () => document.querySelector('.verdict')?.textContent === 'MISSED' && document.querySelector('.verdict').classList.contains('missed')) &&
    await page.locator('.verdict').count() === 1 && await page.evaluate(() => window.__shows) === 1);
  await page.waitForTimeout(Math.max(0, openedAt + 7200 - Date.now()));
  check('Still reading 7.2 s into the 8 s window', await page.evaluate(() => document.querySelector('.show')?.dataset.phase === 'reading'));
  await until(page, () => document.querySelector('.show')?.dataset.phase !== 'reading', 1500);
  const readMs = Date.now() - readingAt;
  check(`The body stayed readable about 5 s (${readMs} ms)`, readMs >= 4800);
  check('The letter leaves by the server deadline even if the poll still shows it', await until(page, () => !document.querySelector('.show'), Math.max(0, openedAt + 8400 - Date.now())) &&
    await page.evaluate(() => window.__shows) === 1);

  // ——— An expired deadline is never resurrected ———
  overlay = { ...overlay, current: note('stale', 'Stale words.'), current_until: Date.now() - 2000 };
  await page.waitForTimeout(1200);
  check('An explicitly expired current is not shown', await page.evaluate(() => !document.querySelector('.show') && !document.body.innerText.includes('Stale words.') && window.__shows === 1));

  // ——— Second reveal replaces the first ———
  overlay = { ...overlay, current: note('r2', 'Second envelope words.'), current_until: Date.now() + 8000, sealedCount: 1, sealed_envelopes: [envelope('r3')] };
  check('A new current starts one new reveal and retires the old one', await until(page, () => window.__shows === 2 && document.querySelectorAll('.show').length === 1, 3000));
  check('The second letter opens to reading', await until(page, () => document.querySelector('.show')?.dataset.phase === 'reading' && document.querySelector('.reveal-body')?.textContent === 'Second envelope words.', 3200));

  // ——— Skip / reset: current disappears ———
  overlay = { ...overlay, current: null, current_until: 0 };
  check('Skip or reset removes the reveal quickly', await until(page, () => !document.querySelector('.show'), 1500));
  check('Skip does not replay anything', await page.evaluate(() => window.__shows) === 2);
  // Cancel in the middle of an opening.
  overlay = { ...overlay, current: note('r3', 'Third words.'), current_until: Date.now() + 8000, sealedCount: 0, sealed_envelopes: [] };
  await until(page, () => !!document.querySelector('.env3d'), 2000);
  overlay = { ...overlay, current: null };
  check('A cancelled opening leaves nothing behind', await until(page, () => !document.querySelector('.show') && !document.querySelector('.reveal-card'), 1500));
  await page.waitForTimeout(800);
  check('Nothing reappears after the cancel', await page.evaluate(() => !document.querySelector('.show')));

  // ——— Late join: little time left still gives a readable letter, no flight ———
  overlay = { ...overlay, current: note('late', 'Joined late.'), current_until: Date.now() + 5600 };
  check('Late join shows the letter directly', await until(page, () => document.querySelector('.show')?.dataset.phase === 'reading' && document.querySelector('.reveal-body')?.textContent === 'Joined late.', 1200) && await page.evaluate(() => !document.querySelector('.env3d')));
  overlay = { ...overlay, current: null };
  await until(page, () => !document.querySelector('.show'), 1500);

  // ——— Wrap-up reel ———
  overlay = { ...overlay, reel: { count: 2, created_at: 1 } };
  check('The wrap-up reel shows its count', await until(page, () => document.querySelector('.reel-count')?.textContent === '2') && (await page.locator('.reel-card').innerText()).includes('This never happened.'));
  overlay = { ...overlay, reel: null };
  await context.close();

  // ——— Sizes, transparency and reduced motion ———
  overlay = { ...overlay, current: null, sealedCount: 9, sealed_envelopes: Array.from({ length: 9 }, (_, index) => envelope(`s${index}`, { display_name: index % 2 ? 'longer_display_name_here' : null })) };
  for (const [width, height] of [[1920, 1080], [1280, 720], [640, 360]]) {
    const view = await open({ width, height });
    await until(view.page, () => document.querySelectorAll('.hang').length > 0);
    await view.page.waitForTimeout(1000);
    const fit = await view.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.hang .env, .tally-card')]
      .every(node => { const box = node.getBoundingClientRect(); return box.left >= -2 && box.right <= innerWidth + 2 && box.bottom <= innerHeight * 0.5; }));
    check(`${width}×${height}: envelopes and tally fit in the top half`, fit);
    check(`${width}×${height}: lower canvas stays transparent`, (await alphaCorners(view.page)).every(alpha => alpha === 0));
    overlay = { ...overlay, current: note('size', 'A note sized for this canvas, still readable when it opens.'), current_until: Date.now() + 8000 };
    check(`${width}×${height}: the letter opens to reading`, await until(view.page, () => document.querySelector('.show')?.dataset.phase === 'reading', 4000));
    check(`${width}×${height}: the letter fits the canvas`, await view.page.locator('.reveal-card.letter').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }));
    await view.page.screenshot({ path: path.join(shots, `overlay-letter-${width}x${height}.png`), omitBackground: true });
    overlay = { ...overlay, current: null };
    await view.context.close();
  }
  const calm = await open({ width: 1280, height: 720, reduce: true });
  overlay = { ...overlay, current: note('calm', 'Reduced motion words.'), current_until: Date.now() + 8000 };
  check('Reduced motion: the letter appears without the flight or sway', await until(calm.page, () => document.querySelector('.show')?.dataset.phase === 'reading' && document.querySelector('.reveal-body')?.textContent === 'Reduced motion words.', 1200) &&
    await calm.page.evaluate(() => !document.querySelector('.env3d') && getComputedStyle(document.querySelector('.swing')).animationName === 'none'));
  await calm.context.close();

  check('No external requests and no page errors', external.length === 0 && errors.length === 0);
  console.log(`Overlay browser passed: ${checks.length} checks; screenshots=shots/overlay-{line,many,opening,letter}-1920.png, overlay-letter-{1920x1080,1280x720,640x360}.png.`);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
