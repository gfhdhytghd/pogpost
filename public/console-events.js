import { $, el } from './common.js';

// Mirrors server/event-definitions.js so the form can explain problems early. The backend stays authoritative.
export const MAX_EVENTS = 12;
export const LIMITS = { label: 100, description: 300 };
export const MAX_PROFILES = 20;
export const PROFILE_LIMITS = { label: 80, description: 300 };
const MAX_IMPORT_BYTES = 64 * 1024;
const FIELDS = ['id', 'label', 'description', 'mode', 'min_confidence', 'cooldown_s', 'auto_confirm'];
const ID_PATTERN = /^[a-z][a-z0-9-]{0,59}$/;
const INVISIBLE = /[\p{Cf}͏᠋-᠏︀-️]/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const length = value => [...String(value)].length;
// Same whitespace rules the server applies before it accepts text.
export const normalize = value => String(value).normalize('NFKC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const modeNames = { persistent: 'Stays visible', instant: 'One matching window' };
const percent = value => `${Math.round(value * 1000) / 10}%`;

export function definitionProblem(definition) {
  if (!object(definition)) return 'Each event must be an object.';
  const unknown = Object.keys(definition).find(key => !FIELDS.includes(key));
  if (unknown) return `Unknown field "${unknown.slice(0, 40)}".`;
  if (typeof definition.id !== 'string' || !ID_PATTERN.test(definition.id)) return 'Use an ID that starts with a lowercase letter, then lowercase letters, numbers or hyphens (60 at most).';
  for (const key of ['label', 'description']) {
    const value = definition[key];
    if (typeof value !== 'string' || !normalize(value)) return `Add a ${key}.`;
    if (INVISIBLE.test(value)) return `Remove invisible formatting characters from the ${key}.`;
    if (normalize(value) !== value) return `Remove extra spaces and line breaks from the ${key}.`;
    if (length(value) > LIMITS[key]) return `Keep the ${key} within ${LIMITS[key]} characters.`;
  }
  if (!Object.hasOwn(modeNames, definition.mode)) return 'Choose a detection mode.';
  const { min_confidence: confidence = 0.85, cooldown_s: cooldown = 30, auto_confirm: auto = false } = definition;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'Set the confidence threshold between 0 and 1.';
  if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 3600) return 'Set a whole-second cooldown from 1 to 3600.';
  if (typeof auto !== 'boolean') return 'API auto-confirm must be on or off.';
  return '';
}

/** Parse a preset file without trusting it; returns {events} or {problem}. */
export function parsePreset(text) {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return { problem: 'This preset is larger than 64 KB.' };
  let payload;
  try { payload = JSON.parse(text); } catch { return { problem: 'This is not valid JSON.' }; }
  if (!object(payload) || Object.keys(payload).length !== 2 || payload.version !== 1 || !Array.isArray(payload.events))
    return { problem: 'Use a preset shaped like {"version":1,"events":[...]}.' };
  if (payload.events.length > MAX_EVENTS) return { problem: `A preset can hold at most ${MAX_EVENTS} events.` };
  const ids = new Set();
  for (const [index, definition] of payload.events.entries()) {
    const problem = definitionProblem(definition);
    if (problem) return { problem: `Event ${index + 1}: ${problem}` };
    if (ids.has(definition.id)) return { problem: `Event ${index + 1}: the ID "${definition.id}" is used twice.` };
    ids.add(definition.id);
  }
  return { events: payload.events };
}

const countEvents = (count, all = false) => count === 1 ? `${all ? 'the ' : ''}1 ${all ? 'current ' : ''}event` : `${all ? 'all ' : ''}${count} ${all ? 'current ' : ''}events`;

const slug = value => normalize(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

const profileName = value => normalize(value).toLowerCase();
const clone = list => list.map(item => ({ ...item }));

export function createEventsPanel({ request, refresh, status, onProfile }) {
  const form = $('#event-form'), fields = Object.fromEntries(FIELDS.map(key => [key, $(`#event-${key.replace(/_/g, '-')}`)]));
  // editTarget says which list the event form changes: the running events, or the local profile draft.
  let events = null, editing = null, editTarget = 'live', confirming = null, pending = false, idTouched = false, preview = null;
  // Built-in profiles come from the catalog, saved ones from operator state; both are keyed "<kind>:<id>".
  // The current profile is the server's active_ref, never a guess from matching content.
  const presetSelect = $('#event-preset-select'), discard = $('#event-preset-discard');
  let manualReveal = false, catalog = null, catalogState = 'idle', catalogError = '', profiles = [], activeRef = null, dirty = false;
  let presetChoice = '', reviewing = false, presetSummaryKey = '';
  // The draft lives only on this page until Save profile; polling never touches it.
  let draft = null;

  function setBusy(value) {
    pending = value;
    $('#events-section').setAttribute('aria-busy', String(value));
    for (const node of document.querySelectorAll('#events-section button, #events-section input, #events-section select, #events-section textarea'))
      node.disabled = value;
    if (!value) syncControls();
  }
  // Resolves to an error message, or '' once the server accepted the action and canonical data reloaded.
  async function run(payload, success, failure) {
    if (pending) return 'Another event change is still saving.';
    setBusy(true);
    try { const result = await request(payload); success?.(result?.result); await refresh(); return ''; }
    catch (error) { status(error.message, true); failure?.(error); return error.message; }
    finally { setBusy(false); }
  }

  function counter(key, input = fields[key], limit = LIMITS[key], node = $(`#event-${key}-count`)) {
    const used = length(input.value);
    node.textContent = `${used}/${limit}`; node.classList.toggle('over', used > limit);
  }
  function formError(message) { const node = $('#event-form-error'); node.textContent = message; node.hidden = !message; }
  const editorOpen = () => !$('#event-editor').hidden;
  const liveEditorOpen = () => editorOpen() && editTarget === 'live';
  function openEditor(definition = null, target = 'live') {
    editing = definition?.id ?? null; editTarget = target; idTouched = !!definition; confirming = null;
    const inDraft = target === 'draft';
    $('#event-editor-title').textContent = definition ? `Edit ${definition.label}${inDraft ? ' in the draft' : ''}` : inDraft ? 'New event in the draft' : 'New event';
    $('#event-save').textContent = inDraft ? definition ? 'Update draft event' : 'Add to draft' : definition ? 'Save changes' : 'Add event';
    const values = definition || { id: '', label: '', description: '', mode: 'persistent', min_confidence: 0.85, cooldown_s: 30, auto_confirm: false };
    for (const key of FIELDS) fields[key].type === 'checkbox' ? fields[key].checked = values[key] : fields[key].value = String(values[key]);
    fields.id.readOnly = !!definition;
    $('#event-id-help').textContent = definition ? 'IDs stay fixed. To rename, add a new event and delete this one.' : 'Lowercase letters, numbers and hyphens. Notes target this ID, so it stays fixed once saved.';
    counter('label'); counter('description'); formError('');
    $('#event-editor').hidden = false; renderDraft(); render();
    fields.label.focus();
  }
  function closeEditor(focus = true) {
    const target = editTarget;
    editing = null; editTarget = 'live'; $('#event-editor').hidden = true; formError(''); renderDraft(); render();
    if (focus) (target === 'draft' && draft ? $('#profile-event-add') : $('#event-add')).focus();
  }
  function readForm() {
    return { id: fields.id.value.trim(), label: normalize(fields.label.value), description: normalize(fields.description.value), mode: fields.mode.value,
      min_confidence: fields.min_confidence.value === '' ? NaN : Number(fields.min_confidence.value),
      cooldown_s: fields.cooldown_s.value === '' ? NaN : Number(fields.cooldown_s.value), auto_confirm: fields.auto_confirm.checked };
  }

  fields.label.oninput = () => { counter('label'); if (!idTouched) fields.id.value = slug(fields.label.value); };
  fields.id.oninput = () => { idTouched = true; };
  fields.description.oninput = () => counter('description');
  $('#event-cancel').onclick = () => closeEditor();
  $('#event-add').onclick = () => openEditor();
  form.onsubmit = async event => {
    event.preventDefault();
    const definition = readForm(), problem = definitionProblem(definition), list = editTarget === 'draft' ? draft?.events : events;
    if (!editing && list?.some(item => item.id === definition.id)) return formError(`The ID "${definition.id}" is already in use.`);
    if (problem) return formError(problem);
    formError('');
    if (editTarget === 'draft') {
      // Draft events change only on this page; nothing reaches recognition until a saved profile is applied.
      if (!draft) return closeEditor();
      const index = draft.events.findIndex(item => item.id === editing);
      if (index >= 0) draft.events[index] = definition; else draft.events.push(definition);
      draft.touched = true; closeEditor(); return;
    }
    // Edits stay in the form until the server accepts them.
    const failure = await run({ action: 'events_upsert', event: definition }, result => status(`Saved ${result?.event?.label || definition.label}.`));
    if (failure) formError(failure); else closeEditor();
  };

  const importText = $('#event-import-text');
  $('#event-import-file').onchange = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return showPreview({ problem: 'This preset is larger than 64 KB.' });
    importText.value = await file.text(); checkImport(); renderPreset();
  };
  importText.oninput = () => { preview = null; $('#event-import-preview').hidden = true; renderPreset(); syncControls(); };
  function showPreview(result) {
    preview = result.events ? result : null;
    const root = $('#event-import-preview'); root.replaceChildren(); root.hidden = false;
    root.classList.toggle('error', !!result.problem);
    if (result.problem) root.append(el('p', '', result.problem));
    else {
      const current = events?.length ?? 0;
      root.append(el('p', '', `Replaces ${current === 1 ? 'the 1 current event' : `all ${current} current events`} with ${result.events.length === 1 ? '1 event' : `${result.events.length} events`}.`));
      if (result.events.length) { const list = el('ul', 'event-import-list'); for (const item of result.events) list.append(el('li', '', `${item.label} · ${item.id}`)); root.append(list); }
    }
    $('#event-import-ack').checked = false; syncControls();
  }
  function checkImport() { showPreview(parsePreset(importText.value)); }
  $('#event-import-check').onclick = checkImport;
  $('#event-import-ack').onchange = syncControls;
  $('#event-import-apply').onclick = () => preview && $('#event-import-ack').checked && run({ action: 'events_import', events: preview.events }, result => {
    status(`Imported ${result?.events?.length ?? preview.events.length} events. Earlier notes and moments are unchanged.`);
    importText.value = ''; preview = null; $('#event-import-preview').hidden = true; $('#event-import').open = false;
  });

  // ——— Profiles: choose, preview, apply ———
  async function loadCatalog() {
    if (catalogState === 'loading') return;
    catalogState = 'loading'; renderPreset(); syncControls();
    try {
      const presets = (await request({ action: 'events_presets' }))?.result?.presets;
      if (!Array.isArray(presets)) throw new Error('The preset list was not readable.');
      catalog = presets.filter(item => object(item) && typeof item.id === 'string' && typeof item.label === 'string' && Array.isArray(item.events));
      catalogState = 'ready';
    } catch (error) { catalogState = 'failed'; catalogError = error.message; }
    renderPreset(); syncControls();
  }
  const keyOf = (kind, id) => `${kind}:${id}`;
  function lookup(key) {
    const split = key.indexOf(':'), kind = key.slice(0, split), id = key.slice(split + 1);
    const item = kind === 'builtin' ? catalog?.find(entry => entry.id === id) : kind === 'profile' ? profiles.find(entry => entry.id === id) : null;
    return item ? { key, kind, id, label: item.label, description: item.description || '', events: item.events, revision: kind === 'profile' ? item.revision : 1 } : null;
  }
  const activeKey = () => activeRef ? keyOf(activeRef.kind, activeRef.id) : '';
  // The name applied with the snapshot; a later rename shows in the list and as a newer version to apply.
  const activeName = () => activeRef ? activeRef.label || lookup(activeKey())?.label || activeRef.id : 'Custom events';
  const newerSaved = () => activeRef?.kind === 'profile' && (lookup(activeKey())?.revision ?? 0) > (activeRef.revision ?? 0);
  const needsReview = () => !!activeRef && (dirty || newerSaved());
  const shownKey = () => presetChoice || activeKey();
  function presetError(message) { const node = $('#event-preset-error'); node.textContent = message; node.hidden = !message; }

  function renderPreset() {
    const current = activeKey();
    if (presetChoice && (!lookup(presetChoice) || (presetChoice === current && !(reviewing && needsReview())))) { presetChoice = ''; reviewing = false; }
    const builtins = (catalog || []).map(item => [keyOf('builtin', item.id), item.label]), saved = profiles.map(item => [keyOf('profile', item.id), item.label]);
    // The active entry may be missing from the lists (no link, or the catalog failed); show it as a fixed option.
    const loose = [...builtins, ...saved].some(([value]) => value === (current || 'custom')) ? [] : [[current || 'custom', activeName()]];
    const signature = JSON.stringify([builtins, saved, loose]);
    if (presetSelect.dataset.options !== signature) {
      const option = ([value, label], disabled = false) => { const node = el('option', '', label); node.value = value; node.disabled = disabled; return node; };
      const group = (label, items) => { const node = document.createElement('optgroup'); node.label = label; node.append(...items.map(item => option(item))); return node; };
      presetSelect.replaceChildren(...loose.map(item => option(item, true)), ...(builtins.length ? [group('Built-in · read-only', builtins)] : []), ...(saved.length ? [group('Saved profiles', saved)] : []));
      presetSelect.dataset.options = signature;
    }
    presetSelect.value = presetChoice || current || 'custom';

    const name = activeName();
    $('#event-preset-current').textContent = events ? `In use: ${name}${activeRef && dirty ? ' · modified' : ''}` : 'Checking which profile is in use…';
    onProfile?.(events ? { name, modified: !!activeRef && dirty } : null);
    $('#event-preset-note').textContent = !events ? 'Choose a profile to preview its events. Nothing changes until you apply it.'
      : newerSaved() ? `A newer saved version of ${name} exists. Apply it to start using it.`
      : activeRef && dirty ? `The running events differ from ${name}. Save them to a profile to keep them, or apply ${name} again to restore it.`
      : activeRef ? lookup(current)?.description || '' : 'These events are not linked to a profile. Save them as a profile, or choose one to preview.';
    $('#event-preset-failure').hidden = catalogState !== 'failed';
    $('#event-preset-failure-text').textContent = `Built-in profiles could not load. ${catalogError} Saved profiles, your events and JSON import still work.`;
    $('#event-preset-review').hidden = !needsReview() || !!presetChoice || !lookup(current);
    $('#event-preset-review').textContent = newerSaved() ? 'Review newer version' : `Review saved ${name}`;

    // Profile actions follow the entry the selector shows.
    const shown = lookup(shownKey()), active = lookup(current);
    $('#profile-edit').hidden = shown?.kind !== 'profile';
    $('#profile-edit').textContent = shown?.kind === 'profile' ? `Edit ${shown.label}` : 'Edit profile';
    $('#profile-duplicate').hidden = !shown;
    $('#profile-update').hidden = !(active?.kind === 'profile' && dirty);
    $('#profile-update').textContent = active?.kind === 'profile' ? `Save running events to ${active.label}` : 'Save running events';

    const chosen = lookup(presetChoice), live = liveEditorOpen(), pasted = !!importText.value.trim();
    $('#event-preset').classList.toggle('previewing', !!chosen);
    $('#event-preset-preview').hidden = !chosen;
    $('#event-preset-discard-row').hidden = !(chosen && live);
    if (!chosen || !live) discard.checked = false;
    if (!chosen) { presetSummaryKey = ''; presetError(''); return; }
    // Rebuild only when the preview's facts change, so polling does not re-announce it.
    const key = JSON.stringify([chosen.key, chosen.revision, chosen.events, events?.length, dirty, live && $('#event-editor-title').textContent, pasted, !!draft]);
    if (key === presetSummaryKey) return;
    presetSummaryKey = key;
    const root = $('#event-preset-summary'), list = el('ul', 'event-import-list');
    for (const item of chosen.events) list.append(el('li', '', `${item.label} · ${item.id}`));
    root.replaceChildren(el('h3', '', chosen.key === current ? `Apply the saved ${chosen.label} again?` : `Switch to ${chosen.label}?`));
    root.append(el('p', 'small muted', chosen.kind === 'builtin' ? `Built-in profile${chosen.description ? `. ${chosen.description}` : ''}` : `Saved profile, version ${chosen.revision}${chosen.description ? `. ${chosen.description}` : ''}`));
    const switching = chosen.key !== current || chosen.revision !== activeRef?.revision;
    root.append(el('p', '', `Replaces ${countEvents(events?.length ?? 0, true)} with ${countEvents(chosen.events.length)}:`), list,
      el('p', 'event-preset-impact', switching ? 'Pending suggestions and picture evidence clear. Cooldowns, notes, moments and history stay.'
        : 'Changed or removed events lose their pending suggestions and picture evidence. Cooldowns, notes, moments and history stay.'));
    if (activeRef && dirty) root.append(el('p', 'event-preset-warning', `The running events have changes that are not in any saved profile. Applying replaces them. To keep them, save them as a profile first.`));
    if (live) root.append(el('p', 'event-preset-warning', `The open editor (${$('#event-editor-title').textContent}) has unsaved changes. Applying closes it and discards them.`));
    if (draft) root.append(el('p', 'small muted', 'Your profile draft stays open and is not changed.'));
    if (pasted) root.append(el('p', 'small muted', 'Your pasted JSON in Import a preset stays there and is not applied.'));
  }
  presetSelect.onchange = () => { presetChoice = presetSelect.value === 'custom' ? '' : presetSelect.value; reviewing = false; presetError(''); renderPreset(); syncControls(); };
  $('#event-preset-review').onclick = () => { presetChoice = activeKey(); reviewing = true; renderPreset(); syncControls(); $('#event-preset-apply').focus(); };
  $('#event-preset-cancel').onclick = () => { presetChoice = ''; reviewing = false; renderPreset(); syncControls(); presetSelect.focus(); };
  $('#event-preset-retry').onclick = loadCatalog;
  discard.onchange = syncControls;
  $('#event-preset-apply').onclick = async () => {
    const chosen = lookup(presetChoice), live = liveEditorOpen();
    if (!chosen || (live && !discard.checked)) return;
    presetError('');
    const payload = { action: 'events_profile_activate', profile_kind: chosen.kind, profile_id: chosen.id };
    if (chosen.kind === 'profile') payload.expected_revision = chosen.revision;
    let code = '';
    const failure = await run(payload, result => {
      status(`Now using ${chosen.label}: ${countEvents(result?.events?.length ?? chosen.events.length)}. Notes, moments and history are unchanged.`);
      presetChoice = ''; reviewing = false; preview = null; $('#event-import-preview').hidden = true;
      if (live) closeEditor(false);
    }, error => {
      code = error.data?.error;
      // A newer saved version replaces the preview content on the next refresh; nothing applies silently.
      if (code === 'profile_revision_conflict' || code === 'profile_not_found') refresh();
    });
    // A failure keeps the preview, the choice and any open editor for another try.
    if (failure) presetError(code === 'profile_revision_conflict' ? 'This profile was saved again since you opened the preview. Review the latest version and apply again.' : profileMessages[code] || failure);
    else presetSelect.focus();
  };

  // ——— Profiles: local draft ———
  const draftLabel = $('#profile-label'), draftDescription = $('#profile-description');
  function openDraft({ id = null, revision = null, title, label = '', description = '', events: list = [], start = null, note }) {
    draft = { id, revision, title, events: clone(list), start, touched: false, initial: { label, description } };
    draftLabel.value = label; draftDescription.value = description;
    $('#profile-editor-title').textContent = title;
    $('#profile-editor-note').textContent = note || 'This draft stays on this page. Recognition keeps the running events until you apply a saved profile.';
    $('#profile-start').hidden = !start;
    if (start) $(`#profile-start-${start}`).checked = true;
    profileError(''); $('#profile-conflict').hidden = true; $('#profile-discard').hidden = true;
    $('#profile-editor').hidden = false;
    renderDraft(); renderPreset(); syncControls();
    draftLabel.focus();
  }
  function closeDraft() {
    if (editorOpen() && editTarget === 'draft') closeEditor(false);
    draft = null; $('#profile-editor').hidden = true;
    renderPreset(); syncControls();
  }
  function profileError(message) { const node = $('#profile-error'); node.textContent = message; node.hidden = !message; }
  const draftChanged = () => !!draft && (draft.touched || (editorOpen() && editTarget === 'draft') || draftLabel.value !== draft.initial.label || draftDescription.value !== draft.initial.description);

  $('#profile-new').onclick = () => openDraft({ title: 'New profile', events: events || [], start: 'current' });
  $('#profile-duplicate').onclick = () => {
    const source = lookup(shownKey()); if (!source) return;
    openDraft({ title: `New profile from ${source.label}`, label: [...`${source.label} copy`].slice(0, PROFILE_LIMITS.label).join(''), description: source.description, events: source.events,
      note: `Starts from ${source.label}${source.kind === 'builtin' ? ', which stays read-only' : ''}. Save it under a new name.` });
  };
  $('#profile-edit').onclick = () => {
    const source = lookup(shownKey()); if (source?.kind !== 'profile') return;
    openDraft({ id: source.id, revision: source.revision, title: `Edit ${source.label}`, label: source.label, description: source.description, events: source.events,
      note: `Saving creates version ${source.revision + 1}. Recognition keeps the running events until you apply it.` });
  };
  $('#profile-update').onclick = () => {
    const source = lookup(activeKey()); if (source?.kind !== 'profile' || !events) return;
    openDraft({ id: source.id, revision: source.revision, title: `Save running events to ${source.label}`, label: source.label, description: source.description, events,
      note: `This draft holds the running events. Save profile replaces version ${source.revision} of ${source.label}.` });
    draft.touched = true;
  };
  for (const start of ['current', 'blank']) $(`#profile-start-${start}`).onchange = () => {
    if (!draft || draft.touched) return;
    draft.start = start; draft.events = start === 'current' ? clone(events || []) : []; renderDraft(); syncControls();
  };
  draftLabel.oninput = () => { profileError(''); counter('label', draftLabel, PROFILE_LIMITS.label, $('#profile-label-count')); };
  draftDescription.oninput = () => counter('description', draftDescription, PROFILE_LIMITS.description, $('#profile-description-count'));
  $('#profile-event-add').onclick = () => openEditor(null, 'draft');
  $('#profile-cancel').onclick = () => {
    if (!draftChanged()) return closeDraft();
    $('#profile-discard').hidden = false; $('#profile-discard-confirm').focus();
  };
  $('#profile-discard-keep').onclick = () => { $('#profile-discard').hidden = true; $('#profile-cancel').focus(); };
  $('#profile-discard-confirm').onclick = () => { closeDraft(); status('Discarded the profile draft. Nothing was saved.'); $('#profile-new').focus(); };
  $('#profile-save-new').onclick = () => {
    if (!draft) return;
    draft.id = null; draft.revision = null; draft.title = 'New profile';
    $('#profile-editor-title').textContent = draft.title; $('#profile-conflict').hidden = true;
    $('#profile-editor-note').textContent = 'This draft will be saved as a new profile. Give it a name that is not in use.';
    profileError(''); draftLabel.focus(); syncControls();
  };
  $('#profile-reload').onclick = () => {
    const latest = draft && profiles.find(item => item.id === draft.id);
    if (!latest) return profileError('The saved profile is no longer available. Save the draft as a new profile.');
    openDraft({ id: latest.id, revision: latest.revision, title: `Edit ${latest.label}`, label: latest.label, description: latest.description || '', events: latest.events,
      note: `Loaded version ${latest.revision}. Saving creates version ${latest.revision + 1}.` });
  };

  function draftProblem(label, description) {
    if (!label) return 'Add a profile name.';
    if (INVISIBLE.test(draftLabel.value) || INVISIBLE.test(draftDescription.value)) return 'Remove invisible formatting characters from the name or description.';
    if (length(label) > PROFILE_LIMITS.label) return `Keep the profile name within ${PROFILE_LIMITS.label} characters.`;
    if (length(description) > PROFILE_LIMITS.description) return `Keep the description within ${PROFILE_LIMITS.description} characters.`;
    if (profiles.some(item => item.id !== draft.id && profileName(item.label) === profileName(label))) return `A saved profile is already named ${label}. Choose another name.`;
    if (!draft.id && profiles.length >= MAX_PROFILES) return `${MAX_PROFILES} saved profiles is the limit. Edit an existing profile instead.`;
    return '';
  }
  const profileMessages = {
    profile_revision_conflict: 'This profile was saved somewhere else since you opened it. Your draft is kept and was not saved.',
    profile_name_in_use: 'A saved profile already uses this name. Choose another name.',
    profile_limit: `${MAX_PROFILES} saved profiles is the limit. Edit an existing profile instead.`,
    profile_not_found: 'This saved profile no longer exists. Save the draft as a new profile.',
    profile_read_only: 'Built-in profiles are read-only. Save the draft as a new profile.',
  };
  $('#profile-save').onclick = async () => {
    if (!draft) return;
    const label = normalize(draftLabel.value), description = normalize(draftDescription.value), problem = draftProblem(label, description);
    if (problem) return profileError(problem);
    profileError(''); $('#profile-conflict').hidden = true;
    const profile = { label, events: draft.events };
    if (description) profile.description = description;
    if (draft.id) { profile.id = draft.id; profile.expected_revision = draft.revision; }
    const failure = await run({ action: 'events_profile_save', profile }, result => {
      status(`Saved ${result?.profile?.label || label}. Apply it to start using it.`);
      closeDraft();
    }, error => {
      const code = error.data?.error;
      profileError(profileMessages[code] || error.message);
      $('#profile-conflict').hidden = code !== 'profile_revision_conflict';
      // Fetch the latest saved versions; the draft and its expected revision stay as they are.
      if (code === 'profile_revision_conflict' || code === 'profile_not_found') refresh();
    });
    if (!failure) $('#profile-new').focus();
  };

  function renderDraft() {
    if (!draft) return;
    $('#profile-event-count').textContent = `${draft.events.length} / ${MAX_EVENTS}`;
    counter('label', draftLabel, PROFILE_LIMITS.label, $('#profile-label-count'));
    counter('description', draftDescription, PROFILE_LIMITS.description, $('#profile-description-count'));
    const root = $('#profile-event-list'), focused = document.activeElement?.closest?.('#profile-event-list') ? document.activeElement.dataset.focus : null;
    root.replaceChildren(...draft.events.map(definition => row(definition, 'draft')));
    if (!draft.events.length) root.append(el('li', 'empty', 'No events in this draft yet. Add one below.'));
    if (focused) [...root.querySelectorAll('button')].find(node => node.dataset.focus === focused)?.focus();
  }

  function syncControls() {
    if (pending) return;
    const full = (events?.length ?? 0) >= MAX_EVENTS, profilesFull = profiles.length >= MAX_PROFILES;
    presetSelect.disabled = !events;
    $('#event-preset-retry').disabled = catalogState === 'loading';
    $('#event-preset-apply').disabled = !lookup(presetChoice) || (liveEditorOpen() && !discard.checked);
    $('#profile-new').disabled = !events || profilesFull || !!draft;
    $('#profile-duplicate').disabled = profilesFull || !!draft;
    $('#profile-edit').disabled = $('#profile-update').disabled = !!draft;
    $('#profile-limit-note').hidden = !profilesFull;
    // One event form serves both lists: while it is open, other entry points wait so no input is overwritten.
    const formOpen = editorOpen(), draftForm = formOpen && editTarget === 'draft';
    for (const node of document.querySelectorAll('#event-list button, #profile-event-list button')) node.disabled = formOpen;
    $('#profile-save-hint').hidden = !draftForm;
    if (draft) {
      $('#profile-event-add').disabled = formOpen || draft.events.length >= MAX_EVENTS;
      $('#profile-save').disabled = draftForm;
      for (const start of ['current', 'blank']) $(`#profile-start-${start}`).disabled = draft.touched;
      $('#profile-start-note').hidden = !draft.touched;
    }
    $('#event-add').disabled = !events || full || formOpen;
    $('#event-limit-note').hidden = !full;
    $('#event-import-check').disabled = !importText.value.trim();
    $('#event-import-ack').disabled = !preview;
    $('#event-import-apply').disabled = !preview || !$('#event-import-ack').checked;
  }

  function row(definition, target = 'live') {
    const inDraft = target === 'draft', prefix = inDraft ? 'draft-' : '';
    const item = el('li', 'event-row'), body = el('div', 'event-row-body'), heading = el('div', 'event-row-heading');
    heading.append(el('strong', '', definition.label), el('code', 'event-id', definition.id));
    const facts = el('p', 'event-facts', `${modeNames[definition.mode] || definition.mode} · ${percent(definition.min_confidence)} confidence threshold · ${definition.cooldown_s} s cooldown`);
    body.append(heading, facts, el('p', 'event-description', definition.description));
    // In manual presentation a confirmed moment only readies envelopes; you open each one.
    const autoLabel = manualReveal ? 'API confirms the moment' : 'API opens notes';
    const badge = el('span', `pill${definition.auto_confirm ? ' gold' : ''}`, definition.auto_confirm ? autoLabel : 'API waits for you');
    badge.title = definition.auto_confirm ? (manualReveal ? 'Authenticated API triggers confirm the moment without you, and its envelopes get ready. You still open each one. Picture suggestions still need you.' : 'Authenticated API triggers occur without confirmation. Picture suggestions still need you.') : 'API triggers become suggestions you confirm.';
    const actions = el('div', 'row event-row-actions');
    if (!inDraft && confirming === definition.id) {
      item.classList.add('confirming');
      const warning = el('p', 'event-delete-warning', `Stop recognizing ${definition.label}? Its moment, sealed notes and history stay.`);
      warning.id = `event-delete-${definition.id}`;
      const remove = el('button', 'small danger', 'Delete event'), keep = el('button', 'small secondary', 'Keep');
      remove.setAttribute('aria-describedby', warning.id);
      remove.onclick = () => run({ action: 'events_delete', event_id: definition.id }, () => { confirming = null; status(`Deleted ${definition.label}. Notes and history are unchanged.`); });
      keep.onclick = () => { confirming = null; render(); focusControl(`delete:${definition.id}`); };
      remove.dataset.focus = `confirm:${definition.id}`; keep.dataset.focus = `keep:${definition.id}`;
      body.append(warning); actions.append(remove, keep);
    } else {
      const edit = el('button', 'small secondary', 'Edit'), remove = el('button', 'small secondary', inDraft ? 'Remove' : 'Delete');
      edit.setAttribute('aria-label', `Edit ${definition.label}${inDraft ? ' in the draft' : ''}`); remove.setAttribute('aria-label', `${inDraft ? 'Remove' : 'Delete'} ${definition.label}${inDraft ? ' from the draft' : ''}`);
      edit.dataset.focus = `${prefix}edit:${definition.id}`; remove.dataset.focus = `${prefix}delete:${definition.id}`;
      edit.onclick = () => openEditor(definition, target);
      // Removing from a draft is local and undone by Cancel, so it needs no second step.
      remove.onclick = inDraft ? () => { draft.events = draft.events.filter(entry => entry.id !== definition.id); draft.touched = true;
        if (editing === definition.id && editTarget === 'draft') closeEditor(false); renderDraft(); syncControls(); $('#profile-event-add').focus(); }
        : () => { confirming = definition.id; render(); focusControl(`confirm:${definition.id}`); };
      actions.append(edit, remove);
    }
    item.append(body, el('div', 'event-row-side'));
    item.lastChild.append(badge, actions);
    if (editing === definition.id && editTarget === target && editorOpen()) item.classList.add('editing');
    return item;
  }

  function render(state) {
    if (state) {
      events = Array.isArray(state.config?.events) ? state.config.events : [];
      manualReveal = state.config?.reveal?.mode === 'manual';
      $('#event-auto-label').textContent = manualReveal ? 'Let API triggers confirm the moment without you' : 'Let API triggers open notes without confirmation';
      const pack = object(state.event_profiles) ? state.event_profiles : {};
      profiles = Array.isArray(pack.profiles) ? pack.profiles.filter(item => object(item) && typeof item.id === 'string' && Array.isArray(item.events)) : [];
      activeRef = object(pack.active_ref) && typeof pack.active_ref.id === 'string' ? pack.active_ref : null;
      dirty = pack.dirty === true;
    }
    // The operator cookie exists only after bootstrap, so the catalog loads on the first state.
    if (state && catalogState === 'idle') loadCatalog();
    renderPreset();
    $('#event-count').textContent = events ? `${events.length} / ${MAX_EVENTS}` : `– / ${MAX_EVENTS}`;
    const root = $('#event-list');
    if (!events) return;
    const focused = document.activeElement?.closest?.('#event-list') ? document.activeElement.dataset.focus : null;
    if (confirming && !events.some(item => item.id === confirming)) confirming = null;
    root.replaceChildren(...events.map(definition => row(definition)));
    if (!events.length) root.append(el('li', 'empty', 'No events defined. Add one, or import a preset.'));
    // Polling re-renders the list; restore focus by event ID and control, since labels can repeat.
    if (focused) focusControl(focused);
    if (pending) setBusy(true); else syncControls();
  }
  function focusControl(key) { [...$('#event-list').querySelectorAll('button')].find(node => node.dataset.focus === key)?.focus(); }
  function failed(message) {
    if (events) return;
    const root = $('#event-list'); root.replaceChildren(el('li', 'empty error', `Event definitions could not load. ${message}`));
  }
  syncControls();
  return { render, failed };
}
