import { $, el, api, post, status, empty, momentLabel, renderReveal } from './common.js';
import { createEventsPanel } from './console-events.js';
import { groupMomentChoices } from './moment-choices.js';
import { DEFAULT_ROPE, ropeOf, validRope } from './overlay-stage.js';
// Server groups win; an older server without moment_groups falls back to the shared pure helper.
const momentGroups = view => view.moment_groups && Array.isArray(view.moment_groups.current_profile) && Array.isArray(view.moment_groups.stream_general)
  ? view.moment_groups : groupMomentChoices(view.moments || view.config?.moments || [], view.config?.events || []);
let state, presentation = null, busy = false;
const operatorAction = payload => post('/api/operator/action',payload,{'X-Sealed-Action':'1'});
// Resolves to the server response, or null when the action was refused or failed.
async function action(payload) { if (busy) return null; busy = true; try { const response = await operatorAction(payload); status('The operator action is complete.'); await refresh(); return response || {}; } catch (error) { status(error.message,true); return null; } finally { busy = false; } }
function button(text, handler, className = 'small secondary') { const node = el('button',className,text); node.onclick = handler; return node; }
function meta(note) { const content = el('div'); content.append(el('strong','',`${note.moment_label || momentLabel(note.moment_id,state.config?.moments)} · #${String(note.id).slice(0,8)}`),el('p','',`${String(note.status).replace(/_/g,' ')} · ${note.category_id || 'AI category'}${note.guaranteed ? ' · guaranteed' : ''}`)); return content; }
// Server-backed switches. The label always shows the server's state; a request in flight only disables the button.
const switches = {
  perception: { prefix:'perception', box:'#perception-control', tile:'#observation-controls', action:'perception_set', start:'Start detection', stop:'Stop detection',
    on:'On. Matching events appear in Event suggestions for you to confirm.', off:'Off. No pictures are checked.', starting:'Starting detection…', stopping:'Stopping detection…',
    allowed:value => value.controllable === true, reason:value => typeof value.unavailable_reason === 'string' && value.unavailable_reason.trim() ? value.unavailable_reason.trim().slice(0,200) : 'Detection cannot be started on this server.',
    done:enabled => enabled ? 'Detection is on.' : 'Detection is off.', failed:enabled => `Detection did not ${enabled ? 'start' : 'stop'}` },
  debug: { prefix:'debug', box:'#debug-control', tile:'#debug-control', action:'debug_set', start:'Start recording', stop:'Stop recording',
    on:'Recording. Frames and model answers are kept on this machine.', off:'Off. Nothing new is recorded.', starting:'Starting recording…', stopping:'Stopping recording…',
    allowed:value => value.available === true, reason:() => 'Debug recording is not available on this server.',
    done:enabled => enabled ? 'Debug recording is on.' : 'Debug recording is off. Saved history stays.', failed:enabled => `Debug recording did not ${enabled ? 'start' : 'stop'}` },
};
const pendingSwitch = {};
const switchValue = key => { const value = state?.integrations?.[key]; return value && typeof value === 'object' ? value : null; };
function renderSwitch(key) {
  const spec = switches[key], value = switchValue(key), $id = name => $(`#${spec.prefix}-${name}`);
  $(spec.box).hidden = !value; if (!value) return;
  const enabled = value.enabled === true, pending = Object.hasOwn(pendingSwitch, key), toggle = $id('toggle');
  toggle.textContent = enabled ? spec.stop : spec.start;
  toggle.className = `small ${enabled ? 'secondary' : 'primary'}`;
  // Stopping is always allowed; starting needs the server's permission.
  const blocked = !enabled && !spec.allowed(value);
  toggle.disabled = pending || blocked;
  toggle.setAttribute('aria-busy', String(pending));
  $id('state').textContent = pending ? (pendingSwitch[key] ? spec.starting : spec.stopping) : enabled ? spec.on : spec.off;
  $(spec.tile).classList.toggle('on', enabled);
  $id('reason').hidden = !blocked; $id('reason').textContent = blocked ? spec.reason(value) : '';
}
async function setSwitch(key) {
  const spec = switches[key], current = switchValue(key); if (!current || Object.hasOwn(pendingSwitch, key)) return;
  const enabled = current.enabled !== true, error = $(`#${spec.prefix}-error`); pendingSwitch[key] = enabled;
  error.hidden = true; renderSwitch(key);
  try {
    const response = await operatorAction({action:spec.action,enabled});
    status(spec.done(response?.result?.enabled === true));
  } catch (failure) { error.textContent = `${spec.failed(enabled)}: ${failure.message}`; error.hidden = false; }
  finally { delete pendingSwitch[key]; await refresh(); renderSwitch(key); }
}
function renderProfile(profile) {
  $('#profile-quick-name').textContent = profile ? `${profile.name}${profile.modified ? ' · modified' : ''}` : 'Checking…';
}
function renderIntegrations() {
  const integrations = state.integrations; $('#connections-section').hidden = !integrations;
  $('#observation-controls').hidden = !(switchValue('perception') || state.config?.events?.length || state.aiPrompts?.length);
  renderSwitch('perception'); renderSwitch('debug');
  if (!integrations) return;
  const root = $('#integration-status'); root.replaceChildren();
  const labels = {twitch:'Twitch events',judgements:'Note checks',perception:'Picture & sound',compiler:'Condition matching'};
  const statusLabels = {connected:'Connected',ready:'Ready',available:'Ready',active:'Active',running:'Active',configured:'Configured',disabled:'Off',off:'Off',unavailable:'Unavailable',offline:'Offline',disconnected:'Disconnected',error:'Unavailable',failed:'Unavailable',demo:'Demo only',mock:'Demo only',idle:'Waiting'};
  for (const [key,label] of Object.entries(labels)) {
    if (!(key in integrations)) continue;
    const value = integrations[key], detail = value && typeof value === 'object' ? value : {};
    const raw = typeof value === 'string' ? value : typeof value === 'boolean' ? value ? 'ready' : 'disabled' : typeof detail.status === 'string' ? detail.status : detail.connected === true ? 'connected' : detail.enabled === false ? 'disabled' : detail.available === true ? 'available' : 'configured';
    const healthy = ['connected','ready','available','active','running'].includes(raw);
    const item = el('div','integration-item'), heading = el('div','row between');
    heading.append(el('strong','small',label),el('span',`pill${healthy ? ' teal' : ''}`,statusLabels[raw] || raw.replace(/_/g,' ').slice(0,40))); item.append(heading);
    const description = typeof detail.message === 'string' ? detail.message : typeof detail.summary === 'string' ? detail.summary : '';
    if (description) item.append(el('p','small muted',description));
    root.append(item);
  }
}

const momentKinds = {ai:'Picture event',declared:'Declared',builtin:'Built-in',twitch:'Twitch event'};
function momentRow(moment) {
  const row = el('div','moment-row'), text = el('div'), declare = button('Declare moment',() => action({action:'moment',moment_id:moment.id,context:$('#moment-context').value}),'primary small');
  declare.dataset.focus = `declare:${moment.id}`;
  text.append(el('strong','',moment.label),el('p','',moment.long_lived ? 'Carries across streams' : `${momentKinds[moment.kind] || moment.kind || 'Declared'} · ${(moment.occurred_at || []).length} confirmed`)); row.append(text,declare); return row;
}
function momentGroup(title, moments, emptyNode) {
  const group = el('section','moment-group'), list = el('div','moment-list');
  group.append(el('h3','',title),list); list.append(...moments.map(momentRow)); if (!moments.length && emptyNode) list.append(emptyNode); return group;
}
// Only the running profile's events and stream-general moments (start, end, Twitch) are offered.
// Older moments stay on their notes by label; they are not declarable here.
function renderMoments() {
  const focused = document.activeElement?.closest?.('#moment-list') ? document.activeElement.dataset.focus : null;
  const groups = momentGroups(state);
  const empty = el('p','moment-empty small muted','No recognition events are running. Choose one in '), link = el('a','','Game profile'); link.href = '#event-preset'; empty.append(link,'.');
  $('#moment-list').replaceChildren(momentGroup('Current profile',groups.current_profile,empty),...(groups.stream_general.length ? [momentGroup('Stream general',groups.stream_general)] : []));
  if (focused) [...document.querySelectorAll('#moment-list button')].find(node => node.dataset.focus === focused)?.focus();
}

function render() {
  renderIntegrations();
  $('#sealed-count').replaceChildren(document.createTextNode(`${state.sealedCount || state.counts?.sealed || 0} `),el('span','','notes waiting')); $('#session-name').textContent = String(state.session?.id || state.session?.label || 'Current session').slice(0,20);
  renderMoments();
  events.render(state);
  const prompts = state.aiPrompts || []; $('#ai-prompts').replaceChildren(); if (!prompts.length) empty($('#ai-prompts'),'No event suggestions. You can declare a moment below.');
  for (const prompt of prompts) {
    const row = el('article','queue-item suggestion'), heading = el('div','row between'), api = prompt.source === 'api';
    heading.append(el('strong','',prompt.label || prompt.moment_id || 'Suggested moment'),el('span',`pill ${api ? 'teal' : 'gold'}`,api ? 'API trigger' : 'AI picture'));
    row.dataset.source = api ? 'api' : 'ai'; row.append(heading);
    const timestamp = Number.isFinite(prompt.observed_at) ? prompt.observed_at : prompt.created_at;
    const observed = typeof timestamp === 'number' ? new Date(timestamp) : null;
    if (observed && Number.isFinite(observed.getTime())) {
      const line = el('p','small muted',api ? 'Requested ' : 'Observed '), time = el('time','',observed.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
      time.dateTime = observed.toISOString(); time.title = observed.toLocaleString('en-US',{timeZoneName:'short'}); line.append(time);
      const expires = Number.isFinite(prompt.expires_at) ? new Date(prompt.expires_at) : null;
      if (expires) { const until = el('time','',expires.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'})); until.dateTime = expires.toISOString(); line.append(' · expires ',until); }
      row.append(line);
    }
    const summary = typeof prompt.evidence === 'string' && prompt.evidence.trim() ? prompt.evidence : typeof prompt.context === 'string' && prompt.context.trim() ? prompt.context : api ? 'A local event source reported this moment. Did it happen?' : 'AI detected this moment. Did it happen?';
    row.append(el('p','',summary));
    const actions = el('div','row');
    actions.append(button('Confirm moment',() => action({action:'confirm_ai',id:prompt.id,moment_id:prompt.moment_id,approve:true}),'primary small'),button('Dismiss',() => action({action:'confirm_ai',id:prompt.id,approve:false})));
    row.append(actions); $('#ai-prompts').append(row);
  }
  const held = state.held || state.notes?.filter(note => ['held','pending_review'].includes(note.status)) || []; $('#held-count').textContent = `${held.length} waiting`; $('#review-queue').replaceChildren();
  if (!held.length) empty($('#review-queue'),'All clear. Notes held for review will appear here.');
  for (const note of held) { const row = el('article','queue-item'); row.append(meta(note)); if (note.body) row.append(el('p','revealed-body',note.body)); if (note.moderation) row.append(el('p','',`Moderation: ${note.moderation.verdict || 'unsure'} · ${note.moderation.source || 'rules'}`)); const actions = el('div','row'); actions.append(button('Approve',() => action({action:'review',id:note.id,approve:true}),'small primary'),button('Reject',() => action({action:'review',id:note.id,approve:false}),'small danger')); row.append(actions); $('#review-queue').append(row); }
  const queue = (state.notes || state.queue || []).filter(note => note.status === 'sealed'); $('#sealed-queue').replaceChildren(); if (!queue.length) empty($('#sealed-queue'),'No sealed notes waiting. Invite viewers to write one.');
  // Manual presentation: only envelopes whose moment was declared can be opened.
  const manual = presentation?.presentation_mode === 'manual', readyIds = new Set([...(presentation?.ready_envelopes || []), ...(manual ? presentation?.queue || [] : [])].map(item => item?.id));
  for (const note of queue) { const row = el('div','queue-item'); row.append(meta(note),!manual || readyIds.has(note.id) ? button('Open this note',() => action({action:'reveal',id:note.id})) : el('span','pill','Waiting for its moment')); $('#sealed-queue').append(row); }
  $('#skip').textContent = manual ? 'Close note' : 'Skip note'; $('#skip').disabled = manual && !presentation?.current;
  $('#current-note').replaceChildren(); const current = state.current || state.reveals?.[0]; if (current) { const card = renderReveal(current,state.config,state.config?.moments); card.classList.add('console-reveal'); $('#current-note').append(card); if (current.category_id === 'prediction') { const row = el('div','row'); row.classList.add('space-top'); for (const [verdict,label] of [['came_true','Called it'],['missed','Missed'],['unclear','Unclear']]) row.append(button(label,() => action({action:'verdict',id:current.id,verdict}))); $('#current-note').append(row); } } else empty($('#current-note'),'The next opened envelope will appear here.');
}
async function refresh() {
  try { [state, presentation] = await Promise.all([api('/api/operator/state'), api('/api/overlay').catch(() => presentation)]); render(); }
  catch (error) { status(error.message,true); events.failed(error.message); }
}
/* Stage layout: the preview frame shows handles and reports the dragged rope; only Save sends it. */
const STAGE_NOTE = 'The same envelopes your OBS overlay shows. Select a ready envelope to open it; close the letter when you are done.';
let layout = { editing: false, draft: null, reset: false };
function postStage(message) { $('#stage-frame')?.contentWindow?.postMessage(message, location.origin); }
function setLayoutEditing(editing, saved = null) {
  layout = { editing, draft: editing ? layout.draft : null, reset: editing && layout.reset };
  $('#layout-edit').hidden = editing; for (const id of ['#layout-save', '#layout-reset', '#layout-cancel']) $(id).hidden = !editing;
  postStage({ type: 'sealed-layout-edit', on: editing, layout: editing ? layout.draft : saved });
}
$('#layout-edit').onclick = () => {
  layout = { editing: true, draft: ropeOf(state?.config?.reveal?.rope), reset: false };
  setLayoutEditing(true); status('Drag either end of the rope, or focus an end and use the arrow keys. Nothing changes on stream until you save.', false, '#layout-note');
  $('#layout-save').focus();
};
$('#layout-cancel').onclick = () => { setLayoutEditing(false); status(STAGE_NOTE, false, '#layout-note'); $('#layout-edit').focus(); };
$('#layout-reset').onclick = () => {
  layout = { ...layout, draft: ropeOf(DEFAULT_ROPE), reset: true }; setLayoutEditing(true);
  status('Showing the default rope. Save to use it on stream.', false, '#layout-note');
};
$('#layout-save').onclick = async () => {
  const draft = validRope(layout.draft); if (!draft) return;
  // Reset sends null, so the server restores its own default.
  const result = await action({ action: 'stage_layout_set', layout: layout.reset ? null : draft });
  if (result === null) { status('The layout was not saved. Your preview is still here; try again or cancel.', true, '#layout-note'); return; }
  setLayoutEditing(false, ropeOf(state?.config?.reveal?.rope ?? draft)); postStage({ type: 'sealed-overlay-refresh', ok: true });
  status('Layout saved. OBS and viewers follow within a second.', false, '#layout-note'); $('#layout-edit').focus();
};

/* The stage preview is the OBS overlay in a same-origin frame. It only asks; this page acts. */
addEventListener('message', async event => {
  const frame = $('#stage-frame'), type = event.data?.type;
  if (event.origin !== location.origin || !frame || event.source !== frame.contentWindow) return;
  if (type === 'sealed-layout-change') { const draft = validRope(event.data.layout); if (layout.editing && draft) layout = { ...layout, draft, reset: false }; return; }
  if (type !== 'sealed-overlay-open' && type !== 'sealed-overlay-close') return;
  const id = typeof event.data.id === 'string' ? event.data.id : null;
  if (type === 'sealed-overlay-open' && !id) return;
  const result = await action(type === 'sealed-overlay-open' ? {action:'reveal',id} : {action:'skip'});
  frame.contentWindow?.postMessage({type:'sealed-overlay-refresh',ok:result !== null},location.origin);
});
const events = createEventsPanel({request:operatorAction,refresh,status,onProfile:renderProfile});
$('#reset-perception').onclick = () => action({action:'reset_perception'});
$('#perception-toggle').onclick = () => setSwitch('perception');
$('#debug-toggle').onclick = () => setSwitch('debug');
$('#profile-quick-change').onclick = () => {
  const select = $('#event-preset-select');
  $('#events-section').scrollIntoView({block:'start'});
  (select.disabled ? $('#events-title') : select).focus({preventScroll:true});
};
$('#wrap').onclick = () => action({action:'wrap',context:$('#moment-context').value}); $('#skip').onclick = () => action({action:'skip'}); $('#new-session').onclick = () => action({action:'session'});
try { await api('/api/operator/bootstrap'); await refresh(); status('Your desk is ready. Declare a moment when it happens.'); setInterval(refresh,2000); } catch (error) { status(error.message,true); }
