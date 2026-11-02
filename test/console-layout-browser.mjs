import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';

// Operator desk layout: Stage top left, moments and events in a right column that scrolls on its
// own, controls and queues below; one column on narrow screens. Real local app, in-memory engine.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
await engine.submit({ opaqueId: 'Ulayout', role: 'viewer' }, { body: 'Layout check', category_id: 'advice', moment_id: 'margit', payment_mode: 'sim_points' });
const server = await createHTTP({ root, engine, demo: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [], actions = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

const boxes = page => page.evaluate(() => {
  const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && { x: rect.left, y: rect.top + scrollY, w: rect.width, h: rect.height, bottom: rect.bottom + scrollY, right: rect.right }; };
  const side = document.querySelector('#console-side');
  return {
    W: innerWidth, H: innerHeight, overflowX: document.scrollingElement.scrollWidth - innerWidth,
    stage: box('#stage-section'), frame: box('#stage-frame'), side: box('#console-side'), moments: box('#moment-section'), ai: box('#ai-section'),
    events: box('#events-section'), controls: box('#operator-controls'), queue: box('#sealed-queue'), current: box('#current-note'),
    sideScroll: { style: getComputedStyle(side).overflowY, scroll: side.scrollHeight, client: side.clientHeight, wide: side.scrollWidth - side.clientWidth },
  };
});

try {
  for (const [width, height] of [[1440, 900], [1920, 1080], [768, 1024], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    ctx.setDefaultTimeout(10000);
    await ctx.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (request.method() === 'POST' && url.pathname === '/api/operator/action') actions.push(JSON.parse(request.postData() || '{}').action);
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on('pageerror', error => errors.push(`${width}: ${error.message}`));
    await page.goto(`${origin}/console`);
    await page.locator('#moment-list button').first().waitFor();
    await page.locator('#event-list .event-row').first().waitFor();
    const b = await boxes(page), label = `${width}×${height}`;
    check(`${label}: no horizontal overflow`, b.overflowX <= 0);
    check(`${label}: Stage frame keeps 16:9`, Math.abs(b.frame.w / b.frame.h - 16 / 9) < 0.02);
    if (width >= 1024) {
      check(`${label}: Stage top left, event column on the right at the same height`, b.stage.x < b.side.x && Math.abs(b.stage.y - b.side.y) < 6 && b.side.x >= b.stage.right);
      const share = b.stage.w / (b.side.right - b.stage.x);
      check(`${label}: Stage takes about two thirds`, share > 0.58 && share < 0.72);
      check(`${label}: right column holds suggestions, Declare and events in order`, b.ai.y < b.moments.y && b.moments.y < b.events.y && b.ai.x >= b.side.x - 1);
      check(`${label}: right column ends with the Stage and scrolls on its own`, Math.abs(b.side.bottom - b.stage.bottom) < 10 && b.sideScroll.style === 'auto' && b.sideScroll.scroll > b.sideScroll.client);
      check(`${label}: controls start right below the workspace`, b.controls.y > b.stage.bottom && b.controls.y - b.stage.bottom < 48);
      check(`${label}: Stage is in the first screen`, b.frame.bottom <= height);
      // The full event editor stays inside the column: one column, nothing wider than it.
      await page.locator('#event-add').click();
      await page.locator('#event-editor').waitFor();
      const editor = await page.evaluate(() => ({ columns: getComputedStyle(document.querySelector('#events-section .events-layout')).gridTemplateColumns.split(' ').length, wide: document.querySelector('#console-side').scrollWidth - document.querySelector('#console-side').clientWidth }));
      const after = await boxes(page);
      check(`${label}: open event editor stacks to one column inside the right column`, editor.columns === 1 && editor.wide <= 0);
      check(`${label}: an open event editor does not move the controls`, Math.abs(after.controls.y - b.controls.y) < 2);
      await page.locator('#event-cancel').click();
      // Keyboard: the column takes focus and scrolls; a focused control inside it is scrolled into view.
      await page.locator('#console-side').focus();
      await page.keyboard.press('End');
      check(`${label}: keyboard scrolls the right column`, await page.waitForFunction(() => document.querySelector('#console-side').scrollTop > 0, null, { timeout: 2000 }).then(() => true, () => false));
      await page.locator('#console-side').evaluate(node => { node.scrollTop = 0; });
      await page.locator('#event-add').focus();
      check(`${label}: a focused button deep in the column is fully visible`, await page.evaluate(() => {
        const side = document.querySelector('#console-side').getBoundingClientRect(), button = document.activeElement.getBoundingClientRect();
        return document.activeElement.id === 'event-add' && button.top >= side.top && button.bottom <= side.bottom;
      }));
    } else {
      check(`${label}: one column in order Stage, suggestions, Declare, events, controls, the rest`, b.stage.y < b.ai.y && b.ai.y < b.moments.y && b.moments.y < b.events.y && b.events.bottom <= b.controls.y && b.controls.y < b.queue.y &&
        Math.abs(b.stage.x - b.moments.x) < 30 && b.sideScroll.style === 'visible');
    }
    // Delivery screenshot: page and right column at the top (Declare and suggestions in view).
    await page.evaluate(() => { document.querySelector('#console-side').scrollTop = 0; scrollTo(0, 0); document.activeElement?.blur(); });
    await page.screenshot({ path: path.join(shots, `console-layout-${width}.png`) });
    // The desk still works from its new places.
    const before = actions.length;
    await page.locator('#moment-list button').first().click();
    check(`${label}: Declare moment still sends the action`, await page.waitForFunction(() => true).then(async () => { for (let i = 0; i < 40 && actions.length === before; i++) await page.waitForTimeout(50); return actions.slice(before).includes('moment'); }));
    await page.getByRole('button', { name: 'Edit layout' }).click();
    check(`${label}: Stage Edit layout still works`, await page.locator('#layout-save').isVisible());
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    check(`${label}: Close or Skip, Wrap up and Quick controls are present`, await page.locator('#skip').isVisible() && await page.locator('#wrap').isVisible() && await page.locator('#profile-quick-change').isVisible());
    await ctx.close();
  }
  check('No external requests', external.length === 0);
  check('No page errors', errors.length === 0);
  console.log(`Console layout browser passed: ${checks.length} checks; screenshots=shots/console-layout-{1440,1920,768,390}.png.`);
} catch (error) {
  console.error('FAILED after', checks.length, 'checks:', checks.at(-1) || '(none)');
  console.error('errors:', errors, 'external:', external);
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
