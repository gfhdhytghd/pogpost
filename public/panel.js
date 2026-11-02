import { $, el, api, post, status, shareIdentity, momentLabel, categoryColor, iconFor, watchPrivateEvents } from './common.js';
import { groupMomentChoices } from './moment-choices.js';

let state, categoryId, sealing = false, requestId, compiling = false;
// The viewer's explicit targets. They survive profile switches; a target that is no longer offered is never silently replaced.
let momentChoice = null, afterChoice = '';
const form = $('#compose-form'), body = $('#note-body');
const UNAVAILABLE = 'Choose a moment from the list. Condition matching is not available in this channel.';
const stampLabels = { sealed:'Sealed', held:'In review', pending_review:'In review', rejected:'Rejected', revealed:'Opened', expired:'Expired' };

// Any edit makes a new request; an unchanged retry reuses the same request id.
form.addEventListener('change', () => { requestId = undefined; });

/* Tabs: click, or arrow keys between them. */
const tabs = [$('#compose-tab'), $('#notes-tab'), $('#watch-tab')], views = ['#compose-view', '#notes-view', '#watch-view'];
let watching = false, watchFrame = null, refreshTimer = 0;
function activateTab(index, focus = false) {
  views.forEach((view, i) => { $(view).hidden = i !== index; });
  tabs.forEach((tab, i) => { const selected = i === index; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
  if (focus) tabs[index].focus();
  setWatching(index === 2);
}
tabs.forEach((tab, index) => {
  tab.onclick = () => activateTab(index);
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    activateTab(next, true);
  });
});

/* Watch: the viewer overlay in a read-only srcdoc frame. Twitch's CDN will not let the extension
   frame its own pages by URL, so the document is this fixed template; relative URLs resolve
   against this panel. No user text enters it. The frame makes no requests, runs no helper and
   holds no token; this page posts it only the public presentation snapshot it already loads. */
const WATCH_DOC = '<!doctype html><html lang="en" class="transparent-root"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Envelopes on stream</title><link rel="stylesheet" href="./overlay.css"><script type="module" src="./video_overlay.js"></script></head><body class="overlay-page" data-embedded="true"></body></html>';
function setWatching(on) {
  watching = on;
  if (on && !watchFrame) {
    watchFrame = el('iframe'); watchFrame.title = 'Envelopes on stream'; watchFrame.srcdoc = WATCH_DOC;
    $('#watch-stage').append(watchFrame);
  }
  clearInterval(refreshTimer); refreshTimer = setInterval(refresh, on ? 1000 : 7000);
  if (on) refresh();
}
function sendPresentation() {
  if (!watchFrame?.contentWindow || !state) return;
  const presentation = state.presentation || { sealedCount: state.sealedCount };
  watchFrame.contentWindow.postMessage({ type: 'sealed-presentation', presentation }, location.origin);
}
addEventListener('message', event => {
  if (event.origin === location.origin && watchFrame && event.source === watchFrame.contentWindow && event.data?.type === 'sealed-presentation-ready') sendPresentation();
});

$('#share-name').onclick = shareIdentity;
$('#show-name').onchange = event => { if (event.target.checked) shareIdentity(); };
function conditionFields() {
  const type = $('#condition-type').value;
  for (const [id, match] of [['condition-count','count'], ['condition-window','window'], ['condition-after','after']]) { const input = $(`#${id}`); input.disabled = type !== match; input.required = type === match; }
}
$('#condition-type').onchange = conditionFields; conditionFields();
function counter() { const length = body.value.length; $('#char-counter').textContent = `${length} / 140`; $('#char-counter').classList.toggle('near', length >= 120); }
body.oninput = () => { counter(); requestId = undefined; };

function renderCategories(config, categories) {
  const root = $('#categories'), focused = document.activeElement?.closest?.('#categories') ? document.activeElement.dataset.category : null;
  root.replaceChildren();
  if (config.category_mode === 'ai') { categoryId = categories[0]?.id; root.append(el('p','hint','AI will choose the envelope that fits your note.')); return; }
  for (const category of categories) {
    if (!categoryId) categoryId = category.id;
    const button = el('button','category-button'); button.type = 'button'; button.dataset.category = category.id;
    button.style.setProperty('--category', categoryColor(category));
    button.setAttribute('aria-pressed', String(category.id === categoryId));
    const label = el('span','',category.name); label.append(el('small','category-option-description',category.subtitle || ''));
    button.append(el('span','category-icon',iconFor(category)), label);
    button.onclick = () => { categoryId = category.id; requestId = undefined; render(); };
    root.append(button);
  }
  if (focused) root.querySelector(`[data-category="${CSS.escape(focused)}"]`)?.focus();
}
const momentGroups = view => view.moment_groups && Array.isArray(view.moment_groups.current_profile) && Array.isArray(view.moment_groups.stream_general)
  ? view.moment_groups : groupMomentChoices(view.moments || view.config?.moments || [], view.config?.events || []);
const offered = groups => [...groups.current_profile, ...groups.stream_general];
function fillMoments(select, groups, leading, chosen) {
  const option = (value, label) => { const node = el('option','',label); node.value = value; return node; };
  const group = (label, moments) => { const node = document.createElement('optgroup'); node.label = label;
    node.append(...moments.map(moment => option(moment.id, moment.label + (moment.long_lived ? ' · carries across streams' : '')))); return node; };
  const stale = chosen && !offered(groups).some(moment => moment.id === chosen);
  const placeholder = stale ? option('', 'Choose a moment again') : null; if (placeholder) { placeholder.disabled = true; placeholder.dataset.stale = 'true'; }
  select.replaceChildren(...(placeholder ? [placeholder] : []), ...leading,
    ...(groups.current_profile.length ? [group('Current profile', groups.current_profile)] : []),
    ...(groups.stream_general.length ? [group('Stream general', groups.stream_general)] : []));
  if (stale) placeholder.selected = true; else if (chosen) select.value = chosen;
  return stale;
}
function renderMoments(groups) {
  if (momentChoice === null && offered(groups).length) momentChoice = offered(groups)[0].id;
  const anyMoment = el('option','','Any moment'); anyMoment.value = '';
  const lostMoment = fillMoments($('#moment'), groups, [], momentChoice);
  const lostAfter = fillMoments($('#condition-after'), groups, [anyMoment], afterChoice);
  if (!offered(groups).length && !lostMoment) { const none = el('option','','No moments are open right now'); none.value = ''; none.disabled = true; none.selected = true; $('#moment').prepend(none); }
  const hint = $('#moment-hint');
  hint.hidden = !lostMoment && !lostAfter;
  hint.textContent = lostMoment ? 'The stream changed its moments. Choose a moment again; your words are kept.'
    : lostAfter ? 'The earlier moment in your condition is no longer offered. Choose it again.' : '';
}
$('#moment').addEventListener('change', event => { momentChoice = event.target.value; renderMoments(momentGroups(state)); });
$('#condition-after').addEventListener('change', event => { afterChoice = event.target.value; renderMoments(momentGroups(state)); });
function renderPayment(config, categories) {
  const payment = config.payments || {}, previous = $('#payment').value, select = $('#payment'); select.replaceChildren();
  const add = (value, label) => { const option = el('option','',`${label} · TEST MODE — no real charge`); option.value = value; select.append(option); };
  if (payment.free_enabled) add('free', `Free note (${state.free_remaining ?? payment.free_notes ?? 1} left)`);
  const category = categories.find(item => item.id === categoryId);
  if (payment.points_enabled) add('sim_points', `${category?.points_price ?? category?.price ?? payment.points_price ?? 200} test points`);
  if (payment.bits_enabled) add('sim_bits', `${payment.bits_tier ?? 100} test Bits · gold seal`);
  if ([...select.options].some(item => item.value === previous)) select.value = previous;
  if (state.free_remaining === 0) { const free = [...select.options].find(item => item.value === 'free'); if (free) free.disabled = true; if (select.value === 'free') select.value = payment.points_enabled ? 'sim_points' : 'sim_bits'; }
  $('#wallet').textContent = `${state.wallet?.points ?? 0} test points available · ${state.wallet?.bits ?? 0} test Bits`;
}
function renderNotes(moments, categories) {
  const notes = state.notes || []; $('#own-count').textContent = notes.length;
  const list = $('#own-notes'); list.replaceChildren();
  if (!notes.length) { list.append(el('li','empty','Your future moments start here. Write your first note.')); return; }
  for (const note of [...notes].reverse()) {
    const item = el('li','note-item'), category = categories.find(entry => entry.id === note.category_id);
    if (category) item.style.setProperty('--category', categoryColor(category));
    const detail = el('div'), opened = note.status === 'revealed';
    detail.append(el('strong','',note.moment_label || momentLabel(note.moment_id, moments)),
      el('p','',`#${String(note.id).slice(0,8)} · ${opened ? 'Opened on stream' : note.status === 'rejected' ? 'Not sealed. No charge.' : 'Words hidden until it opens'}`));
    const stamp = el('span','stamp',stampLabels[note.status] || String(note.status).replace(/_/g,' ')); stamp.dataset.status = note.status;
    item.append(detail, stamp);
    // The server only includes the words once the note has been opened on stream.
    if (opened && typeof note.body === 'string' && note.body) item.append(el('p','note-opened',note.body));
    list.append(item);
  }
}
function render() {
  const config = state.config, categories = config.categories || [], moments = state.moments || config.moments || [];
  $('#sealed-count').textContent = `${state.sealedCount || 0} sealed`;
  const compilerAvailable = state.features?.conditionCompiler === true;
  $('#condition-description').disabled = !compilerAvailable;
  $('#compile-condition').disabled = !compilerAvailable || compiling;
  if (!compilerAvailable && !compiling) status(UNAVAILABLE, false, '#compile-status');
  if (compilerAvailable && $('#compile-status').textContent === UNAVAILABLE) status('Describe a moment. Review the match before sealing your note.', false, '#compile-status');
  renderCategories(config, categories); renderMoments(momentGroups(state)); renderPayment(config, categories); renderNotes(moments, categories);
}
async function refresh() {
  try { state = await api('/ebs/state'); render(); sendPresentation(); if ($('#status').textContent === 'Connecting to your channel…') status('Your words stay hidden until the seal breaks.'); }
  catch (error) { status(error.message, true); }
}

function showReceipt(kind, title, ...lines) {
  const receipt = $('#receipt'); receipt.dataset.state = kind;
  receipt.replaceChildren(el('strong','',title), ...lines.map(line => el('p','',line))); receipt.hidden = false;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (sealing) return;
  if (!body.value.trim()) { status('Write a few words before sealing.', true); body.focus(); return; }
  if (!$('#moment').value) { status('Choose a moment for your note.', true); $('#moment').focus(); return; }
  if ($('#condition-type').value === 'after' && !$('#condition-after').value) { status('Choose the earlier moment for your condition.', true); $('#condition-after').focus(); return; }
  sealing = true; $('#seal-button').disabled = true; status('Checking your note before any simulated charge…');
  const condition = { type:$('#condition-type').value };
  if (condition.type === 'count') condition.count = Number($('#condition-count').value || 1);
  if (condition.type === 'window') condition.before_minutes = Number($('#condition-window').value);
  if (condition.type === 'after') condition.after_moment_id = $('#condition-after').value;
  const payload = { body:body.value, category_id:categoryId, moment_id:$('#moment').value, payment_mode:$('#payment').value, show_name:$('#show-name').checked, request_id:requestId ||= crypto.randomUUID(), condition };
  try {
    const quote = await post('/ebs/quote', payload);
    if (quote.error) throw new Error(String(quote.error));
    if (quote.fit === 'mismatched' || quote.fit?.verdict === 'mismatched' || quote.fit?.choice === 'mismatched') { status('This note may fit another moment. Pick a moment that matches your words.', true); return; }
    const result = await post('/ebs/notes', payload); if (result.error) throw new Error(String(result.error));
    const note = result.note || result;
    if (note.status === 'rejected') {
      showReceipt('rejected', 'Rejected — no charge', 'Your note did not pass moderation. Edit your words and try again.');
      status('No simulated currency was charged.', true); requestId = undefined; await refresh(); return;
    }
    if (result.fit === 'mismatched' && !note.id) { status('This note may fit another moment. Pick another moment and seal again.', true); return; }
    body.value = ''; counter(); requestId = undefined;
    const held = ['held','pending_review'].includes(note.status);
    showReceipt(held ? 'held' : 'sealed', held ? 'Held for human review' : 'Sealed. See you at the moment.',
      `For: ${note.moment_label || momentLabel(note.moment_id || payload.moment_id, offered(momentGroups(state)))} · #${String(note.id || '').slice(0,8)}`,
      held ? 'Your words are hidden while a moderator reviews your note.' : 'Your words are hidden, even from you.');
    status(held ? 'A moderator will approve or reject your note.' : 'Your note is safely sealed.'); await refresh();
  } catch (error) { status(error.message, true); }
  finally { sealing = false; $('#seal-button').disabled = false; }
});

$('#compile-condition').onclick = async () => {
  const text = $('#condition-description').value.trim();
  if (!text) { status('Describe when you want the note to open.', true, '#compile-status'); return; }
  compiling = true; $('#compile-condition').disabled = true; status('Finding a matching moment…', false, '#compile-status');
  try {
    const result = await post('/ebs/compile', { text });
    if (!result.ok) { const message = typeof result.message === 'string' ? result.message : typeof result.fallback === 'string' ? result.fallback : 'Choose a listed moment and set its condition below.'; status(message, false, '#compile-status'); return; }
    const moments = offered(momentGroups(state)), condition = result.condition || { type:'moment' };
    if (!moments.some(moment => moment.id === result.moment_id) || !['moment','count','window','after'].includes(condition.type)) throw new Error('No matching listed moment. Choose a moment and condition yourself.');
    if (condition.type === 'count' && (!Number.isInteger(condition.count) || condition.count < 1 || condition.count > 100)) throw new Error('Choose an occurrence number from 1 to 100.');
    const minute = condition.before_minutes ?? condition.before_minute;
    if (condition.type === 'window' && (!Number.isFinite(minute) || minute <= 0 || minute > 1440)) throw new Error('Choose a stream minute from 1 to 1440.');
    if (condition.type === 'after' && (!moments.some(moment => moment.id === condition.after_moment_id) || condition.after_moment_id === result.moment_id)) throw new Error('Choose a different preceding moment from the list.');
    momentChoice = result.moment_id; if (condition.type === 'after') afterChoice = condition.after_moment_id; renderMoments(momentGroups(state));
    $('#condition-type').value = condition.type;
    if (condition.type === 'count') $('#condition-count').value = condition.count;
    if (condition.type === 'window') $('#condition-window').value = minute;
    conditionFields(); $('#condition-type').closest('details').open = true; requestId = undefined;
    status(`Matched: ${momentLabel(result.moment_id, moments)}. Review the selected condition, then seal your note.`, false, '#compile-status');
  } catch (error) { status(error.message || 'Choose a listed moment and set its condition yourself.', true, '#compile-status'); }
  finally { compiling = false; $('#compile-condition').disabled = state.features?.conditionCompiler !== true; }
};

window.addEventListener('sealed-refresh', refresh); refresh(); watchPrivateEvents(); refreshTimer = setInterval(refresh, 7000);
