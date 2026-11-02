import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { KSP_EVENTS, KSP_MOMENTS } from '../server/ksp-perception.js';

// UI acceptance only: synthetic observations, in-memory notes, no application
// bootstrap, provider client, OBS capture, .env loading, or user browser profile.
const root = path.resolve(import.meta.dirname, '..');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
await engine.updateConfig({ moments: [...engine.config.moments, ...KSP_MOMENTS] });
const note = await engine.submit({ opaqueId: 'Ukspbrowser', role: 'viewer' }, {
  body: 'A little encouragement for the first confirmed launch.', category_id: 'encouragement', moment_id: 'ksp-launch', payment_mode: 'free', request_id: 'ksp-browser-note', show_name: false,
});
const observedAt = Date.now() - 1500;
let pending = Object.entries(KSP_EVENTS).map(([kind, spec], index) => ({
  id: `offline-ksp-${kind}`, kind, moment_id: spec.id, label: spec.label,
  evidence: spec.evidence, observed_at: observedAt + index, created_at: observedAt + 1000,
  needs_confirmation: true, source: 'ai',
}));
let resets = 0;
const occurrenceCalls = [], consumeCalls = [];
const originalOccur = engine.occur.bind(engine);
engine.occur = async (...args) => { occurrenceCalls.push(args); return originalOccur(...args); };
const watcher = {
  prompts: () => structuredClone(pending),
  confirm(id) {
    consumeCalls.push(id);
    const index = pending.findIndex(prompt => prompt.id === id);
    return index < 0 ? null : pending.splice(index, 1)[0];
  },
  reset() { resets++; pending = []; },
};
const server = await createHTTP({ root, engine, demo: true, watcher,
  integrations: () => ({ perception: { profile: 'ksp', enabled: true, status: 'watching', message: 'Offline observation fixtures. Human confirmation is required.' } }),
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'America/New_York', reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], actions = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push('blocked external request'); return route.abort('blockedbyclient');
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  // The read-only preset catalog request is not an operator decision.
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/operator/action' && JSON.parse(request.postData()).action !== 'events_presets') actions.push(JSON.parse(request.postData()));
});
async function clickAction(button) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/operator/action' && response.request().method() === 'POST');
  await button.click();
  assert.equal((await response).status(), 200, 'Console action reaches the real HTTP route');
}

try {
  await page.goto(`${origin}/console`);
  await page.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();
  check('Picture integration uses the generic heading; the preset selector names the game', await page.getByText('Picture & sound', { exact: true }).isVisible() && await page.getByText('Picture & sound · KSP', { exact: true }).count() === 0);
  check('All six KSP proposals render without declaring a moment', await page.locator('#ai-prompts article').count() === 6 && occurrenceCalls.length === 0 && engine.state.occurrences.length === 0);
  check('The launch note remains sealed before human confirmation', engine.state.notes.find(item => item.id === note.id)?.status === 'sealed');
  for (const [index, spec] of Object.values(KSP_EVENTS).entries()) {
    const card = page.locator('#ai-prompts article').filter({ has: page.getByText(spec.label, { exact: true }) });
    check(`${spec.label} has its static evidence and observation time`, await card.getByText(spec.evidence, { exact: true }).count() === 1 && await card.locator('time').getAttribute('datetime') === new Date(observedAt + index).toISOString());
  }
  check('No raw image or base64 observation enters the DOM', await page.evaluate(() => !/data:image\/|;base64,/.test(document.documentElement.outerHTML) && document.querySelector('#ai-prompts img') === null));
  check('Generic reset control is available with the KSP profile', await page.getByRole('button', { name: 'Reset observations', exact: true }).isVisible());
  await page.locator('#ai-section').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await mkdir(path.join(root, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'shots/ksp-confirmation.png') });

  const launch = page.locator('#ai-prompts article').filter({ has: page.getByText('Launch', { exact: true }) });
  await clickAction(launch.getByRole('button', { name: 'Confirm moment', exact: true }));
  await page.locator('#current-note').getByText('A little encouragement for the first confirmed launch.', { exact: true }).waitFor();
  check('Confirm sends the actual human approval action', actions.length === 1 && actions[0].action === 'confirm_ai' && actions[0].id === 'offline-ksp-launch' && actions[0].approve === true);
  check('Human confirmation alone declares the AI moment', occurrenceCalls.length === 1 && occurrenceCalls[0][0] === 'ksp-launch' && occurrenceCalls[0][2] === 'ai-confirmed' && engine.state.occurrences.length === 1);
  check('Confirmed launch reveals the waiting note with an AI confirmation label', engine.state.notes.find(item => item.id === note.id)?.status === 'revealed' && await page.locator('#current-note').getByText('AI-detected · confirmed by mod', { exact: true }).count() === 1);

  const explosion = page.locator('#ai-prompts article').filter({ has: page.getByText('Destructive explosion', { exact: true }) });
  await clickAction(explosion.getByRole('button', { name: 'Dismiss', exact: true }));
  await page.waitForFunction(() => document.querySelectorAll('#ai-prompts article').length === 4);
  check('Dismiss sends a real rejection action and removes the suggestion', actions[1]?.action === 'confirm_ai' && actions[1].id === 'offline-ksp-explosion' && actions[1].approve === false && !pending.some(prompt => prompt.kind === 'explosion'));
  check('Dismiss never declares an occurred moment', occurrenceCalls.length === 1 && engine.state.occurrences.length === 1 && consumeCalls.length === 2);

  await clickAction(page.getByRole('button', { name: 'Reset observations', exact: true }));
  await page.getByText('No event suggestions. You can declare any moment above.', { exact: true }).waitFor();
  check('Reset sends its real HTTP action and clears pending observations', actions[2]?.action === 'reset_perception' && resets === 1 && pending.length === 0);
  check('Reset preserves confirmed moments and the revealed note', occurrenceCalls.length === 1 && engine.state.occurrences.length === 1 && engine.state.notes.find(item => item.id === note.id)?.status === 'revealed');
  check('No external provider requests or browser errors occurred', external.length === 0 && errors.length === 0);
  console.log(`KSP console browser passed: ${checks.length} checks; confirm=1, dismiss=1, reset=1; screenshot=shots/ksp-confirmation.png.`);
} finally {
  await context.close(); await browser.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
