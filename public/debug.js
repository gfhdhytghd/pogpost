import { $, el, status } from '/common.js';

// Private recognition debug workbench. Every server value is rendered with textContent;
// images load by URL from the cookie-protected debug route and never arrive as JSON data.
const LIMIT = 100, POLL_MS = 3000;
const FRAME_PREFIX = '/api/operator/debug/frame/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stageNames = { screen: 'Screening', review: 'Review' };
const views = { frames: 'All frames', screen: 'Screening', review: 'Review', requests: 'Requests' };

let tiles = new Map(), feed = null, enabled = false, view = 'frames', cursors = [null], page = 0, selection = null, detail = null, toggling = false, timer = 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = value => value === undefined || value === null ? '' : String(value);

// ——— HTTP: one bootstrap retry after a 401, never a loop ———
class HttpError extends Error { constructor(message, code, data) { super(message); this.code = code; this.data = data; } }
async function call(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new HttpError(typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error.replace(/_/g, ' ') : `Request failed (${response.status})`, response.status, data);
  return data;
}
const bootstrap = () => call('/api/operator/bootstrap');
async function authorized(path, options) {
  try { return await call(path, options); }
  catch (error) {
    if (error.code !== 401) throw error;
    await bootstrap();
    try { return await call(path, options); }
    catch (retry) { if (retry.code === 401) throw new HttpError('The operator sign-in has expired. Open this page from the operator desk on this computer.', 401); throw retry; }
  }
}
const debugGet = params => authorized(`/api/operator/debug?${new URLSearchParams(params)}`);
const debugSet = value => authorized('/api/operator/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sealed-Action': '1' }, body: JSON.stringify({ action: 'debug_set', enabled: value }) });

// ——— Formatting ———
function clock(ms) {
  const date = Number.isFinite(ms) ? new Date(ms) : null;
  const node = el('time', '', date && Number.isFinite(date.getTime()) ? `${date.toLocaleTimeString('en-GB', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}` : '–');
  if (date && Number.isFinite(date.getTime())) { node.dateTime = date.toISOString(); node.title = date.toLocaleString('en-US', { timeZoneName: 'short' }); }
  return node;
}
const bytes = value => !Number.isFinite(value) ? '–' : value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(2)} MB`;
const duration = value => !Number.isFinite(value) ? '–' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const percent = value => Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : '–';
function outcomeTone(outcome) {
  const value = text(outcome).toLowerCase();
  if (['ok', 'success', 'succeeded', 'completed', 'answered'].includes(value)) return 'ok';
  if (value === 'pending') return 'pending';
  if (value.includes('timeout') || value.includes('timed')) return 'timeout';
  if (value.includes('error') || value.includes('fail') || value.includes('refus') || value.includes('reject') || value.includes('interrupt') || value.includes('unavailable')) return 'error';
  return 'neutral';
}
// Images that answered 404/410 stay marked expired for this page, so nothing requests them again.
const expiredImages = new Set();
const pill = (label, tone) => el('span', `debug-pill tone-${tone}`, label);
// Only same-origin debug frame URLs are accepted; anything else falls back to the ID route or no image.
function imageUrl(frame) {
  const url = text(frame?.image_url);
  if (url.startsWith(FRAME_PREFIX) && UUID.test(url.slice(FRAME_PREFIX.length))) return url;
  return UUID.test(text(frame?.id)) ? `${FRAME_PREFIX}${frame.id}` : '';
}
let renewing = null;
const renewOnce = () => renewing ||= bootstrap().finally(() => { setTimeout(() => { renewing = null; }, 5000); });
// An <img> error has no status, so one same-origin fetch decides: 404/410 is expired for good,
// 401 renews the sign-in and retries once, anything else shows unavailable without a retry loop.
async function imageStatus(url) {
  const probe = () => fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(response => response.status);
  try { const code = await probe(); return code === 401 ? (await renewOnce(), probe()) : code; } catch { return 0; }
}
function picture(frame, alt, className = '') {
  const url = imageUrl(frame), box = el('div', `frame-picture ${className}`.trim()), missing = label => box.replaceChildren(el('span', 'frame-missing', label));
  if (!url) { missing('Image unavailable'); return box; }
  if (expiredImages.has(url)) { missing('Image expired'); return box; }
  // The write to disk can still be in progress; a later poll brings image_available=true and a new tile.
  if (frame.image_available === false) { missing('Image not stored yet'); return box; }
  const load = retry => {
    const image = el('img'); image.src = url; image.alt = alt; image.loading = 'lazy'; image.decoding = 'async';
    image.onerror = async () => {
      if (!retry) return missing('Image unavailable');
      const code = await imageStatus(url);
      if (code === 404 || code === 410) { expiredImages.add(url); missing('Image expired'); }
      else if (code >= 200 && code < 300) load(false);
      else missing('Image unavailable');
    };
    box.replaceChildren(image);
  };
  load(true); return box;
}

// ——— Feed indexes ———
const frames = () => list(feed?.frames).filter(object);
const requests = () => list(feed?.requests).filter(object);
const decisions = () => list(feed?.decisions).filter(object);
function requestIndex() {
  const index = new Map();
  for (const item of [...requests(), ...list(detail?.requests).filter(object), ...(object(detail?.request) ? [detail.request] : [])]) if (typeof item.id === 'string') index.set(item.id, item);
  return index;
}
function frameIndex() {
  const index = new Map();
  for (const item of [...frames(), ...list(detail?.frames).filter(object), ...(object(detail?.frame) ? [detail.frame] : [])]) if (typeof item.id === 'string') index.set(item.id, item);
  return index;
}
const stagesOf = frame => new Set([...(list(frame.screen_request_ids).length ? ['screen'] : []), ...(list(frame.review_request_ids).length ? ['review'] : [])]);
const requestIdsOf = frame => [...new Set([...list(frame.screen_request_ids), ...list(frame.review_request_ids)])];
const statusOf = request => text(request.status) || 'pending';
function decisionsFor(requestId) {
  const seen = new Set();
  return [...decisions(), ...list(detail?.decisions).filter(object)].filter(item => item.request_id === requestId && !seen.has(item.id ?? item) && seen.add(item.id ?? item));
}

// ——— Recorder ———
function renderRecorder() {
  const toggle = $('#recorder-toggle'), stats = object(feed?.stats) ? feed.stats : {}, limits = object(feed?.limits) ? feed.limits : {};
  toggle.setAttribute('aria-checked', String(enabled)); toggle.disabled = toggling || !feed;
  $('#recorder').classList.toggle('recording', enabled);
  $('#recorder-state').textContent = !feed ? 'Checking…' : enabled ? 'Recording new frames and model requests.' : 'Off. Nothing is being recorded.';
  const count = (value, max) => Number.isFinite(value) ? Number.isFinite(max) ? `${value} / ${max}` : String(value) : '–';
  $('#stat-images').textContent = count(stats.frames, limits.max_frames);
  $('#stat-storage').textContent = Number.isFinite(stats.bytes) ? `${bytes(stats.bytes)}${Number.isFinite(limits.max_bytes) ? ` / ${bytes(limits.max_bytes)}` : ''}` : '–';
  $('#stat-requests').textContent = count(stats.requests, limits.max_requests);
  $('#stat-decisions').textContent = count(stats.decisions, limits.max_decisions);
  $('#stat-total').textContent = count(stats.total_frames);
  $('#stat-records').textContent = Number.isFinite(stats.metadata_bytes) ? `${bytes(stats.metadata_bytes)}${Number.isFinite(limits.max_metadata_bytes) ? ` / ${bytes(limits.max_metadata_bytes)}` : ''}` : '–';
  $('#stat-expired').textContent = count(stats.expired_frames);
  $('#stat-dropped').textContent = count(stats.dropped_frames);
  $('#stat-errors').textContent = count(stats.storage_errors);
  // Capacity loss is never silent.
  const lost = (stats.expired_frames || 0) + (stats.dropped_frames || 0), records = (stats.expired_requests || 0) + (stats.expired_decisions || 0);
  const plural = (count, one, many) => count === 1 ? `1 ${one}` : `${count} ${many}`;
  $('#recorder-capacity').hidden = !lost && !records && !stats.storage_errors;
  $('#recorder-capacity').textContent = [
    lost ? `${plural(lost, 'older frame was', 'older frames were')} removed to stay within the limits; their images are gone.` : '',
    records ? `${plural(stats.expired_requests || 0, 'older request', 'older requests')} and ${plural(stats.expired_decisions || 0, 'decision', 'decisions')} expired${Number.isFinite(limits.max_metadata_bytes) ? ` under the ${bytes(limits.max_metadata_bytes)} record limit` : ''}.` : '',
    stats.storage_errors ? `${plural(stats.storage_errors, 'item', 'items')} could not be stored.` : ''].filter(Boolean).join(' ');
}
$('#recorder-toggle').onclick = async () => {
  if (toggling || !feed) return;
  const next = !enabled; toggling = true; renderRecorder();
  try {
    await debugSet(next); enabled = next;
    status(next ? 'Recording is on. Only frames captured from now on are kept.' : 'Recording is off. Nothing new is recorded.');
    await load();
  } catch (error) { status(error.message, true); }
  finally { toggling = false; renderRecorder(); }
};

// ——— List ———
function setView(next) {
  view = next;
  for (const node of document.querySelectorAll('.segmented [data-view]')) node.setAttribute('aria-checked', String(node.dataset.view === view));
  renderList();
}
for (const node of document.querySelectorAll('.segmented [data-view]')) {
  node.onclick = () => setView(node.dataset.view);
  node.onkeydown = event => {
    const order = Object.keys(views), step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = order[(order.indexOf(view) + step + order.length) % order.length];
    setView(next); document.querySelector(`.segmented [data-view="${next}"]`).focus();
  };
}
function frameTile(frame) {
  const item = el('li'), tile = el('button', 'frame-tile'), stages = stagesOf(frame);
  tile.type = 'button'; tile.dataset.key = `frame:${frame.id}`;
  tile.setAttribute('aria-pressed', String(selection?.type === 'frame' && selection.id === frame.id));
  const meta = el('span', 'frame-meta'), badges = el('span', 'frame-badges');
  meta.append(el('span', 'frame-seq', `#${text(frame.seq)}`), clock(frame.captured_at));
  if (stages.has('screen')) badges.append(pill('Screening', 'screen'));
  if (stages.has('review')) badges.append(pill('Review', 'review'));
  if (!stages.size) badges.append(pill('Kept only', 'neutral'));
  tile.append(picture(frame, ''), meta, badges);
  tile.setAttribute('aria-label', `Frame ${text(frame.seq)}, ${[...stages].map(stage => stageNames[stage]).join(' and ') || 'not sent to the model'}`);
  tile.onclick = () => select({ type: 'frame', id: frame.id });
  item.append(tile); return item;
}
function requestRow(request) {
  const item = el('li'), row = el('button', 'request-row'), tone = outcomeTone(statusOf(request));
  row.type = 'button'; row.dataset.key = `request:${request.id}`;
  row.setAttribute('aria-pressed', String(selection?.type === 'request' && selection.id === request.id));
  const top = el('span', 'request-top');
  top.append(pill(stageNames[request.stage] || text(request.stage) || 'Request', request.stage in stageNames ? request.stage : 'neutral'), pill(statusOf(request), tone), clock(request.started_at));
  const facts = el('span', 'request-facts', `${list(request.frame_ids).length === 1 ? '1 frame' : `${list(request.frame_ids).length} frames`} · ${duration(request.latency_ms)}${request.model ? ` · ${text(request.model)}` : ''}`);
  const outcome = decisionsFor(request.id).map(item => `${text(item.kind)}${item.event_id ? ` ${text(item.event_id)}` : ''}`).join(', ');
  row.append(top, facts);
  if (outcome) row.append(el('span', 'request-decision', outcome));
  row.onclick = () => select({ type: 'request', id: request.id });
  item.append(row); return item;
}
function renderList() {
  const grid = $('#frame-grid'), rows = $('#request-list'), showRequests = view === 'requests';
  const focused = document.activeElement?.closest?.('#frame-grid, #request-list') ? document.activeElement.dataset.key : null;
  grid.hidden = showRequests; rows.hidden = !showRequests;
  if (showRequests) {
    const items = requests();
    rows.replaceChildren(...items.map(requestRow));
    if (!items.length) rows.append(emptyState('No model requests on this page.'));
    $('#list-caption').textContent = items.length ? `${items.length === 1 ? '1 request' : `${items.length} requests`} linked to this page of frames.` : '';
  } else {
    const items = frames().filter(frame => view === 'frames' || stagesOf(frame).has(view));
    // Unchanged tiles are reused, so polling neither reloads thumbnails nor drops focus.
    const next = new Map();
    grid.replaceChildren(...items.map(frame => {
      const signature = JSON.stringify([frame, selection?.type === 'frame' && selection.id === frame.id]), cached = tiles.get(frame.id);
      const item = cached?.signature === signature ? cached.item : frameTile(frame);
      next.set(frame.id, { signature, item }); return item;
    }));
    tiles = next;
    if (!items.length) grid.append(emptyState(!feed ? 'Loading…' : view === 'frames' ? enabled ? 'Recording. Frames appear here as the picture watcher captures them.' : 'Recording is off. Turn it on to keep the frames captured from now on.' : `No frames on this page were sent for ${views[view].toLowerCase()}.`));
    $('#list-caption').textContent = items.length ? `${items.length === 1 ? '1 frame' : `${items.length} frames`}${view === 'frames' ? '' : ` sent for ${views[view].toLowerCase()}`}, newest first.` : '';
  }
  if (focused) document.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  $('#page-label').textContent = `Page ${page + 1}`;
  $('#page-prev').disabled = page === 0;
  $('#page-next').disabled = feed?.next_cursor === null || feed?.next_cursor === undefined;
}
function emptyState(message) { const node = el('li', 'empty', message); return node; }
$('#page-next').onclick = async () => { if (feed?.next_cursor == null) return; cursors[page + 1] = feed.next_cursor; page++; await load(); };
$('#page-prev').onclick = async () => { if (!page) return; page--; await load(); };

// ——— Inspector ———
async function select(next) {
  selection = next; detail = null;
  for (const node of document.querySelectorAll('[data-key][aria-pressed]')) node.setAttribute('aria-pressed', String(node.dataset.key === `${next.type}:${next.id}`));
  renderInspector();
  if (matchMedia('(max-width: 900px)').matches) $('#inspector').scrollIntoView({ block: 'start' });
  try {
    const result = await debugGet(next.type === 'frame' ? { frame_id: next.id } : { request_id: next.id });
    if (selection !== next) return;
    detail = object(result?.result) ? result.result : result; renderInspector(); renderList();
  } catch (error) { if (selection === next) status(error.message, true); }
}
function definitionList(entries) {
  const root = el('dl', 'inspector-facts');
  for (const [term, value] of entries) { const row = el('div'); row.append(el('dt', '', term)); const dd = el('dd'); dd.append(value instanceof Node ? value : document.createTextNode(text(value) || '–')); row.append(dd); root.append(row); }
  return root;
}
function json(value) { const node = el('pre', 'json'); node.textContent = JSON.stringify(value ?? null, null, 2); return node; }
function section(title, ...children) { const node = el('section', 'inspector-section'); node.append(el('h3', '', title), ...children); return node; }
function renderFrame(frame) {
  const index = requestIndex(), body = el('div', 'inspector-content');
  body.append(picture(frame, `Frame ${text(frame.seq)} at full size`, 'frame-large'));
  body.append(definitionList([['Sequence', `#${text(frame.seq)}`], ['Captured', clock(frame.captured_at)], ['Capture ID', text(frame.capture_id)],
    ['Dimensions', Number.isFinite(frame.width) && Number.isFinite(frame.height) ? `${frame.width} × ${frame.height}` : '–'], ['Size', bytes(frame.bytes)], ['Frame ID', text(frame.id)]]));
  const used = el('ol', 'linked-requests'), ids = requestIdsOf(frame);
  for (const id of ids) {
    const request = index.get(id), item = el('li'), link = el('button', 'linked-request');
    link.type = 'button'; link.dataset.key = `request:${id}`;
    if (request) {
      const position = list(request.frame_ids).indexOf(frame.id);
      link.append(pill(stageNames[request.stage] || text(request.stage), request.stage in stageNames ? request.stage : 'neutral'), pill(statusOf(request), outcomeTone(statusOf(request))),
        el('span', 'small', `${position >= 0 && list(request.frame_ids).length > 1 ? `frame ${position + 1} of ${list(request.frame_ids).length} · ` : ''}`), clock(request.started_at));
    } else link.append(el('span', 'small muted', `Request ${id.slice(0, 8)} is no longer kept`));
    link.onclick = () => select({ type: 'request', id });
    item.append(link); used.append(item);
  }
  body.append(section('Sent to the model', ids.length ? used : el('p', 'small muted', 'This frame was kept but not sent in any request.')));
  return body;
}
function answersTable(answers) {
  if (!answers.length) return el('p', 'small muted', 'No structured answers.');
  const table = el('table', 'answers'), head = el('tr');
  for (const label of ['Question', 'Type', 'Choice', 'Confidence']) head.append(el('th', '', label));
  table.append(el('thead'), el('tbody')); table.tHead.append(head);
  for (const answer of answers.filter(object)) {
    const row = el('tr');
    row.append(el('td', 'answer-name', text(answer.name)), el('td', '', text(answer.type)));
    const choice = el('td', 'answer-choice', text(answer.choice));
    if (answer.refusal) choice.append(el('span', 'answer-refusal', 'Refused'));
    if (answer.malformed) choice.append(el('span', 'answer-refusal', 'Malformed answer'));
    row.append(choice, el('td', 'answer-confidence', percent(answer.confidence)));
    table.tBodies[0].append(row);
  }
  return table;
}
function renderRequest(request) {
  const index = frameIndex(), body = el('div', 'inspector-content'), tone = outcomeTone(statusOf(request));
  const heading = el('div', 'request-heading');
  heading.append(pill(stageNames[request.stage] || text(request.stage) || 'Request', request.stage in stageNames ? request.stage : 'neutral'), pill(statusOf(request), tone));
  body.append(heading);
  if (tone === 'timeout' || tone === 'error') body.append(el('p', `request-problem tone-${tone}`, `${tone === 'timeout' ? 'Timed out' : 'No usable answer'}: ${statusOf(request).replace(/_/g, ' ')}.${request.raw ? '' : ' The model returned no structured output.'}`));
  body.append(definitionList([['Started', clock(request.started_at)], ['Finished', clock(request.finished_at)], ['Latency', duration(request.latency_ms)], ['Model', text(request.model)], ['Sequence', `#${text(request.seq)}`], ['Request ID', text(request.id)]]));
  // The exact frames, in the order the model received them.
  const strip = el('ol', 'frame-strip'), ids = list(request.frame_ids);
  strip.setAttribute('aria-label', 'Frames in the order sent');
  ids.forEach((id, position) => {
    const frame = index.get(id) || { id }, item = el('li'), button = el('button', 'strip-frame');
    button.type = 'button'; button.dataset.key = `frame:${id}`; button.dataset.position = String(position + 1);
    button.append(el('span', 'strip-order', String(position + 1)), picture(frame, `Frame ${position + 1} of ${ids.length}`), el('span', 'strip-meta', frame.seq !== undefined ? `#${text(frame.seq)}` : 'No longer kept'));
    if (frame.captured_at !== undefined) button.lastChild.append(' · ', clock(frame.captured_at));
    button.onclick = () => select({ type: 'frame', id });
    item.append(button); strip.append(item);
  });
  const missing = Number.isFinite(request.missing_frames) ? request.missing_frames : list(request.missing_frames).length;
  body.append(section(ids.length === 1 ? 'Frame sent' : `${ids.length} frames sent, in order`, ids.length ? strip : el('p', 'small muted', 'No frames were attached.'),
    ...(missing ? [el('p', 'small muted', `${missing === 1 ? '1 frame of this request is' : `${missing} frames of this request are`} no longer kept.`)] : [])));
  const definitions = list(request.definitions).filter(object);
  if (definitions.length) {
    const rows = el('ul', 'definition-list');
    for (const item of definitions) { const row = el('li'); row.append(el('strong', '', text(item.label)), el('code', '', text(item.id)), el('span', 'small muted', `${text(item.mode)} · threshold ${percent(item.min_confidence)}`), el('p', 'small', text(item.description))); rows.append(row); }
    body.append(section('Events asked about', rows));
  }
  body.append(section('Structured model answers', answersTable(list(request.raw?.answers))));
  body.append(section('Normalized result', json(request.normalized)));
  const made = decisionsFor(request.id);
  if (made.length) {
    const rows = el('ul', 'decision-list');
    for (const item of made) {
      const row = el('li'), facts = [item.event_id, item.reason, item.outcome, Number.isFinite(item.confidence) ? `confidence ${percent(item.confidence)}${Number.isFinite(item.threshold) ? ` of ${percent(item.threshold)}` : ''}` : '',
        typeof item.accepted === 'boolean' ? item.accepted ? 'accepted' : 'not accepted' : ''].filter(Boolean).map(text);
      row.append(el('strong', '', text(item.kind)), el('span', '', facts.length ? ` · ${facts.join(' · ')}` : ''), ' · ', clock(item.at)); rows.append(row);
    }
    body.append(section('Decisions', rows));
  }
  if (request.usage != null) body.append(section('Usage', json(request.usage)));
  const raw = el('details', 'raw-output'); raw.append(el('summary', '', 'Recorded answers as JSON'), json(request.raw)); body.append(raw);
  return body;
}
let inspectorKey = '';
function renderInspector() {
  const root = $('#inspector-body'), title = $('#inspector-title');
  if (!selection) { inspectorKey = ''; title.textContent = 'Inspector'; root.replaceChildren(el('p', 'inspector-empty', 'Choose a frame or a request to see the image, the model\'s answer and the exact frames it saw.')); return; }
  const item = selection.type === 'frame' ? frameIndex().get(selection.id) : requestIndex().get(selection.id);
  // Rebuild only when the shown data changes, so polling keeps scroll position and open sections.
  const key = JSON.stringify([selection, item ?? null, selection.type === 'frame' ? [...requestIndex().values()].filter(entry => item && requestIdsOf(item).includes(entry.id)) : decisionsFor(selection.id)]);
  if (key === inspectorKey) return;
  const open = root.querySelector('details.raw-output')?.open;
  inspectorKey = key;
  if (!item) { title.textContent = selection.type === 'frame' ? 'Frame' : 'Request'; root.replaceChildren(el('p', 'inspector-empty', detail ? 'This item is no longer kept. It may have expired or been dropped at capacity.' : 'Loading…')); return; }
  title.textContent = selection.type === 'frame' ? `Frame #${text(item.seq)}` : `${stageNames[item.stage] || 'Model'} request`;
  root.replaceChildren(selection.type === 'frame' ? renderFrame(item) : renderRequest(item));
  const raw = root.querySelector('details.raw-output'); if (open && raw) raw.open = true;
}

// ——— Loading and polling ———
async function load() {
  clearTimeout(timer);
  try {
    const params = { limit: LIMIT }; if (cursors[page] != null) params.before = cursors[page];
    const result = await debugGet(params);
    feed = object(result?.result) ? result.result : result; enabled = feed?.enabled === true;
    renderRecorder(); renderList(); renderInspector();
  } catch (error) { status(error.message, true); }
  // Only the newest page follows live recording; older pages stay still while you read them.
  if (page === 0) timer = setTimeout(load, POLL_MS);
}
try { await bootstrap(); await load(); if (!$('#status').classList.contains('error')) status('Connected. Images stay private to this operator desk.'); }
catch (error) { status(error.message, true); }
