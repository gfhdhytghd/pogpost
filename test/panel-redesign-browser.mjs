import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../server/index.js';

// Viewer panel acceptance on the local offline demo: real HTTP and EBS routes,
// the local Twitch mock harness, simulated currency only. No .env, Twitch, Bits or provider.
const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });
const app = await createApplication({ demo: true, env: {} });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'en_US.UTF-8' } });
const checks = [], external = [], errors = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const SECRET = 'Panel canary: the third boss falls first try';

async function open(theme, width) {
  const context = await browser.newContext({ colorScheme: theme, reducedMotion: 'reduce', viewport: { width, height: 900 } });
  context.setDefaultTimeout(10000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.origin); return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/panel.html?demo=1`);
  await page.getByRole('button', { name: /Prediction/ }).waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  return { context, page };
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
  [...document.querySelectorAll('main *')].every(node => { const box = node.getBoundingClientRect(); return !box.width || (box.left >= -0.5 && box.right <= innerWidth + 0.5); }));
// Every category name renders on one line: no word is split.
const namesWhole = page => page.evaluate(() => [...document.querySelectorAll('.category-button span:not(.category-icon)')].every(label => {
  const range = document.createRange(); range.selectNodeContents(label.firstChild); return range.getClientRects().length === 1;
}));
async function seal(page, body, moment = 'margit') {
  await page.getByRole('tab', { name: /Write a note/ }).click();
  await page.getByLabel('What would you like to say?').fill(body);
  await page.getByRole('button', { name: /Prediction/ }).click();
  await page.getByLabel(/^Open when/).selectOption(moment);
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/ebs/notes' && item.request().method() === 'POST');
  await page.getByRole('button', { name: /Seal this note/ }).click();
  return (await response).status();
}

try {
  // ——— 320 px Twitch panel, light ———
  const { context, page } = await open('light', 320);
  check('320: first screen shows the letter field without a hero', await page.getByLabel('What would you like to say?').evaluate(node => node.getBoundingClientRect().top < 260));
  check('320: no horizontal overflow before sealing', await noOverflow(page));
  check('320: category names are never split mid-word', await namesWhole(page));
  check('Every payment option discloses test mode', await page.getByLabel('Seal with').locator('option').evaluateAll(options => options.length > 0 && options.every(option => option.textContent.includes('TEST MODE — no real charge'))));
  check('Identity choices stay available', await page.getByLabel('Show my Twitch name').isVisible() && await page.getByRole('button', { name: 'Share identity' }).isVisible());
  let identityRequests = 0;
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/demo/auth' && url.searchParams.get('shared') === '1') identityRequests++; });
  await page.getByLabel('Show my Twitch name').check();
  await page.waitForFunction(() => window.Twitch.ext.viewer.isLinked);
  check('First name display requests identity when it is not linked', identityRequests === 1);
  await page.getByLabel('Show my Twitch name').uncheck();
  await page.getByLabel('Show my Twitch name').check();
  await page.getByRole('button', { name: 'Share identity', exact: true }).click();
  check('Already-linked name toggles do not reopen Twitch permissions', identityRequests === 1);
  await page.getByLabel('Show my Twitch name').uncheck();
  await page.getByLabel('What would you like to say?').fill('x'.repeat(125));
  check('Counter shows length and warns near the 140 limit', await page.locator('#char-counter').textContent() === '125 / 140' && await page.locator('#char-counter').evaluate(node => node.classList.contains('near')) &&
    await page.getByLabel('What would you like to say?').getAttribute('maxlength') === '140');
  await page.getByLabel('What would you like to say?').fill('');
  await page.screenshot({ path: path.join(shots, 'panel-redesign-320-light.png'), fullPage: true });

  // Keyboard: arrow keys move between tabs, Enter picks an envelope.
  await page.locator('#compose-tab').focus(); await page.keyboard.press('ArrowRight');
  check('Arrow keys move to Your notes and focus it', await page.locator('#notes-view').isVisible() && await page.evaluate(() => document.activeElement?.id === 'notes-tab'));
  await page.keyboard.press('ArrowLeft');
  check('Arrow keys return to Write a note', await page.locator('#compose-view').isVisible() && await page.locator('#compose-tab').getAttribute('aria-selected') === 'true');
  await page.getByRole('button', { name: /Joke/ }).focus(); await page.keyboard.press('Enter');
  check('Enter selects an envelope and keeps focus on it', await page.getByRole('button', { name: /Joke/ }).getAttribute('aria-pressed') === 'true' &&
    await page.evaluate(() => document.activeElement?.dataset.category === 'joke'));

  // Seal: receipt shows, words disappear everywhere.
  check('Sealing goes through the local EBS route', await seal(page, SECRET) === 200);
  await page.getByText('Sealed. See you at the moment.', { exact: true }).waitFor();
  check('Receipt is a sealed postmark naming the moment', await page.locator('#receipt').getAttribute('data-state') === 'sealed' && (await page.locator('#receipt').innerText()).includes('For: Beat Margit'));
  check('After sealing the words are gone from the page and fields', await page.evaluate(secret => !document.body.innerText.includes(secret) &&
    [...document.querySelectorAll('input,textarea')].every(node => !node.value.includes(secret)), SECRET));
  await page.locator('#receipt').screenshot({ path: path.join(shots, 'panel-redesign-receipt.png') });
  await page.getByRole('tab', { name: /Your notes/ }).click();
  const sealedRow = page.locator('.note-item').filter({ hasText: 'Beat Margit' }).first();
  check('Your notes shows a Sealed stamp and hides the words', await sealedRow.locator('.stamp').textContent() === 'Sealed' && !(await page.locator('#notes-view').innerText()).includes(SECRET));

  // Open it on stream; the author sees it opened, with the now-public words.
  const note = app.engine.state.notes.find(item => item.body === SECRET);
  await app.engine.reveal(note.id);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sealed-refresh')));
  const opened = page.locator('.note-item').filter({ has: page.locator('.stamp[data-status="revealed"]') }).first();
  await opened.waitFor();
  check('After the streamer opens it, Your notes shows Opened and the words', await opened.locator('.stamp').textContent() === 'Opened' && await opened.locator('.note-opened').textContent() === SECRET);
  await page.getByText('Your note was opened', { exact: true }).waitFor({ timeout: 6000 });
  check('An opened-note notice appears', await page.locator('.toast').isVisible());
  await page.screenshot({ path: path.join(shots, 'panel-redesign-notes-320.png'), fullPage: true });

  // Held for review.
  await seal(page, '[demo:hold] A note a moderator should look at.');
  await page.getByText('Held for human review', { exact: true }).waitFor();
  check('Held note gets an amber review receipt', await page.locator('#receipt').getAttribute('data-state') === 'held');
  await page.getByRole('tab', { name: /Your notes/ }).click();
  check('Held note shows an In review stamp', await page.locator('.stamp[data-status="held"], .stamp[data-status="pending_review"]').first().textContent() === 'In review');

  // Rejected by moderation: no charge.
  await seal(page, 'Visit http://example.invalid for a prize');
  await page.getByText('Rejected — no charge', { exact: true }).waitFor();
  check('Rejected note gets a red receipt and an error status', await page.locator('#receipt').getAttribute('data-state') === 'rejected' &&
    await page.locator('#status').evaluate(node => node.classList.contains('error')) && await page.locator('#status').textContent() === 'No simulated currency was charged.');

  // Service error: words are kept, nothing claims success.
  await page.route('**/ebs/quote', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) }));
  await page.getByRole('tab', { name: /Write a note/ }).click();
  await page.getByLabel('What would you like to say?').fill('This one should stay in the box.');
  await page.getByRole('button', { name: /Seal this note/ }).click();
  await page.locator('#status.error').filter({ hasText: 'service unavailable' }).waitFor();
  check('Service error shows clearly, keeps the words and re-enables sealing', await page.getByLabel('What would you like to say?').inputValue() === 'This one should stay in the box.' &&
    await page.getByRole('button', { name: /Seal this note/ }).isEnabled());
  await page.unroute('**/ebs/quote');
  await page.getByLabel('What would you like to say?').fill('   ');
  await page.getByRole('button', { name: /Seal this note/ }).click();
  check('Blank notes are stopped locally', await page.locator('#status').textContent() === 'Write a few words before sealing.' && await page.evaluate(() => document.activeElement?.id === 'note-body'));
  check('320: no horizontal overflow after every state', await noOverflow(page));
  check('Simulated payments only: live Bits never invoked', await page.evaluate(() => (window.__twitchMock?.state?.bitsCalls ?? 0) === 0));
  await context.close();

  // ——— Other themes and widths ———
  for (const [theme, width] of [['dark', 320], ['light', 1280], ['dark', 1280]]) {
    const view = await open(theme, width);
    check(`${theme}/${width}: no horizontal overflow`, await noOverflow(view.page));
    check(`${theme}/${width}: category names are whole`, await namesWhole(view.page));
    if (width > 700) check(`${theme}/${width}: letter and routing sit side by side`, await view.page.evaluate(() =>
      document.querySelector('.letter').getBoundingClientRect().right <= document.querySelector('.routing').getBoundingClientRect().left));
    await view.page.screenshot({ path: path.join(shots, `panel-redesign-${width}-${theme}.png`), fullPage: true });
    await view.context.close();
  }

  check('No external requests and no page errors', external.length === 0 && errors.length === 0);
  console.log(`Panel redesign browser passed: ${checks.length} checks; screenshots=shots/panel-redesign-{320-light,320-dark,1280-light,1280-dark,receipt,notes-320}.png.`);
} finally {
  await browser.close();
  await app.close();
}
