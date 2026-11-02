import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHTTP } from '../server/http.js';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';
import { listEventPresets } from '../server/event-presets.js';

// Event management UI acceptance: real operator HTTP routes, in-memory engine and
// candidate ledger, an isolated headless browser, and a throwaway fixture token.
// No .env, provider client, OBS capture, Twitch connection or user browser profile.
const root = path.resolve(import.meta.dirname, '..');
const preset = async name => JSON.parse(await readFile(path.join(root, 'presets', name), 'utf8'));
const ksp = await preset('ksp.json'), generic = await preset('generic.json');
const catalog = await listEventPresets(), kspPreset = catalog.find(item => item.id === 'ksp'), genericPreset = catalog.find(item => item.id === 'generic');
const engine = new NotesEngine({ store: new MemoryStore(), decisions: new DemoJudgements() });
await engine.activateEventProfile({ kind: 'builtin', id: 'ksp' });
const eventSystem = new EventSystem({ engine });
const watcher = { prompts: () => eventSystem.prompts(), reset: () => eventSystem.reset(), confirm: id => eventSystem.confirm(id) };
const fixtureToken = 'offline-ui-fixture-token-not-a-credential-0123456789';
const server = await createHTTP({ root, engine, demo: true, watcher, eventSystem, env: { EVENTS_API_TOKEN: fixtureToken },
  integrations: () => ({ perception: { profile: 'generic', enabled: true, status: 'watching', message: 'Offline fixtures. Human confirmation is required.' } }),
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const trigger = (event_id, idempotency_key) => fetch(`${origin}/api/events/trigger`, { method: 'POST',
  headers: { Authorization: `Bearer ${fixtureToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id, idempotency_key }) });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', reducedMotion: 'reduce' });
context.setDefaultTimeout(10000);
const checks = [], external = [], errors = [], actions = [];
let stateReads = 0;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push('blocked external request'); return route.abort('blockedbyclient');
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const { pathname } = new URL(request.url());
  if (pathname === '/api/operator/state') stateReads++;
  if (request.method() === 'POST' && pathname === '/api/operator/action') actions.push(JSON.parse(request.postData()));
});
const ids = () => engine.config.events.map(item => item.id);
const rows = () => page.locator('#event-list .event-row');
const row = label => rows().filter({ has: page.getByText(label, { exact: true }) });
async function clickAction(button, expected = 200) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/operator/action' && response.request().method() === 'POST');
  await button.click();
  const result = await response;
  assert.equal(result.status(), expected, 'Console action reaches the real HTTP route');
  return result.json();
}
async function waitForPolls(count) { const target = stateReads + count; await page.waitForFunction(() => true); while (stateReads < target) await page.waitForTimeout(250); }
const shots = path.join(root, 'shots');
await mkdir(shots, { recursive: true });

try {
  await page.goto(`${origin}/console`);
  await page.getByText('Your desk is ready. Declare a moment when it happens.', { exact: true }).waitFor();
  await page.locator('#event-list .event-row').first().waitFor();
  check('Definition list shows count and all six KSP events', await page.locator('#event-count').textContent() === '6 / 12' && await rows().count() === 6);
  check('Rows show mode, confidence threshold, cooldown and API status', await row('Launch').getByText('One matching window · 85% confidence threshold · 30 s cooldown', { exact: true }).count() === 1 && await row('Launch').getByText('API waits for you', { exact: true }).count() === 1);
  check('The UI never calls the threshold an accuracy', !/accuracy/i.test(await page.locator('#events-section').innerText()));
  await page.locator('#events-section').scrollIntoViewIfNeeded();
  await page.locator('#events-section').screenshot({ path: path.join(shots, 'events-list.png') });

  // Game profiles: built-ins from the catalog, saved profiles from operator state, both keyed by kind and stable ID.
  const reads = ['events_presets', 'events_profiles'];
  const mutations = () => actions.filter(item => !reads.includes(item.action)).length;
  const presetCurrent = page.locator('#event-preset-current'), presetSelect = page.locator('#event-preset-select'), presetPreview = page.locator('#event-preset-preview');
  const profileState = () => page.evaluate(async () => (await (await fetch('/api/operator/state')).json()).event_profiles);
  const savedId = async label => (await profileState()).profiles.find(item => item.label === label)?.id;
  const sideAction = body => page.evaluate(async payload => { const response = await fetch('/api/operator/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sealed-Action': '1' }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() }; }, body);
  const switchImpact = 'Pending suggestions and picture evidence clear. Cooldowns, notes, moments and history stay.';
  await presetCurrent.getByText(`In use: ${kspPreset.label}`, { exact: true }).waitFor();
  check('The selector groups the built-in catalog and shows the active KSP reference', actions.some(item => item.action === 'events_presets') && await presetSelect.inputValue() === 'builtin:ksp' &&
    JSON.stringify(await presetSelect.locator('optgroup[label="Built-in · read-only"] option').allTextContents()) === JSON.stringify(catalog.map(item => item.label)));
  let writes = mutations();
  await presetSelect.selectOption('builtin:generic');
  check('Choosing a profile previews it without writing', await presetPreview.isVisible() && writes === mutations() && JSON.stringify(ids()) === JSON.stringify(ksp.events.map(item => item.id)));
  check('The preview names the replacement and its impact', await presetPreview.getByText(`Switch to ${genericPreset.label}?`, { exact: true }).isVisible() &&
    await presetPreview.getByText(`Replaces all 6 current events with ${genericPreset.events.length} events:`, { exact: true }).isVisible() &&
    JSON.stringify(await presetPreview.locator('li').allTextContents()) === JSON.stringify(genericPreset.events.map(item => `${item.label} · ${item.id}`)) &&
    await presetPreview.getByText(switchImpact, { exact: true }).isVisible() && await page.locator('#event-import-preview').isHidden());
  await waitForPolls(2);
  check('Polling keeps the pending profile choice and preview', await presetSelect.inputValue() === 'builtin:generic' && await presetPreview.isVisible() && writes === mutations());
  await page.click('#event-preset-cancel');
  check('Cancel closes the preview without a request', await presetPreview.isHidden() && await presetSelect.inputValue() === 'builtin:ksp' && writes === mutations() && await page.evaluate(() => document.activeElement?.id === 'event-preset-select'));

  // Unsaved editor and import drafts are named, never silently dropped.
  await page.click('#event-add'); await page.fill('#event-label', 'Unsaved draft');
  await page.locator('#event-import summary').click(); await page.fill('#event-import-text', '{"version":1,"events":[]}');
  await presetSelect.selectOption('builtin:generic');
  check('An open editor must be explicitly discarded before applying', await presetPreview.getByText('The open editor (New event) has unsaved changes. Applying closes it and discards them.', { exact: true }).isVisible() &&
    await page.locator('#event-preset-discard').isVisible() && await page.locator('#event-preset-apply').isDisabled());
  check('Pasted import JSON is named and kept apart from the profile preview', await presetPreview.getByText('Your pasted JSON in Import a preset stays there and is not applied.', { exact: true }).isVisible() && await page.locator('#event-import-preview').isHidden());
  await waitForPolls(2);
  check('Polling keeps the profile choice, editor draft and pasted JSON', await presetSelect.inputValue() === 'builtin:generic' && await page.locator('#event-label').inputValue() === 'Unsaved draft' &&
    await page.locator('#event-import-text').inputValue() === '{"version":1,"events":[]}' && writes === mutations());
  await page.check('#event-preset-discard');
  await page.locator('#events-section').screenshot({ path: path.join(shots, 'events-preset-preview.png') });

  // A failed apply keeps everything for a retry.
  const activateProfile = engine.activateEventProfile;
  engine.activateEventProfile = async () => { engine.activateEventProfile = activateProfile; throw Object.assign(new Error('fixture failure'), { status: 409, code: 'fixture_conflict' }); };
  await clickAction(page.locator('#event-preset-apply'), 409);
  check('A failed apply keeps the preview, choice and draft', await page.locator('#event-preset-error').isVisible() && await presetPreview.isVisible() && await presetSelect.inputValue() === 'builtin:generic' &&
    await page.locator('#event-label').inputValue() === 'Unsaved draft' && JSON.stringify(ids()) === JSON.stringify(ksp.events.map(item => item.id)));
  await clickAction(page.locator('#event-preset-apply'));
  await page.locator('#event-count').getByText(`${genericPreset.events.length} / 12`, { exact: true }).waitFor();
  check('Retry activates the built-in by kind and ID', actions.at(-1).action === 'events_profile_activate' && actions.at(-1).profile_kind === 'builtin' && actions.at(-1).profile_id === 'generic' &&
    !('expected_revision' in actions.at(-1)) && JSON.stringify(engine.config.events) === JSON.stringify(genericPreset.events) && actions.filter(item => item.action === 'reset_perception').length === 0);
  await presetCurrent.getByText(`In use: ${genericPreset.label}`, { exact: true }).waitFor();
  check('Success closes the preview and the discarded editor, and keeps pasted JSON', await presetPreview.isHidden() && await page.locator('#event-editor').isHidden() &&
    await presetSelect.inputValue() === 'builtin:generic' && await page.locator('#event-import-text').inputValue() === '{"version":1,"events":[]}');
  await page.fill('#event-import-text', ''); await page.locator('#event-import summary').click();

  // Editing running events keeps the reference and marks it modified.
  const edited = genericPreset.events[0];
  await page.locator(`[data-focus="edit:${edited.id}"]`).click();
  await page.fill('#event-cooldown-s', String(edited.cooldown_s + 1));
  await clickAction(page.locator('#event-save'));
  await presetCurrent.getByText(`In use: ${genericPreset.label} · modified`, { exact: true }).waitFor();
  check('An edited built-in stays referenced and reads as modified', await presetSelect.inputValue() === 'builtin:generic' && await page.locator('#event-preset-review').isVisible() && (await profileState()).dirty === true);
  await page.locator('#event-preset').screenshot({ path: path.join(shots, 'events-preset-custom.png') });

  // New profile from blank: a local draft that never touches recognition.
  writes = mutations();
  const running = JSON.stringify(engine.config.events);
  await page.click('#profile-new');
  check('New profile opens a draft that copies the running events by default', await page.locator('#profile-editor').isVisible() && await page.locator('#profile-start-current').isChecked() &&
    await page.locator('#profile-event-list .event-row').count() === genericPreset.events.length && await page.evaluate(() => document.activeElement?.id === 'profile-label'));
  await page.check('#profile-start-blank');
  check('Start blank empties the draft', await page.locator('#profile-event-list .event-row').count() === 0 && await page.locator('#profile-event-count').textContent() === '0 / 12');
  await page.click('#profile-save');
  check('A nameless draft is refused before any request', await page.locator('#profile-error').textContent() === 'Add a profile name.' && writes === mutations());
  await page.fill('#profile-label', 'Speedrun splits');
  await page.fill('#profile-description', 'Split markers for timed runs.');
  await page.click('#profile-event-add');
  check('Draft events use the shared editor with draft wording', await page.locator('#event-editor-title').textContent() === 'New event in the draft' && await page.locator('#event-save').textContent() === 'Add to draft');
  check('An open draft event form blocks Save profile and other entry points', await page.locator('#profile-save').isDisabled() && await page.locator('#profile-save-hint').isVisible() &&
    await page.locator('#event-add').isDisabled() && await page.locator('#profile-event-add').isDisabled() && await page.locator(`[data-focus="edit:${edited.id}"]`).isDisabled());
  await page.fill('#event-label', 'Split reached'); await page.fill('#event-description', 'A split timer turns green after a checkpoint.');
  await page.click('#event-save');
  await page.click('#profile-event-add');
  await page.fill('#event-label', 'Run reset'); await page.fill('#event-description', 'The run timer visibly returns to zero.');
  await page.click('#event-save');
  await page.locator('[data-focus="draft-delete:run-reset"]').click();
  check('Draft add, edit and remove send no request and leave recognition alone', await page.locator('#profile-event-list .event-row').count() === 1 && writes === mutations() &&
    JSON.stringify(engine.config.events) === running && await page.locator('#profile-start-blank').isDisabled());
  await waitForPolls(2);
  check('Polling keeps the draft name, description and events', await page.locator('#profile-label').inputValue() === 'Speedrun splits' && await page.locator('#profile-description').inputValue() === 'Split markers for timed runs.' &&
    await page.locator('#profile-event-list .event-row').count() === 1 && await page.locator('#profile-editor').isVisible());
  await page.locator('#events-section').screenshot({ path: path.join(shots, 'events-profile-draft.png') });
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  const splitsId = await savedId('Speedrun splits');
  check('Save creates a profile without applying it', actions.at(-1).action === 'events_profile_save' && !('id' in actions.at(-1).profile) && splitsId?.startsWith('profile-') &&
    JSON.stringify(engine.config.events) === running && await presetCurrent.textContent() === `In use: ${genericPreset.label} · modified` &&
    await page.getByText('Saved Speedrun splits. Apply it to start using it.', { exact: true }).isVisible());
  await presetSelect.locator(`option[value="profile:${splitsId}"]`).waitFor({ state: 'attached' });
  check('The saved profile appears under Saved profiles', await presetSelect.locator('optgroup[label="Saved profiles"] option').allTextContents().then(list => list.includes('Speedrun splits')));

  // Copy the running events; then a second profile with identical events.
  await page.click('#profile-new');
  await page.fill('#profile-label', 'Generic tweaked');
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  const tweakedId = await savedId('Generic tweaked');
  check('Copying the running events saves their exact snapshot', JSON.stringify((await profileState()).profiles.find(item => item.id === tweakedId).events) === running);
  await page.click('#profile-new');
  await page.fill('#profile-label', 'generic TWEAKED');
  await page.click('#profile-save');
  check('A case-insensitive duplicate name is refused before any request', (await page.locator('#profile-error').textContent()).includes('already named') && actions.at(-1).profile?.label === 'Generic tweaked');
  await page.fill('#profile-label', 'Twin profile');
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  const twinId = await savedId('Twin profile');
  await presetSelect.selectOption(`profile:${twinId}`);
  check('Saved profile previews show their version', await presetPreview.getByText('Switch to Twin profile?', { exact: true }).isVisible() && await presetPreview.getByText('Saved profile, version 1', { exact: true }).isVisible());
  await clickAction(page.locator('#event-preset-apply'));
  await presetCurrent.getByText('In use: Twin profile', { exact: true }).waitFor();
  check('Apply sends the stable ID and expected revision', actions.at(-1).action === 'events_profile_activate' && actions.at(-1).profile_kind === 'profile' && actions.at(-1).profile_id === twinId && actions.at(-1).expected_revision === 1);
  await page.reload();
  await presetCurrent.getByText('In use: Twin profile', { exact: true }).waitFor();
  check('After reload the same-content twin keeps its own name and ID', await presetSelect.inputValue() === `profile:${twinId}` && (await profileState()).active_ref.id === twinId &&
    await presetSelect.locator('optgroup[label="Saved profiles"] option').count() === 3);

  // Running edits never rewrite the saved snapshot; saving them is explicit.
  await page.locator(`[data-focus="edit:${edited.id}"]`).click();
  await page.fill('#event-cooldown-s', String(edited.cooldown_s + 2));
  await clickAction(page.locator('#event-save'));
  await presetCurrent.getByText('In use: Twin profile · modified', { exact: true }).waitFor();
  check('A running edit leaves the saved twin snapshot unchanged', JSON.stringify((await profileState()).profiles.find(item => item.id === twinId).events) === running && (await profileState()).profiles.find(item => item.id === twinId).revision === 1);
  await page.locator('#profile-update').click();
  check('Save running events opens an explicit draft for the active profile', await page.locator('#profile-editor-title').textContent() === 'Save running events to Twin profile' &&
    await page.locator('#profile-label').inputValue() === 'Twin profile' && await page.locator('#profile-start').isHidden());
  await clickAction(page.locator('#profile-save'));
  await page.locator('#event-preset-note').getByText('A newer saved version of Twin profile exists. Apply it to start using it.', { exact: true }).waitFor();
  const twinSaved = (await profileState()).profiles.find(item => item.id === twinId);
  check('The explicit save creates version 2 from the running events', actions.at(-1).profile.id === twinId && actions.at(-1).profile.expected_revision === 1 && twinSaved.revision === 2 &&
    JSON.stringify(twinSaved.events) === JSON.stringify(engine.config.events));
  await page.click('#event-preset-review');
  check('Reviewing the newer version offers the same profile again', await presetPreview.getByText('Apply the saved Twin profile again?', { exact: true }).isVisible() && await presetPreview.getByText('Saved profile, version 2', { exact: true }).isVisible());
  await clickAction(page.locator('#event-preset-apply'));
  await presetCurrent.getByText('In use: Twin profile', { exact: true }).waitFor();
  check('Applying version 2 clears the modified state', actions.at(-1).expected_revision === 2 && (await profileState()).active_ref.revision === 2 && await page.locator('#event-preset-review').isHidden());

  // Editing a saved profile: a concurrent save produces 409 and keeps the draft.
  await page.click('#profile-edit');
  check('Edit profile loads the saved name and version', await page.locator('#profile-editor-title').textContent() === 'Edit Twin profile' && await page.locator('#profile-label').inputValue() === 'Twin profile');
  await page.fill('#profile-label', 'Twin profile v3');
  const concurrent = await sideAction({ action: 'events_profile_save', profile: { id: twinId, expected_revision: 2, label: 'Twin profile', description: 'Saved in another tab.', events: twinSaved.events } });
  assert.equal(concurrent.status, 200);
  await clickAction(page.locator('#profile-save'), 409);
  check('A revision conflict keeps the draft and offers Save as new or reload', await page.locator('#profile-conflict').isVisible() && await page.locator('#profile-label').inputValue() === 'Twin profile v3' &&
    (await page.locator('#profile-error').textContent()).includes('Your draft is kept'));
  await waitForPolls(2);
  check('Polling keeps the conflicted draft', await page.locator('#profile-label').inputValue() === 'Twin profile v3' && await page.locator('#profile-conflict').isVisible());
  await page.click('#profile-reload');
  check('Load latest version replaces the draft explicitly', await page.locator('#profile-description').inputValue() === 'Saved in another tab.' && await page.locator('#profile-label').inputValue() === 'Twin profile');
  await page.fill('#profile-label', 'Twin profile renamed');
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  const renamed = (await profileState()).profiles.find(item => item.id === twinId);
  check('Saving after reload uses the latest revision', actions.at(-1).profile.expected_revision === 3 && renamed.revision === 4 && renamed.label === 'Twin profile renamed');
  await page.waitForFunction(id => document.querySelector(`#event-preset-select option[value="profile:${id}"]`)?.textContent === 'Twin profile renamed', twinId);
  check('A renamed newer version keeps the applied name in use until it is applied', await presetCurrent.textContent() === 'In use: Twin profile' &&
    await page.locator('#event-preset-note').textContent() === 'A newer saved version of Twin profile exists. Apply it to start using it.' && (await profileState()).active_ref.revision === 2);

  await page.click('#profile-edit');
  await page.fill('#profile-label', 'Twin profile v3');
  assert.equal((await sideAction({ action: 'events_profile_save', profile: { id: twinId, expected_revision: 4, label: 'Twin profile renamed', events: twinSaved.events } })).status, 200);
  await clickAction(page.locator('#profile-save'), 409);
  await page.click('#profile-save-new');
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  check('Save as new after a conflict keeps the original and adds a profile', !('id' in actions.at(-1).profile) && !!(await savedId('Twin profile v3')) && (await profileState()).profiles.find(item => item.id === twinId).revision === 5);

  // Built-ins stay read-only but can be copied; a changed draft needs a confirmed discard.
  await presetSelect.selectOption('builtin:ksp');
  check('Built-ins offer Save as new profile but no edit', await page.locator('#profile-duplicate').isVisible() && await page.locator('#profile-edit').isHidden());
  await page.click('#profile-duplicate');
  check('Copying a built-in starts a named draft with its events', await page.locator('#profile-label').inputValue() === `${kspPreset.label} copy` && await page.locator('#profile-event-list .event-row').count() === 6);
  writes = mutations();
  await page.fill('#profile-label', 'KSP practice');
  await page.click('#profile-cancel');
  check('Cancel on a changed draft asks before discarding', await page.locator('#profile-discard').isVisible() && await page.locator('#profile-editor').isVisible());
  await page.click('#profile-discard-keep');
  await page.click('#profile-cancel'); await page.click('#profile-discard-confirm');
  check('Discard closes the draft without a request', await page.locator('#profile-editor').isHidden() && writes === mutations());

  // A failed save keeps the whole draft for a retry.
  await page.click('#profile-new');
  await page.fill('#profile-label', 'Retry me');
  const saveProfile = engine.saveEventProfile;
  engine.saveEventProfile = async () => { engine.saveEventProfile = saveProfile; throw Object.assign(new Error('fixture failure'), { status: 503, code: 'service_unavailable' }); };
  await clickAction(page.locator('#profile-save'), 503);
  check('A failed save keeps the draft', await page.locator('#profile-editor').isVisible() && await page.locator('#profile-label').inputValue() === 'Retry me' && await page.locator('#profile-error').isVisible());
  await clickAction(page.locator('#profile-save'));
  await page.locator('#profile-editor').waitFor({ state: 'hidden' });
  check('Retrying the save succeeds', !!(await savedId('Retry me')));

  await presetSelect.selectOption('builtin:ksp');
  check('Switching back previews the KSP replacement', await presetPreview.getByText(`Replaces all ${genericPreset.events.length} current events with 6 events:`, { exact: true }).isVisible());
  await clickAction(page.locator('#event-preset-apply'));
  await page.locator('#event-count').getByText('6 / 12', { exact: true }).waitFor();
  await presetCurrent.getByText(`In use: ${kspPreset.label}`, { exact: true }).waitFor();
  check('Switching back to KSP restores its exact definitions', JSON.stringify(engine.config.events) === JSON.stringify(ksp.events) && await presetSelect.inputValue() === 'builtin:ksp' && await presetPreview.isHidden());

  // Create, with polling in between: unsaved edits survive the 2 s refresh.
  await page.locator('#event-add').focus(); await page.keyboard.press('Enter');
  check('Keyboard opens the editor and focuses the name field', await page.locator('#event-editor').isVisible() && await page.evaluate(() => document.activeElement?.id === 'event-label'));
  await page.keyboard.type('Docking ✨ port');
  check('ID is suggested from the name for new events', await page.locator('#event-id').inputValue() === 'docking-port');
  await page.fill('#event-id', 'docking');
  await page.fill('#event-description', 'Two craft visibly join at a docking port and stay attached.');
  check('Detection options name each mode and the help explains the baseline rule',
    JSON.stringify(await page.locator('#event-mode option').allTextContents()) === JSON.stringify(['One matching window', 'Stays visible — needs a baseline']) &&
    await page.locator('#event-mode').getAttribute('aria-describedby') === 'event-mode-help' &&
    await page.locator('#event-mode-help').textContent() === 'One matching window: a single matching review makes a suggestion. Stays visible: two clear reviews without it set a baseline, then two matching reviews in a row make a suggestion.');
  await page.selectOption('#event-mode', 'instant');
  await page.fill('#event-min-confidence', '0.9');
  await page.fill('#event-cooldown-s', '45');
  check('Counters count Unicode characters', await page.locator('#event-label-count').textContent() === '14/100');
  await waitForPolls(2);
  check('Two polling refreshes keep every unsaved form value', await page.locator('#event-label').inputValue() === 'Docking ✨ port' && await page.locator('#event-id').inputValue() === 'docking' &&
    await page.locator('#event-description').inputValue() === 'Two craft visibly join at a docking port and stay attached.' && await page.locator('#event-mode').inputValue() === 'instant' &&
    await page.locator('#event-min-confidence').inputValue() === '0.9' && await page.locator('#event-cooldown-s').inputValue() === '45');
  await page.screenshot({ path: path.join(shots, 'events-editor.png'), fullPage: false, clip: await page.locator('#events-section').boundingBox() });

  // Client-side validation blocks a request.
  const before = actions.length;
  await page.fill('#event-description', '   ');
  await page.click('#event-save');
  check('Empty evidence is rejected before any request', await page.locator('#event-form-error').textContent() === 'Add a description.' && actions.length === before);
  await page.fill('#event-description', '✨'.repeat(301));
  check('Over-long Unicode evidence marks its counter', await page.locator('#event-description-count').textContent() === '301/300' && await page.locator('#event-description-count.over').count() === 1);
  await page.click('#event-save');
  check('Over-long evidence is rejected before any request', (await page.locator('#event-form-error').textContent()).includes('300 characters') && actions.length === before);
  await page.fill('#event-id', 'ksp-launch');
  await page.fill('#event-description', 'Two craft visibly join at a docking port and stay attached.');
  await page.click('#event-save');
  check('Duplicate IDs are rejected before any request', (await page.locator('#event-form-error').textContent()).includes('already in use') && actions.length === before);

  // A real server rejection keeps the form intact.
  await page.fill('#event-id', 'margit');
  const rejected = await clickAction(page.locator('#event-save'), 409);
  check('Backend rejection of a declared-moment ID is shown without losing edits', rejected.ok === false && await page.locator('#event-form-error').isVisible() &&
    await page.locator('#event-editor').isVisible() && await page.locator('#event-label').inputValue() === 'Docking ✨ port' && !ids().includes('margit'));
  await page.fill('#event-id', 'docking');
  await clickAction(page.locator('#event-save'));
  await page.locator('#event-count').getByText('7 / 12', { exact: true }).waitFor();
  const docking = engine.config.events.find(item => item.id === 'docking');
  check('Create sends events_upsert and the backend stores the normalized definition', actions.at(-1).action === 'events_upsert' && docking?.label === 'Docking ✨ port' && docking.mode === 'instant' && docking.min_confidence === 0.9 && docking.cooldown_s === 45 && docking.auto_confirm === false);
  check('The editor closes only after the server accepted it', await page.locator('#event-editor').isHidden() && await row('Docking ✨ port').count() === 1);

  // Edit keeps the ID fixed.
  await row('Docking ✨ port').getByRole('button', { name: 'Edit Docking ✨ port' }).click();
  check('Editing locks the ID', await page.locator('#event-id').getAttribute('readonly') !== null && await page.locator('#event-id').inputValue() === 'docking');
  await page.fill('#event-cooldown-s', '60');
  await page.check('#event-auto-confirm');
  await clickAction(page.locator('#event-save'));
  await row('Docking ✨ port').getByText('API opens notes', { exact: true }).waitFor();
  check('Update replaces the same ID', engine.config.events.filter(item => item.id === 'docking').length === 1 && engine.config.events.find(item => item.id === 'docking').cooldown_s === 60 && engine.config.events.find(item => item.id === 'docking').auto_confirm === true);

  // Delete needs an explicit second step and keeps moments.
  await row('Docking ✨ port').getByRole('button', { name: 'Delete Docking ✨ port' }).click();
  check('Delete explains that history stays', await page.getByText('Stop recognizing Docking ✨ port? Its moment, sealed notes and history stay.', { exact: true }).isVisible());
  check('Delete moves focus to the confirmation button', await page.evaluate(() => document.activeElement?.dataset?.focus === 'confirm:docking'));
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  check('Keep cancels without a request', ids().includes('docking') && actions.at(-1).action === 'events_upsert');
  await row('Docking ✨ port').getByRole('button', { name: 'Delete Docking ✨ port' }).click();
  await clickAction(page.getByRole('button', { name: 'Delete event', exact: true }));
  await page.locator('#event-count').getByText('6 / 12', { exact: true }).waitFor();
  check('Delete sends events_delete and keeps the moment for history', actions.at(-1).action === 'events_delete' && actions.at(-1).event_id === 'docking' && !ids().includes('docking') && engine.config.moments.some(item => item.id === 'docking'));

  // Import: pasted text survives polling, replacement must be acknowledged.
  await page.locator('#event-import summary').click();
  await page.fill('#event-import-text', JSON.stringify(generic));
  await waitForPolls(2);
  check('Two polling refreshes keep pasted import text', await page.locator('#event-import-text').inputValue() === JSON.stringify(generic));
  await page.click('#event-import-check');
  check('Preview states the full replacement', await page.getByText('Replaces all 6 current events with 3 events.', { exact: true }).isVisible() && await page.locator('#event-import-apply').isDisabled());
  await page.check('#event-import-ack');
  await page.locator('#events-section').screenshot({ path: path.join(shots, 'events-import.png') });
  await clickAction(page.locator('#event-import-apply'));
  await page.locator('#event-count').getByText('3 / 12', { exact: true }).waitFor();
  check('Import sends events_import with the exact preset', actions.at(-1).action === 'events_import' && JSON.stringify(engine.config.events) === JSON.stringify(generic.events));
  await page.locator('#event-preset-current').getByText('In use: Custom events', { exact: true }).waitFor();
  check('JSON import clears the profile link and shows Custom events', (await profileState()).active_ref === null && await page.locator('#event-preset-select').inputValue() === 'custom');

  const thirteen = { version: 1, events: Array.from({ length: 13 }, (_, index) => ({ ...generic.events[0], id: `bulk-${index}` })) };
  await page.locator('#event-import summary').click();
  await page.fill('#event-import-text', JSON.stringify(thirteen));
  await page.click('#event-import-check');
  check('Over-limit preset is refused before any request', await page.getByText('A preset can hold at most 12 events.', { exact: true }).isVisible() && await page.locator('#event-import-apply').isDisabled() && actions.at(-1).action === 'events_import' && ids().length === 3);
  await page.fill('#event-import-text', '{"version":1,"events":[{"id":"Bad ID"}]}');
  await page.click('#event-import-check');
  check('Malformed preset is refused before any request', (await page.locator('#event-import-preview').textContent()).startsWith('Event 1:') && await page.locator('#event-import-apply').isDisabled());

  const twelve = { version: 1, events: [...ksp.events, ...generic.events, ...['alpha', 'beta', 'gamma'].map(id => ({ ...generic.events[1], id, label: id }))] };
  await page.fill('#event-import-text', JSON.stringify(twelve));
  await page.click('#event-import-check'); await page.check('#event-import-ack');
  await clickAction(page.locator('#event-import-apply'));
  await page.locator('#event-count').getByText('12 / 12', { exact: true }).waitFor();
  check('At 12 events Add is disabled and the limit is explained', await page.locator('#event-add').isDisabled() && await page.getByText('12 events is the limit. Delete one to add another.', { exact: true }).isVisible());

  await page.locator('#event-import summary').click();
  await page.setInputFiles('#event-import-file', path.join(root, 'presets/ksp.json'));
  await page.getByText('Replaces all 12 current events with 6 events.', { exact: true }).waitFor();
  await page.check('#event-import-ack');
  await clickAction(page.locator('#event-import-apply'));
  await page.locator('#event-count').getByText('6 / 12', { exact: true }).waitFor();
  check('A chosen preset file replaces definitions', JSON.stringify(engine.config.events) === JSON.stringify(ksp.events));

  // Candidates from both sources share Confirm/Dismiss/Reset.
  const apiResponse = await trigger('ksp-landing', 'ui-landing-01');
  check('Fixture API trigger creates a candidate', apiResponse.status === 200 && (await apiResponse.json()).status === 'candidate');
  await eventSystem.propose('ksp-eva', { observedAt: Date.now() - 500 });
  await page.locator('#ai-prompts article').nth(1).waitFor();
  const apiCard = page.locator('#ai-prompts article[data-source=api]'), aiCard = page.locator('#ai-prompts article[data-source=ai]');
  check('Sources are labelled distinctly', await apiCard.getByText('API trigger', { exact: true }).count() === 1 && await aiCard.getByText('AI picture', { exact: true }).count() === 1);
  check('Timestamps and expiry are shown', await apiCard.locator('time').count() === 2 && (await apiCard.locator('p').first().textContent()).startsWith('Requested ') && (await aiCard.locator('p').first().textContent()).startsWith('Observed '));
  check('No token, image data or raw provider text enters the DOM', await page.evaluate(token => !document.documentElement.outerHTML.includes(token) && !/data:image\/|;base64,/.test(document.documentElement.outerHTML) && !document.querySelector('#ai-prompts img'), fixtureToken));
  await page.locator('#ai-section').screenshot({ path: path.join(shots, 'events-suggestions.png') });
  await clickAction(apiCard.getByRole('button', { name: 'Confirm moment', exact: true }));
  check('Confirming an API suggestion records an API-confirmed occurrence', actions.at(-1).action === 'confirm_ai' && actions.at(-1).approve === true && engine.state.occurrences.length === 1 && engine.state.occurrences[0].moment_id === 'ksp-landing');
  await clickAction(page.locator('#ai-prompts article[data-source=ai]').getByRole('button', { name: 'Dismiss', exact: true }));
  await page.getByText('No event suggestions. You can declare any moment above.', { exact: true }).waitFor();
  check('Dismiss removes the AI suggestion without an occurrence', actions.at(-1).approve === false && engine.state.occurrences.length === 1);

  const pendingResponse = await trigger('ksp-flag', 'ui-flag-01');
  assert.equal(pendingResponse.status, 200);
  await page.locator('#ai-prompts article[data-source=api]').waitFor();
  check('Reset is offered for the generic system', await page.locator('#observation-controls').isVisible() && await page.getByRole('button', { name: 'Reset observations', exact: true }).isVisible());
  await clickAction(page.getByRole('button', { name: 'Reset observations', exact: true }));
  await page.getByText('No event suggestions. You can declare any moment above.', { exact: true }).waitFor();
  check('Reset clears candidates', actions.at(-1).action === 'reset_perception' && eventSystem.prompts().length === 0);
  check('Reset keeps cooldown and idempotency history', (await trigger('ksp-flag', 'ui-flag-02')).status === 429 && (await (await trigger('ksp-flag', 'ui-flag-01')).json()).duplicate === true);

  // Two IDs may share a label: polling must restore focus by ID, never by text.
  const twins = { version: 1, events: [...ksp.events.slice(0, 4), { ...generic.events[1], id: 'twin-a', label: 'Twin' }, { ...generic.events[1], id: 'twin-b', label: 'Twin' }] };
  await page.locator('#event-import summary').click();
  await page.fill('#event-import-text', JSON.stringify(twins));
  await page.click('#event-import-check'); await page.check('#event-import-ack');
  await clickAction(page.locator('#event-import-apply'));
  await page.locator('#event-count').getByText('6 / 12', { exact: true }).waitFor();
  const twinB = page.locator('[data-focus="edit:twin-b"]');
  await twinB.focus();
  await waitForPolls(2);
  check('Polling keeps focus on the second duplicate-label row', await page.evaluate(() => document.activeElement?.dataset?.focus === 'edit:twin-b'));
  await page.keyboard.press('Enter');
  check('Keyboard Edit after polling opens the focused ID', await page.locator('#event-id').inputValue() === 'twin-b');
  await page.click('#event-cancel');
  await page.locator('[data-focus="delete:twin-b"]').focus(); await page.keyboard.press('Enter');
  await waitForPolls(2);
  check('Polling keeps delete confirmation focus on the same ID', await page.evaluate(() => document.activeElement?.dataset?.focus === 'confirm:twin-b'));
  await clickAction(page.locator('[data-focus="confirm:twin-b"]'));
  check('Keyboard delete after polling removes only the focused ID', actions.at(-1).event_id === 'twin-b' && ids().includes('twin-a') && !ids().includes('twin-b'));

  // A failed catalog load offers a retry and leaves the rest of the panel working.
  const second = await context.newPage();
  second.on('pageerror', error => errors.push(error.message));
  let failCatalog = true;
  await second.route(`${origin}/api/operator/action`, route => {
    if (failCatalog && JSON.parse(route.request().postData()).action === 'events_presets') { failCatalog = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"event_presets_unavailable"}' }); }
    return route.continue();
  });
  await second.goto(`${origin}/console`);
  await second.locator('#event-preset-retry').waitFor();
  check('A failed catalog load offers a retry and keeps saved profiles and editing', (await second.locator('#event-preset-failure-text').textContent()).startsWith('Built-in profiles could not load.') &&
    await second.locator('#event-preset-select optgroup[label="Built-in · read-only"]').count() === 0 && await second.locator('#event-preset-select optgroup[label="Saved profiles"] option').count() > 0 &&
    await second.locator('#event-add').isEnabled() && await second.locator('#event-list .event-row').count() === 5);
  await second.click('#event-preset-retry');
  await second.locator('#event-preset-select optgroup[label="Built-in · read-only"]').waitFor({ state: 'attached' });
  check('Retry loads the catalog', await second.locator('#event-preset-failure').isHidden() && await second.locator('#event-preset-current').textContent() === 'In use: Custom events');
  await second.close();

  // Narrow layout.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[data-focus="edit:twin-a"]').click();
  await page.locator('#events-section').scrollIntoViewIfNeeded();
  check('Narrow layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.locator('#events-section').screenshot({ path: path.join(shots, 'events-narrow.png') });
  await page.click('#event-cancel');
  check('No external requests or browser errors occurred', external.length === 0 && errors.length === 0);
  console.log(`Event UI browser passed: ${checks.length} checks; ${actions.length} operator actions over HTTP; screenshots=shots/events-{list,preset-preview,preset-custom,profile-draft,editor,import,suggestions,narrow}.png.`);
} finally {
  await context.close(); await browser.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
