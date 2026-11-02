import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';
import { listEventPresets } from '../server/event-presets.js';

// Moment choices acceptance: the operator desk and the viewer panel offer only the
// running profile's events and stream-general moments (start/end, Twitch).
// Real HTTP routes, in-memory engine, local Twitch mock; no .env, provider, OBS or Twitch.
const root = path.resolve(import.meta.dirname, '..');
const catalog = await listEventPresets(), ksp = catalog.find(item => item.id === 'ksp'), generic = catalog.find(item => item.id === 'generic');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
// Generic first, so its picture events stay behind as another profile's moments.
await engine.activateEventProfile({ kind: 'builtin', id: 'generic' });
await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
const eventSystem = new EventSystem({ engine });
const watcher = { prompts: () => eventSystem.prompts(), reset: () => eventSystem.reset(), confirm: id => eventSystem.confirm(id) };
const server = await createHTTP({ root, engine, demo: true, watcher, eventSystem, env: {}, integrations: () => ({}) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], actions = [], noteWrites = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push('blocked external request'); return route.abort('blockedbyclient');
});
const desk = await context.newPage(), panel = await context.newPage();
for (const page of [desk, panel]) page.on('pageerror', error => errors.push(error.message));
desk.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/operator/action') actions.push(request.postDataJSON()); });
panel.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/ebs/notes') noteWrites.push(request.postDataJSON()); });

const labelOf = id => engine.config.moments.find(item => item.id === id)?.label;
const generalIds = engine.config.moments.filter(item => item.kind === 'twitch' || (item.kind === 'builtin' && ['start', 'end'].includes(item.id))).map(item => item.id);
const expected = currentIds => ({ current: currentIds.map(labelOf), general: generalIds.filter(id => !currentIds.includes(id)).map(labelOf) });
const banned = ['First death', 'Never', 'Beat Margit', 'Find the key', 'Victory screen', 'Boss defeated', 'Boss door opens'];

// Desk: group titles and their row labels.
const deskGroups = () => desk.locator('#moment-list .moment-group').evaluateAll(groups => Object.fromEntries(groups.map(group =>
  [group.querySelector('h3').textContent, [...group.querySelectorAll('.moment-row strong')].map(node => node.textContent)])));
// Panel: optgroups of a select; the main and after-condition lists must match.
const panelGroups = selector => panel.locator(selector).evaluate(select => Object.fromEntries([...select.querySelectorAll('optgroup')].map(group =>
  [group.label, [...group.querySelectorAll('option')].map(option => option.textContent.replace(/ · carries across streams$/, ''))])));
const refreshPanel = () => panel.evaluate(() => window.dispatchEvent(new CustomEvent('sealed-refresh')));
async function waitFor(predicate, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await desk.waitForTimeout(100); } return false; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function expectBoth(name, want) {
  await refreshPanel();
  const deskOk = await waitFor(async () => { const groups = await deskGroups(); return same(groups['Current profile'] || [], want.current) && same(groups['Stream general'] || [], want.general); });
  const panelOk = await waitFor(async () => { const main = await panelGroups('#moment'); return same(main['Current profile'] || [], want.current) && same(main['Stream general'] || [], want.general); });
  const main = await panelGroups('#moment'), after = await panelGroups('#condition-after');
  const deskText = await desk.locator('#moment-list').innerText(), panelText = await panel.locator('#moment, #condition-after').evaluateAll(nodes => nodes.map(node => node.textContent).join('|'));
  check(`${name}: desk lists exactly the current profile and stream-general moments`, deskOk);
  check(`${name}: panel main list matches, in two groups`, panelOk && Object.keys(main).every(label => ['Current profile', 'Stream general'].includes(label)));
  check(`${name}: panel after-condition list matches the main list`, same(main, after));
  const hidden = banned.filter(label => !want.current.includes(label));
  check(`${name}: no first death, never, demo or other-profile moments`, hidden.every(label => !deskText.includes(label) && !panelText.includes(label)));
}
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

try {
  await desk.goto(`${origin}/console`);
  await desk.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();
  await panel.setViewportSize({ width: 320, height: 900 });
  await panel.goto(`${origin}/panel.html?demo=1`);
  await panel.getByRole('button', { name: /Prediction/ }).waitFor();

  check('The desk has no history list and no separate Add moment form', await desk.locator('#moment-history, #moment-form, #moment-label').count() === 0 &&
    !(await desk.locator('body').innerText()).includes('Other & historical'));

  // KSP.
  await expectBoth('KSP', expected(ksp.events.map(item => item.id)));
  await desk.locator('#moment-list').locator('xpath=ancestor::section[1]').screenshot({ path: path.join(shots, 'moments-ksp.png') });
  await desk.fill('#moment-context', 'Off the pad');
  await desk.locator('[data-focus="declare:ksp-launch"]').click();
  check('Declaring a current-profile moment sends it with context', await waitFor(() => actions.some(item => item.action === 'moment' && item.moment_id === 'ksp-launch' && item.context === 'Off the pad')));

  // Generic: first death is shown only because the generic profile is running.
  await engine.activateEventProfile({ kind: 'builtin', id: 'generic' });
  await expectBoth('Generic', expected(generic.events.map(item => item.id)));
  check('Generic: first death sits in Current profile, never in Stream general', !((await deskGroups())['Stream general'] || []).includes('First death'));

  // Custom definitions: an old envelope is sealed for a custom event.
  await engine.importEventDefinitions([{ id: 'boss-door', label: 'Boss door opens', description: 'The boss door visibly opens.', mode: 'instant' }]);
  await expectBoth('Custom', expected(['boss-door']));
  const oldBody = 'Moments canary: the boss door opens on the first try';
  await panel.getByLabel('What would you like to say?').fill(oldBody);
  await panel.getByLabel(/^Open when/).selectOption('boss-door');
  await panel.getByRole('button', { name: /Seal this note/ }).click();
  await panel.getByText('Sealed. See you at the moment.', { exact: true }).waitFor();

  // Draft for the custom event, then the profile changes under it.
  const draft = 'A draft that must not move to another moment';
  await panel.getByLabel('What would you like to say?').fill(draft);
  await panel.getByLabel(/^Open when/).selectOption('boss-door');
  await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
  await expectBoth('Back to KSP', expected(ksp.events.map(item => item.id)));
  check('The draft words are kept after the switch', await panel.getByLabel('What would you like to say?').inputValue() === draft);
  check('The lost target asks to be chosen again instead of binding another moment', await panel.locator('#moment').inputValue() === '' &&
    await panel.locator('#moment option:checked').textContent() === 'Choose a moment again' && await panel.locator('#moment-hint').isVisible());
  const writes = noteWrites.length;
  await panel.getByRole('button', { name: /Seal this note/ }).click();
  check('Sealing is blocked until a moment is chosen', await panel.locator('#status').textContent() === 'Choose a moment for your note.' && noteWrites.length === writes &&
    await panel.evaluate(() => document.activeElement?.id === 'moment'));
  await panel.getByLabel(/^Open when/).selectOption('ksp-flag');
  check('Choosing again clears the prompt', await panel.locator('#moment-hint').isHidden() && await panel.locator('#moment').inputValue() === 'ksp-flag');
  await panel.screenshot({ path: path.join(shots, 'moments-panel-320.png'), fullPage: true });

  // The old envelope keeps its moment label everywhere, words hidden.
  await panel.getByRole('tab', { name: /Your notes/ }).click();
  check('Your notes keeps the old envelope label and hides the words', (await panel.locator('#own-notes').innerText()).includes('Boss door opens') && !(await panel.locator('body').innerText()).includes(oldBody));
  check('The desk sealed queue keeps the old envelope label', await waitFor(async () => (await desk.locator('#sealed-queue').innerText()).includes('Boss door opens')) &&
    !(await desk.locator('body').innerText()).includes(oldBody));
  await panel.getByRole('tab', { name: /Write a note/ }).click();

  // Empty profile: only stream-general moments; the after list follows.
  await engine.importEventDefinitions([]);
  await expectBoth('Empty', expected([]));
  check('Empty: the desk explains how to choose a profile', await desk.locator('.moment-empty').isVisible());
  check('Empty: the panel has no Current profile group', await panel.locator('#moment optgroup[label="Current profile"]').count() === 0);
  check('History, notes and cooldown state are kept across switches', engine.state.notes.some(note => note.body === oldBody && note.status === 'sealed'));

  check('No external requests and no page errors', external.length === 0 && errors.length === 0);
  console.log(`Moment choices browser passed: ${checks.length} checks; screenshots=shots/moments-{ksp,panel-320}.png.`);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
