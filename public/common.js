export const $ = (selector, root = document) => root.querySelector(selector);
export const all = (selector, root = document) => [...root.querySelectorAll(selector)];
export const query = new URLSearchParams(location.search);
// Twitch's CDN refuses to be framed by the extension itself, so the panel builds its Watch
// view as a srcdoc frame. There location.origin is "null"; the parent's origin comes from the inherited base URL.
export const embedded = document.body?.dataset.embedded === 'true' && window.parent !== window;
export const parentOrigin = new URL(document.baseURI).origin;
export const demo = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && query.get('demo') === '1';
export const base = String(window.SEALED_EBS_BASE || '').replace(/\/$/, '');
if (demo) await import('./harness.js');
export const iconFor = category => ({compass:'◇',sparkles:'✦',smile:'☺',heart:'♡'})[category?.icon] || category?.icon || '✦';
export const colors = { coral:'#f28c7a',gold:'#e7c470',lavender:'#b8acf0',teal:'#79cbb9',blue:'#9cbce7',rose:'#e3a7c8' };
export const categoryColor = category => colors[category?.envelope_color] || (/^#[a-f0-9]{6}$/i.test(category?.envelope_color || '') ? category.envelope_color : '#b8acf0');
export function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
// Theme: system by default; a local choice overrides it. Overlays stay transparent and light.
const themeKey = 'sealed-theme', themeChoices = ['system','light','dark'];
const svg = path => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">${path}</svg>`;
const themeIcons = {
  system:svg('<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2v14a7 7 0 0 1 0-14Z"/>'),
  light:svg('<circle cx="12" cy="12" r="4.5"/><path d="M11 1.5h2v3h-2zM11 19.5h2v3h-2zM1.5 11h3v2h-3zM19.5 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"/>'),
  dark:svg('<path d="M14.5 2.5a9.5 9.5 0 1 0 7 15.9A8 8 0 0 1 14.5 2.5Z"/>'),
};
let themeChoice = 'system', twitchTheme = null;
try { const stored = localStorage.getItem(themeKey); if (themeChoices.includes(stored)) themeChoice = stored; } catch { /* Storage can be unavailable in private or embedded views. */ }
function applyTheme() {
  const root = document.documentElement; if (root.classList.contains('transparent-root')) return;
  const theme = themeChoice === 'system' ? twitchTheme : themeChoice;
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  const toggle = $('.theme-toggle'); if (!toggle) return;
  toggle.innerHTML = themeIcons[themeChoice]; // Static, trusted markup.
  toggle.setAttribute('aria-label', `Theme: ${themeChoice === 'system' ? 'automatic' : themeChoice}. Change theme`); toggle.title = toggle.getAttribute('aria-label');
}
const topbar = $('.topbar');
if (topbar) {
  const toggle = el('button','icon-button theme-toggle'); toggle.type = 'button';
  toggle.onclick = () => { themeChoice = themeChoices[(themeChoices.indexOf(themeChoice) + 1) % themeChoices.length]; try { localStorage.setItem(themeKey, themeChoice); } catch { /* The choice still applies to this page. */ } applyTheme(); };
  topbar.append(toggle);
}
applyTheme();
export function status(message, error = false, selector = '#status') { const node = $(selector); if (node) { node.textContent = message; node.classList.toggle('error', error); } }
let token = '', latency = 0, ext;
export const authReady = new Promise((resolve, reject) => {
  // The panel's Watch view (srcdoc) gets public data from its parent; it never runs the helper or asks for auth.
  if (!document.body.dataset.extension || embedded) { resolve(); return; }
  const bind = () => {
    ext = window.Twitch?.ext;
    if (!ext) { reject(new Error('Open this surface inside Twitch Hosted Test, or use the local demo.')); return; }
    ext.onAuthorized(auth => { token = auth.token; resolve(auth); });
    // The helper keeps one context callback; latency and theme share it.
    ext.onContext(context => { if (Number.isFinite(context.hlsLatencyBroadcaster)) latency = Math.max(0, context.hlsLatencyBroadcaster) * 1000; if (['light','dark'].includes(context.theme)) { twitchTheme = context.theme; applyTheme(); } });
    ext.listen('broadcast', () => window.dispatchEvent(new CustomEvent('sealed-refresh')));
  };
  window.addEventListener('sealed-auth-error', event => reject(new Error(event.detail)), { once:true });
  if (window.Twitch?.ext) bind();
  else { const script = document.createElement('script'); script.src = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js'; script.onload = bind; script.onerror = () => reject(new Error('The Twitch helper could not load. Open the local demo to try Sealed Notes.')); document.head.append(script); }
});
// Attach a handler immediately, including on surfaces that do not need identity.
authReady.catch(error => status(error.message, true));
export async function api(path, options = {}) {
  if (path.startsWith('/ebs/')) await authReady;
  const headers = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${path.startsWith('/ebs/') ? base : ''}${path}`, { credentials: 'same-origin', ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || (typeof data.error === 'string' ? data.error.replace(/_/g, ' ') : data.error?.message) || `Request failed (${response.status})`); error.data = data; throw error; }
  return data;
}
export const post = (path, body, headers) => api(path, { method:'POST', body, headers });
// Identity sharing is separate from showing a name on a particular envelope.
export function shareIdentity() {
  if (ext?.viewer?.isLinked === true || ext?.viewer?.id) return;
  ext?.actions?.requestIdShare();
}
export function momentLabel(moment, moments = []) { return moments.find(item => item.id === moment)?.label || moment || 'A future moment'; }
export function categoryFor(note, config) { return note.category || config?.categories?.find(item => item.id === note.category_id) || { name:note.category_id || 'A note', envelope_color:'lavender', icon:'✦', subtitle:'A moment worth keeping' }; }
export function authorName(note) { return note.display_name ? `@${note.display_name.replace(/^@/, '')}` : 'a viewer'; }
export function toast(title, description = '') { $('.toast')?.remove(); const node = el('div','toast'); node.setAttribute('role','status'); node.append(el('strong','',title)); if (description) node.append(el('p','',description)); document.body.append(node); setTimeout(() => node.remove(), 8500); }
export async function watchPrivateEvents() {
  let initialized = false; const seen = new Set();
  const poll = async () => {
    try { const result = await api('/ebs/events'); const events = Array.isArray(result) ? result : result.events || result.notices || [];
      for (const event of events) { const key = event.id || event.note_id || JSON.stringify(event); if (seen.has(key)) continue; seen.add(key); if (initialized && event.type === 'opened') setTimeout(() => toast('Your note was opened', `Watch for your envelope on stream${event.moment_label ? `: ${event.moment_label}` : '.'}`), latency); }
      initialized = true;
    } catch { /* The next poll retries after a temporary connection failure. */ }
  };
  await poll(); return setInterval(poll, 2000);
}
export function renderReveal(note, config, moments = []) {
  const category = categoryFor(note, config); const card = el('article','reveal-card'); card.style.setProperty('--category', categoryColor(category));
  if (note.payment?.mode === 'sim_bits' || note.payment?.mode === 'bits') { card.style.setProperty('--category', colors.gold); card.classList.add('gold-seal'); }
  const icon = iconFor(category);
  const letter = el('div','reveal-letter'), header = el('div','reveal-header'), title = el('div','reveal-category');
  title.append(el('span','', icon), document.createTextNode(category.name || 'Note'), el('em','reveal-subtitle', category.subtitle || 'A moment worth keeping')); header.append(title, el('span','reveal-author', authorName(note)));
  const body = el('p','reveal-body',note.body || ''); const footer = el('div','reveal-footer'); footer.append(el('span','', `Opened for ${note.moment_label || momentLabel(note.moment_id, moments)}`),el('span','',note.reliability || note.confirmation_label || 'Streamer confirmed'));
  letter.append(header,body,footer);
  card.append(letter);
  const verdict = note.prediction_verdict?.verdict || note.prediction_verdict;
  if (verdict === 'came_true' || verdict === 'missed') { card.classList.add('with-verdict'); letter.append(el('div',`verdict${verdict === 'missed' ? ' missed' : ''}`,verdict === 'came_true' ? 'CALLED IT' : 'MISSED')); }
  return card;
}
export function empty(container, message) { container.replaceChildren(el('p','empty',message)); }
