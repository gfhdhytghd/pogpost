import { $, el, iconFor, categoryColor, colors } from './common.js';
import { RopePhysics } from './rope-physics.js';

/* The shared envelope stage for OBS (/overlay), the operator preview (/overlay?operator=1)
   and the Twitch viewer overlay. Sealed envelopes hang on a twine line; envelopes whose
   moment was declared fly down into a ready row; only the server's real `current` note is
   opened. Covers never carry a body. Every string goes through textContent. */
// Rope: about 4% sag of its span when empty; envelopes weigh 8, the tally 4 (rope nodes weigh 1).
const LINE_MAX = 12;   // the server sends at most 12 sealed covers; the rest are counted on the tally
const SLACK = 1.004, ENVELOPE_MASS = 8, TALLY_MASS = 4, QUIET_ACTIVITY = 2e-6, QUIET_FRAMES = 30;
const INTRO_MS = 2130, FADE_MS = 480, FALL_MS = 900, MIN_READ_MS = 5000;
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => reduceQuery.matches;
const text = (value, max = 120) => String(value ?? '').slice(0, max);
const fromName = name => typeof name === 'string' && name.trim() ? `@${text(name, 40).replace(/^@/, '')}` : 'A viewer';
const gold = payment => ['sim_bits', 'bits'].includes(payment);
const coverSig = item => JSON.stringify([item.display_name, item.moment_label, item.condition_label, item.category_id, item.payment_mode]);

/* Rope layout: two ends as fractions of the stage, the same contract the server validates. */
export const DEFAULT_ROPE = Object.freeze({ left: Object.freeze({ x: 0, y: 0.025 }), right: Object.freeze({ x: 1, y: 0.025 }) });
export const MIN_ROPE_GAP = 0.1;
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const point = value => value && typeof value === 'object' && Object.keys(value).length === 2 && unit(value.x) && unit(value.y);
// A valid layout as a plain copy, or null.
export function validRope(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !point(value.left) || !point(value.right)) return null;
  if (value.right.x - value.left.x < MIN_ROPE_GAP - Number.EPSILON) return null;
  return { left: { x: value.left.x, y: value.left.y }, right: { x: value.right.x, y: value.right.y } };
}
export const ropeOf = value => validRope(value) || validRope(DEFAULT_ROPE);
export const sameRope = (a, b) => ['left', 'right'].every(side => a[side].x === b[side].x && a[side].y === b[side].y);
const clamp01 = value => Math.min(1, Math.max(0, value));
// Move one end; the other stays, and the gap never drops below the minimum.
export function moveRopeEnd(rope, side, x, y) {
  const next = ropeOf(rope), round = value => Math.round(value * 1000) / 1000;
  if (side === 'left') next.left = { x: Math.min(round(clamp01(x)), Math.floor((next.right.x - MIN_ROPE_GAP) * 1000) / 1000), y: round(clamp01(y)) };
  else next.right = { x: Math.max(round(clamp01(x)), Math.ceil((next.left.x + MIN_ROPE_GAP) * 1000) / 1000), y: round(clamp01(y)) };
  return validRope(next) || ropeOf(rope);
}

// Static, trusted markup; every page that shows the stage gets the same structure.
const STAGE_MARKUP = '<section id="line" class="line" aria-label="Sealed envelopes"><svg id="twine" class="twine" aria-hidden="true"><path class="twine-shadow"/><path class="twine-rope"/><path class="twine-twist"/><circle class="twine-knot" data-side="left" hidden/><circle class="twine-knot" data-side="right" hidden/></svg><ol id="envelopes" class="envelopes"></ol><div id="tally" class="tally"><span class="tally-pin" aria-hidden="true"></span><span class="tally-card"><span id="sealed-count">0 notes sealed</span><span id="more-count" class="more-count" hidden></span></span></div></section><section id="ready-row" class="ready-row" aria-label="Envelopes ready to open"><ol id="ready" class="ready"></ol><p id="ready-more" class="ready-more" hidden></p></section><main id="reveal-stage" class="reveal-stage" aria-live="polite"></main>';

/**
 * load(): resolves to the public presentation snapshot. Without load, the page only shows
 * snapshots passed to apply() (the panel's embedded view).
 * operator: render Open/Close controls that ask the parent console (same origin) to act.
 */
export function startStage({ load = null, interval = 500, operator = false }) {
  if (!$('#reveal-stage')) document.body.insertAdjacentHTML('afterbegin', STAGE_MARKUP);
  const stage = $('#reveal-stage'), list = $('#envelopes'), readyList = $('#ready'), twine = $('#twine'), tally = $('#tally');
  const hung = new Map(), ready = new Map();   // envelope id → node
  const controls = operator && window.parent !== window;
  let rope = ropeOf(null), draft = null, held = null;   // server layout; operator's unsaved preview; just-saved layout until the server shows it
  const activeRope = () => draft || held?.rope || rope;
  let geo, show = null, reel = null, config = {}, last = { line: [], ready: [], total: 0 }, manual = false, pending = null, lastServerNow = -Infinity;
  document.body.classList.toggle('operator', controls);

  const categoryOf = (id, fallback) => fallback || config.categories?.find(item => item.id === id) || { id, name: 'A note', envelope_color: 'lavender', icon: 'sparkles' };
  const waxOf = (category, payment) => gold(payment) ? colors.gold : categoryColor(category);
  const ask = message => { if (controls) window.parent.postMessage(message, location.origin); };

  /* ——— Geometry and physics: a real cable between two movable ends. Pins, swing and the tally
     all read the same simulated rope; each frame only writes the SVG paths and transforms. ——— */
  let physics = null, raf = 0, inFrame = false, lastFrame = 0, quiet = 0, loadSig = '', deferred = null;
  // A hidden frame (the panel's Watch view behind another tab) has no size: keep the last geometry,
  // stop simulating, and start from rest at the new size once it shows again.
  const sized = () => innerWidth >= 2 && innerHeight >= 2;
  const loads = new Map();   // load id → { t: current, target, mass, length, node, swing }
  function measure(mode = 'move') {
    if (!sized()) return false;
    const W = innerWidth, H = innerHeight, u = Math.min(W / 100, H / 56.25);
    const ew = Math.round(Math.max(9.6 * u, 92)), lw = Math.round(Math.min(Math.max(40 * u, 300), W * 0.9));
    const rw = Math.round(Math.min(ew * 1.25, W * 0.3)), rh = rw / 1.55, layout = activeRope();
    const L = { x: layout.left.x * W, y: layout.left.y * H }, R = { x: layout.right.x * W, y: layout.right.y * H }, span = Math.max(1, R.x - L.x);
    const chord = Math.hypot(R.x - L.x, R.y - L.y), sag = chord * Math.sqrt((SLACK - 1) * 3 / 8);
    geo = { W, H, u, ew, lw, rw, rh, L, R, span, shown: layout, bottom: Math.max(L.y, R.y) + sag * 1.4, left: L.x + Math.max(3 * u, 20) * (layout.left.x > 0.005 ? 0.6 : 1) };
    const root = document.documentElement.style;
    root.setProperty('--u', `${u}px`); root.setProperty('--ew', `${ew}px`); root.setProperty('--lw', `${lw}px`); root.setProperty('--rw', `${rw}px`);
    twine.setAttribute('viewBox', `0 0 ${W} ${H}`);
    // A new size or reduced motion starts from rest; a moved end pulls the rope and it swings after.
    const snap = mode === 'resize' || !physics || reduced();
    if (!physics) physics = new RopePhysics({ left: L, right: R, scale: W, slack: SLACK });
    else physics.setAnchors(L, R, { scale: W, snap });
    geo.settle = geo.settle || snap;
    if (!snap) wake();
    // A tied knot where an end sits inside the picture; at the edge the rope just runs off.
    for (const knot of twine.querySelectorAll('.twine-knot')) {
      const end = knot.dataset.side === 'left' ? L : R, x = layout[knot.dataset.side].x;
      knot.setAttribute('cx', end.x); knot.setAttribute('cy', end.y); knot.setAttribute('r', Math.max(0.45 * u, 3.5));
      knot.toggleAttribute('hidden', x <= 0.005 || x >= 0.995);
    }
    placeTally(); placeHandles();
    return true;
  }
  // Material position along the rope for a screen x on the straight chord (nodes are evenly spaced).
  const ropeT = x => Math.min(0.98, Math.max(0.02, (x - geo.L.x) / geo.span));
  // The tally hangs at the right end and is drawn above the covers; envelopes use the rope to its left.
  // On a short rope the tally shrinks to fit and the covers overlap into one stack.
  function placeTally() {
    const { L, R, u, ew } = geo, span = R.x - L.x, card = tally.querySelector('.tally-card'), width = card.offsetWidth || 120;
    // 0.82 leaves room for the tag's tilt and swing.
    const scale = Math.min(1, span * 0.82 / width), shown = width * scale;
    const margin = Math.max(2 * u, 14) * (activeRope().right.x < 0.995 ? 0.6 : 1) * scale;
    const left = Math.min(geo.left, L.x + span * 0.1), tallyX = Math.max(L.x + shown / 2, R.x - margin - shown / 2);
    geo.tally = { scale, lift: Math.max(1.6 * u, 12) * scale };
    hold('tally', tally, null, ropeT(tallyX), TALLY_MASS, (card.offsetHeight || 60) * scale / 2);
    geo.left = left; geo.avail = Math.max(0, tallyX - shown / 2 - Math.max(1.5 * u, 12) - left);
  }
  // Hang or move a load. A fresh one starts at its place; an existing one slides there along the rope.
  function hold(id, node, swing, target, mass, length, tilt = 0) {
    const load = loads.get(id);
    if (load) Object.assign(load, { target, mass, length, node, swing, tilt });
    else loads.set(id, { t: target, target, mass, length, node, swing, tilt });
    if (reduced()) loads.get(id).t = target;
  }
  function unhang(id) {
    hung.delete(id);
    if (loads.delete(`env:${id}`)) pushLoads();
  }
  function pushLoads() {
    if (!physics) return;
    const list = [...loads].map(([id, load]) => ({ id, t: Math.round(load.t * 1e4) / 1e4, mass: load.mass, length: load.length }));
    const sig = JSON.stringify(list);
    if (sig === loadSig) return;
    loadSig = sig; physics.setLoads(list);
    if (reduced()) geo.settle = true; else wake();
  }
  function relayout(mode = 'move') {
    if (!measure(mode)) return;
    renderReady(last.ready, last.readyTotal); renderLine(last.line, last.total); settleIfNeeded();
    if (deferred) { const state = deferred; deferred = null; apply(state); }
  }
  function settleIfNeeded() { if (geo?.settle && physics) { pushLoads(); physics.settle(360); geo.settle = false; draw(); } }

  /* ——— Frames: fixed-step physics behind requestAnimationFrame; it sleeps once the rope is still ——— */
  const fixed = value => Math.round(value * 10) / 10;
  function draw() {
    if (!physics || !geo) return;
    const points = physics.points();
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) { physics = null; measure('resize'); return; }
    let d = `M${fixed(points[0].x)} ${fixed(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) d += ` Q${fixed(points[i].x)} ${fixed(points[i].y)} ${fixed((points[i].x + points[i + 1].x) / 2)} ${fixed((points[i].y + points[i + 1].y) / 2)}`;
    d += ` L${fixed(points.at(-1).x)} ${fixed(points.at(-1).y)}`;
    for (const path of twine.querySelectorAll('path')) path.setAttribute('d', d);
    for (const [id, load] of loads) {
      if (!load.node) continue;
      const at = physics.sample(load.t), swing = physics.sampleLoad(id)?.angle || 0;
      if (id === 'tally') load.node.style.transform = `translate(${fixed(at.x)}px, ${fixed(at.y - geo.tally.lift)}px) translateX(-50%) rotate(${(0.07 - swing).toFixed(4)}rad) scale(${geo.tally.scale.toFixed(3)})`;
      else {
        load.node.style.transform = `translate(${fixed(at.x)}px, ${fixed(at.y - geo.ew * 0.02)}px) rotate(${(at.angle * 0.8).toFixed(4)}rad)`;
        load.swing.style.transform = `rotate(${(load.tilt - swing).toFixed(4)}rad)`;
      }
    }
  }
  function frame(now) {
    raf = 0;
    if (!sized()) { lastFrame = 0; return; }
    const dt = lastFrame ? Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)) : 1 / 60; lastFrame = now;
    let sliding = false;
    for (const load of loads.values()) {
      const gap = load.target - load.t;
      if (Math.abs(gap) > 0.0005) { load.t += gap * Math.min(1, dt * 5); sliding = true; } else load.t = load.target;
    }
    inFrame = true; pushLoads(); inFrame = false;
    physics.advance(dt); draw();
    quiet = !sliding && physics.activity() < QUIET_ACTIVITY ? quiet + 1 : 0;
    // At most one pending frame: pushLoads may already have scheduled the next one.
    if (quiet >= QUIET_FRAMES) lastFrame = 0; else if (!raf) raf = requestAnimationFrame(frame);
  }
  function wake() {
    quiet = 0;
    if (!physics || !sized()) return;
    if (reduced()) { for (const load of loads.values()) load.t = load.target; return; }
    // Only a wake from sleep restarts the clock; inside a frame, that frame schedules the next one.
    if (!raf && !inFrame) { lastFrame = 0; raf = requestAnimationFrame(frame); }
  }

  /* ——— Layout editing (operator preview only): drag an end, or focus it and use the arrow keys ——— */
  const handles = {};
  function placeHandles() {
    if (!controls) return;
    const layout = activeRope();
    for (const side of ['left', 'right']) {
      const handle = handles[side], end = geo[side === 'left' ? 'L' : 'R'], r = 22;
      handle.style.left = `${Math.min(geo.W - r, Math.max(r, end.x))}px`; handle.style.top = `${Math.min(geo.H - r, Math.max(r, end.y))}px`;
      const { x, y } = layout[side];
      handle.setAttribute('aria-label', `${side === 'left' ? 'Left' : 'Right'} end of the rope: ${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down. Drag it, or use the arrow keys.`);
    }
  }
  function moveEnd(side, x, y) {
    const next = moveRopeEnd(draft, side, x, y);
    if (sameRope(next, draft)) return;
    draft = next; relayout();
    ask({ type: 'sealed-layout-change', layout: draft });
  }
  function setEditing(on, layout) {
    draft = on ? ropeOf(layout ?? activeRope()) : null;
    // Just saved: keep showing it until a snapshot carries it, so an older poll cannot flash the old rope.
    held = !on && validRope(layout) ? { rope: validRope(layout), at: Date.now() } : null;
    document.body.classList.toggle('editing', on);
    for (const handle of Object.values(handles)) handle.hidden = !on;
    relayout(); syncControls();
  }
  if (controls) for (const side of ['left', 'right']) {
    const handle = el('button', `rope-handle ${side}`); handle.type = 'button'; handle.hidden = true; handle.dataset.side = side;
    handle.addEventListener('pointerdown', event => {
      if (!draft) return; event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.focus();
      const move = moving => moveEnd(side, moving.clientX / geo.W, moving.clientY / geo.H);
      const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); handle.classList.remove('dragging'); };
      handle.classList.add('dragging'); handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    });
    handle.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta || !draft) return; event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.01, { x, y } = draft[side];
      moveEnd(side, x + delta[0] * step, y + delta[1] * step);
    });
    handles[side] = handle; $('#line').after(handle);
  }

  /* ——— Covers ——— */
  function front(item) {
    const category = categoryOf(item.category_id, item.category), face = el('div', 'face env-front'), paper = el('div', 'env-paper');
    const stamp = el('span', 'stamp', iconFor(category)); stamp.style.setProperty('--category', categoryColor(category));
    const from = el('p', 'env-from', 'From '); from.append(el('b', '', fromName(item.display_name)));
    const when = el('p', 'env-when', 'Opens when '); when.append(el('b', '', text(item.moment_label || 'the moment', 80)));
    paper.append(stamp, el('span', 'postmark'), from, when);
    const condition = text(item.condition_label, 90);
    if (condition && condition !== item.moment_label) paper.append(el('p', 'env-cond', condition));
    face.append(paper); return face;
  }
  function envelope(item) { const env = el('div', 'env'); if (gold(item.payment_mode)) env.classList.add('gold'); env.append(front(item)); return env; }
  function hangingEnvelope(item) {
    const node = el('li', 'hang'), swing = el('div', 'swing');
    swing.append(el('span', 'pin'), envelope(item)); node.append(swing);
    node.dataset.id = item.id; node.dataset.sig = coverSig(item);
    return node;
  }
  function readyEnvelope(item) {
    const node = el('li', 'ready-item'), holder = controls ? el('button', 'ready-env') : el('div', 'ready-env');
    if (controls) {
      holder.type = 'button';
      holder.setAttribute('aria-label', `Open the envelope from ${fromName(item.display_name)} for ${text(item.moment_label || 'the moment', 80)}`);
      holder.onclick = () => { if (pending || show) return; pending = { id: item.id, at: Date.now() }; syncControls(); ask({ type: 'sealed-overlay-open', id: item.id }); };
    }
    holder.append(envelope(item)); node.append(holder);
    node.dataset.id = item.id; node.dataset.sig = coverSig(item);
    return node;
  }
  const rectOf = node => { const rect = node.querySelector('.env').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width }; };

  /* ——— The line ——— */
  function renderLine(items, total) {
    const visible = items.slice(0, LINE_MAX), more = Math.max(0, total - visible.length);
    // The count first: the tally's width decides how much rope the envelopes get.
    $('#more-count').hidden = !more; $('#more-count').textContent = more ? `+${more} more on the line` : '';
    placeTally();
    const ids = new Set(visible.map(item => item.id));
    for (const [id, node] of hung) if (!ids.has(id)) { unhang(id); leave(node); }
    // Envelopes share the rope left of the tally. When they do not fit side by side they overlap,
    // down to one stack on a very short rope; edges stay clear of the tally and inside the stage.
    const { ew, W } = geo, count = visible.length, usable = Math.max(0, geo.avail - ew);
    const spacing = count > 1 ? Math.min(ew * 1.3, usable / (count - 1)) : 0, overlap = spacing < ew * 1.02;
    const center = Math.min(Math.max(geo.left + geo.avail / 2, ew / 2 + 2), W - ew / 2 - 2);
    visible.forEach((item, index) => {
      let node = hung.get(item.id);
      if (node && node.dataset.sig !== coverSig(item)) { node.remove(); hung.delete(item.id); node = null; }
      const x = center + (index - (count - 1) / 2) * spacing;
      const fresh = !node; if (fresh) { node = hangingEnvelope(item); hung.set(item.id, node); }
      // Later envelopes lie on top; overlapping ones lean a little in turn about their pins so each edge shows.
      node.style.zIndex = String(index + 1);
      hold(`env:${item.id}`, node, node.firstChild, ropeT(x), ENVELOPE_MASS, ew / 1.55 / 2, overlap ? (index % 2 ? 0.05 : -0.035) : 0);
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      if (fresh && !reduced()) {
        node.querySelector('.env').animate([{ transform: `translateY(${-geo.ew * 0.9}px) rotate(-8deg)`, opacity: 0 }, { offset: 0.6, transform: 'translateY(4%) rotate(3deg)', opacity: 1 }, { transform: 'none' }], { duration: 900, easing: 'cubic-bezier(.3,.7,.2,1)' });
        node.querySelector('.pin').animate([{ transform: 'scaleY(1.25) translateY(-20%)' }, { transform: 'none' }], { duration: 380, delay: 420, easing: 'ease-out' });
      }
    });
    pushLoads(); if (!geo.settle) draw();
  }
  function leave(node) {
    if (reduced()) { node.remove(); return; }
    node.classList.add('leaving');
    node.animate([{ opacity: 1 }, { opacity: 0, translate: '0 -30%' }], { duration: 420, easing: 'ease-in' }).finished.then(() => node.remove(), () => node.remove());
  }

  /* ——— The ready row: declared envelopes waiting to be opened ——— */
  function renderReady(items, readyTotal = items.length) {
    const visible = items.slice(0, 8), ids = new Set(visible.map(item => item.id));
    for (const [id, node] of ready) if (!ids.has(id)) { ready.delete(id); leave(node); }
    const { W, H, rw, rh } = geo, count = visible.length;
    const spacing = count > 1 ? Math.min(rw * 1.12, (W * 0.86 - rw) / (count - 1)) : 0, baseY = H - rh / 2 - Math.max(geo.u * 2, 12);
    visible.forEach((item, index) => {
      let node = ready.get(item.id);
      if (node && node.dataset.sig !== coverSig(item)) { node.remove(); ready.delete(item.id); node = null; }
      const offset = index - (count - 1) / 2, x = W / 2 + offset * spacing, y = baseY + Math.abs(offset) * rh * 0.06;
      const fresh = !node; if (fresh) { node = readyEnvelope(item); ready.set(item.id, node); }
      node.style.setProperty('--x', `${x}px`); node.style.setProperty('--y', `${y}px`); node.style.setProperty('--r', `${offset * 3.2}deg`);
      node.style.zIndex = String(10 - Math.round(Math.abs(offset)));
      if (readyList.children[index] !== node) readyList.insertBefore(node, readyList.children[index] || null);
      if (fresh) {
        // Fly down from the line if it was hanging there; otherwise drop in from above.
        const source = hung.get(item.id), from = source ? rectOf(source) : null;
        if (source) { unhang(item.id); source.remove(); }
        if (!reduced()) node.querySelector('.env').animate([
          { transform: from ? `translate(${from.x - x}px, ${from.y - y}px) scale(${from.w / rw}) rotate(-6deg)` : `translate(0, ${-H * 0.5}px) rotate(-14deg)`, opacity: from ? 1 : 0 },
          { offset: .7, transform: `translate(0, ${-rh * 0.12}px) rotate(4deg)`, opacity: 1 }, { transform: 'none' }],
          { duration: 1000 + index * 90, easing: 'cubic-bezier(.3,.7,.2,1)' });
      }
    });
    const more = Math.max(0, readyTotal - visible.length);
    $('#ready-more').hidden = !more; $('#ready-more').textContent = more ? `+${more} more ready` : '';
    readyList.classList.toggle('dim', !!show);
    syncControls();
  }
  function syncControls() {
    if (pending && Date.now() - pending.at > 5000) pending = null;
    for (const button of readyList.querySelectorAll('button.ready-env')) button.disabled = !!pending || !!show || !!draft;
    const close = $('#close-note');
    if (close) { close.hidden = !(controls && manual && show && !show.leaving); close.disabled = !!pending; }
  }

  /* ——— Letter ——— */
  function letterFor(note) {
    const category = categoryOf(note.category_id, note.category), card = el('article', 'reveal-card letter');
    card.style.setProperty('--category', waxOf(category, note.payment?.mode));
    const head = el('header', 'letter-head'), title = el('div');
    title.append(el('strong', '', text(category.name || 'Note', 60)), el('em', 'reveal-subtitle', text(category.subtitle || 'A moment worth keeping', 80)));
    head.append(el('span', 'letter-icon', iconFor(category)), title);
    const footer = el('footer', 'reveal-footer');
    footer.append(el('span', 'reveal-author', `— ${fromName(note.display_name)}`),
      el('span', 'opened-for', note.never_opened ? 'This never happened' : `Opened for ${text(note.moment_label || 'the moment', 80)}`));
    card.append(head, el('p', 'reveal-body', text(note.body, 400)), footer);
    if (note.never_opened) card.classList.add('never-note');
    stampVerdict(card, note, false);
    return card;
  }
  function stampVerdict(card, note, animate) {
    const verdict = note.prediction_verdict?.verdict || note.prediction_verdict, existing = card.querySelector('.verdict');
    if (!['came_true', 'missed'].includes(verdict)) { existing?.remove(); return; }
    const label = verdict === 'came_true' ? 'CALLED IT' : 'MISSED';
    // An override only re-inks the stamp; the letter is never replayed.
    if (existing) { if (existing.textContent !== label) { existing.textContent = label; existing.classList.toggle('missed', verdict === 'missed'); } return; }
    const mark = el('div', `verdict${verdict === 'missed' ? ' missed' : ''}`, label); card.append(mark);
    if (animate && !reduced()) mark.animate([{ transform: 'rotate(-8deg) scale(2.2)', opacity: 0 }, { offset: .7, transform: 'rotate(-8deg) scale(.92)', opacity: 1 }, { transform: 'rotate(-8deg) scale(1)' }], { duration: 420, easing: 'ease-out' });
  }
  function seal(note) {
    const wax = el('div', 'seal'), category = categoryOf(note.category_id, note.category);
    wax.style.setProperty('--wax', waxOf(category, note.payment?.mode ?? note.payment_mode));
    wax.append(el('span', 'seal-half l'), el('span', 'seal-half r'), el('span', 'seal-mark', iconFor(category)));
    return wax;
  }

  /* ——— Opening ——— */
  // remaining: ms until an automatic exit (Infinity in manual mode). elapsed: ms already spent opening.
  function startShow(note, { remaining, elapsed }) {
    const root = el('div', 'show'); root.dataset.phase = 'opening';
    const token = { id: note.id, root, anims: new Set(), cancelled: false, timer: 0, leaving: false };
    stage.append(root);
    const letter = letterFor(note); token.letter = letter;
    const { W, H, ew } = geo, hasReady = ready.size > 0 && !ready.has(note.id) || ready.size > 1;
    const E = Math.min(Math.max(ew * 2.4, 230), W * 0.62, (H - (hasReady ? geo.rh : 0)) * 0.9), Eh = E / 1.55;
    const bandTop = geo.bottom + ew * 0.45, bandBottom = hasReady ? H - geo.rh - Math.max(geo.u * 3, 16) : H - 12;
    const cx = W / 2, cy = Math.max(bandTop + Eh / 2, Math.min((bandTop + bandBottom) / 2 + H * 0.04, bandBottom - Eh / 2));
    root.style.setProperty('--ew', `${E}px`);
    const box = node => Object.assign(node.style, { left: `${cx - E / 2}px`, top: `${cy - Eh / 2}px`, width: `${E}px`, height: `${Eh}px` });

    // Fly from the ready row, else from the line, else from above.
    const source = ready.get(note.id) || hung.get(note.id); let from = null;
    if (source) { const rect = rectOf(source); from = { x: rect.x, y: rect.y, s: rect.w / E }; ready.delete(note.id); unhang(note.id); source.remove(); }

    const run = (node, frames, options) => {
      if (token.cancelled) return Promise.reject(new Error('cancelled'));
      const animation = node.animate(frames, { fill: 'forwards', ...options }); token.anims.add(animation);
      return animation.finished;
    };
    const fire = (...args) => { run(...args).catch(() => {}); };
    const placeLetter = () => {
      letter.style.left = `${cx - geo.lw / 2}px`; root.append(letter);
      const height = letter.offsetHeight, mid = Math.min(cy, bandBottom - height / 2);
      const close = $('#close-note'), top = Math.max(8, mid - height / 2); letter.style.top = `${top}px`;
      if (close) { close.style.left = `${cx}px`; close.style.top = `${top + height + 44 < H ? top + height + 12 : Math.max(4, top - 40)}px`; }
      return { width: geo.lw, height, x: cx, y: parseFloat(letter.style.top) + height / 2 };
    };
    const reading = () => { root.dataset.phase = 'reading'; syncControls(); };
    if (Number.isFinite(remaining)) token.timer = setTimeout(() => exitShow(token, 'fade'), Math.max(0, remaining - FADE_MS));

    // Reduced motion, or already mostly opened elsewhere: show the letter, no flight.
    const factor = Math.min(1, Number.isFinite(remaining) ? (remaining - MIN_READ_MS - FADE_MS) / INTRO_MS : (INTRO_MS - elapsed) / INTRO_MS);
    if (reduced() || factor < 0.35) {
      placeLetter(); run(letter, [{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 160 : 260 }).then(reading, () => {});
      return token;
    }
    const t = ms => Math.round(ms * factor);

    // 1. Unpin or lift, travel, flip.
    const env3d = el('div', 'env3d'), env = el('div', 'env'), back = el('div', 'face back');
    if (gold(note.payment?.mode)) env.classList.add('gold');
    back.append(el('div', 'ob-pocket'), el('div', 'ob-flap'), seal(note));
    env.append(front(note), back); env.style.height = '100%'; env3d.append(env); box(env3d); root.append(env3d);
    env3d.style.perspective = `${E * 6}px`;
    const start = from ? `translate(${from.x - cx}px, ${from.y - cy}px) scale(${from.s})` : `translate(0, ${-H * 0.38}px) scale(.35)`;
    (async () => {
      await run(env3d, [{ transform: start, opacity: from ? 1 : 0 },
        { offset: .28, transform: from ? `translate(${(from.x - cx) * .9}px, ${(from.y - cy) * .9 - E * .12}px) scale(${from.s * 1.1}) rotate(-7deg)` : `translate(0, ${-H * 0.3}px) scale(.42) rotate(-5deg)`, opacity: 1 },
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 }], { duration: t(600), easing: 'cubic-bezier(.45,.05,.2,1)' });
      await run(env, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: t(280), easing: 'cubic-bezier(.5,0,.3,1)' });
      // 2. Flat layered back in the same box: base < letter < pocket < flap < seal.
      const base = el('div', 'ob-base'), pocket = el('div', 'ob-pocket'), flap = el('div', 'ob-flap'), sealBox = el('div', 'seal-box'), wax = seal(note);
      sealBox.append(wax);
      for (const [node, z] of [[base, 1], [pocket, 4], [flap, 5], [sealBox, 6]]) { box(node); node.style.zIndex = z; root.append(node); }
      if (gold(note.payment?.mode)) root.classList.add('gold');
      const final = placeLetter(); letter.style.zIndex = 3;
      env3d.remove();
      const sx = (E * 0.86) / final.width, sy = (Eh * 0.78) / final.height, inside = `translate(${cx - final.x}px, ${cy + Eh * 0.06 - final.y}px) scale(${sx}, ${sy})`;
      letter.style.transform = inside;
      // 3. The seal cracks.
      await run(wax, [{ transform: 'none' }, { offset: .35, transform: 'rotate(-6deg) scale(1.06)' }, { transform: 'rotate(4deg) scale(1.02)' }], { duration: t(110) });
      await Promise.all([run(wax.querySelector('.l'), [{ transform: 'none', opacity: 1 }, { transform: 'translate(-38%, 22%) rotate(-32deg)', opacity: 0 }], { duration: t(230), easing: 'cubic-bezier(.3,0,.6,1)' }),
        run(wax.querySelector('.r'), [{ transform: 'none', opacity: 1 }, { transform: 'translate(36%, 26%) rotate(28deg)', opacity: 0 }], { duration: t(230), easing: 'cubic-bezier(.3,0,.6,1)' }),
        run(wax.querySelector('.seal-mark'), [{ opacity: 1 }, { opacity: 0 }], { duration: t(110) })]);
      // 4. The flap opens up and over; it passes behind the letter at 90°.
      const persp = `perspective(${E * 6}px)`;
      await run(flap, [{ transform: `${persp} rotateX(0deg)`, zIndex: 5 }, { offset: .5, transform: `${persp} rotateX(90deg)`, zIndex: 5 }, { offset: .501, transform: `${persp} rotateX(90.5deg)`, zIndex: 2 }, { transform: `${persp} rotateX(180deg)`, zIndex: 2, filter: 'brightness(.9)' }], { duration: t(230), easing: 'ease-in-out' });
      // 5. The letter slides out of the pocket.
      const out = `translate(${cx - final.x}px, ${cy - Eh * 0.62 - final.y}px) scale(${sx}, ${sy})`;
      await run(letter, [{ transform: inside }, { transform: out }], { duration: t(360), easing: 'cubic-bezier(.3,.6,.25,1)' });
      // 6. The envelope drops away; the letter comes forward and unfolds.
      letter.style.zIndex = 7;
      for (const node of [base, pocket, flap]) fire(node, [{ opacity: 1, transform: node === flap ? `${persp} rotateX(180deg)` : 'none' }, { opacity: 0, transform: `translateY(${Eh * 0.5}px) ${node === flap ? `${persp} rotateX(180deg)` : ''}` }], { duration: t(320), easing: 'ease-in' });
      fire(letter, [{ opacity: .9 }, { opacity: 0 }], { duration: t(320), pseudoElement: '::after' });
      await run(letter, [{ transform: out }, { offset: .55, transform: `translate(0, ${-Eh * .08}px) scale(${(1 + sx) / 2}, ${sy * .9})` }, { transform: 'none' }], { duration: t(320), easing: 'cubic-bezier(.3,.7,.2,1)' });
      for (const node of [base, pocket, flap, sealBox]) node.remove();
      reading();
    })().catch(() => { /* A close, switch or reset cancelled this opening; exitShow cleans up. */ });
    return token;
  }
  // fade: automatic deadline. fall: the operator closed it, so it drops off the screen. fast: switch or reset.
  function exitShow(token, mode) {
    if (!token.root) return;
    if (token.leaving) { if (mode === 'fast') token.root.remove(); return; }
    token.leaving = true; clearTimeout(token.timer); token.cancelled = true; token.root.dataset.phase = 'exiting';
    for (const animation of token.anims) if (animation.playState === 'running') animation.pause();
    syncControls();
    if (reduced()) { token.root.remove(); return; }
    const frames = mode === 'fall'
      ? [{ transform: 'none', opacity: 1 }, { offset: .18, transform: `translateY(${-geo.H * 0.02}px) rotate(-2deg)`, opacity: 1 }, { transform: `translateY(${geo.H * 1.05}px) rotate(16deg)`, opacity: 1 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${mode === 'fast' ? 2 : 6}%) rotate(${mode === 'fast' ? 0 : 1.5}deg)` }];
    token.root.animate(frames, { duration: mode === 'fall' ? FALL_MS : mode === 'fast' ? 220 : FADE_MS, easing: mode === 'fall' ? 'cubic-bezier(.5,0,.85,.4)' : 'ease-in', fill: 'forwards' })
      .finished.then(() => token.root.remove(), () => token.root.remove());
  }

  /* ——— Wrap-up reel ——— */
  function showReel(state) {
    const key = state.reel ? String(state.reel.created_at) : null;
    const visible = !!state.reel && !state.current && !(state.queue?.length) && !(state.ready_envelopes?.length);
    if (visible && reel?.key === key) return;
    if (reel) { reel.node.remove(); reel = null; }
    if (!visible) return;
    const count = Number(state.reel.count) || 0, card = el('article', 'reveal-card letter reel-card');
    card.append(el('p', 'reel-count', String(count)), el('h2', '', 'This never happened.'), el('p', 'reveal-body', count ? 'Some moments are still worth waiting for.' : 'Every moment found its envelope.'));
    stage.append(card); reel = { key, node: card };
    if (!reduced()) card.animate([{ opacity: 0, transform: 'translate(-50%, -58%) rotate(-4deg)' }, { opacity: 1, transform: 'translate(-50%, -50%) rotate(-1.2deg)' }], { duration: 600, easing: 'cubic-bezier(.3,.7,.2,1)' });
  }

  /* ——— Snapshots ——— */
  // Polls and push refreshes can overlap. A snapshot older than the last applied one is
  // dropped, so a stale response can never reopen a closed note.
  async function refresh() {
    if (!load) return;
    let state;
    try { state = await load(); } catch { return; /* Keep the last frame through a short reconnect. */ }
    apply(state);
  }
  function apply(state, receivedAt = Date.now()) {
    if (!state || typeof state !== 'object') return;
    if (Number.isFinite(state.serverNow)) { if (state.serverNow < lastServerNow) return; lastServerNow = state.serverNow; }
    if (!geo || !sized()) { deferred = state; return; }   // shown on the next visible resize
    const fetchedAt = receivedAt;
    config = state.config || config;
    const serverRope = ropeOf(config.reveal?.rope);
    if (held && (sameRope(held.rope, serverRope) || Date.now() - held.at > 4000)) held = null;
    if (!sameRope(serverRope, rope) || (!held && !draft && !sameRope(serverRope, geo.shown))) { rope = serverRope; measure(); }
    manual = state.presentation_mode === 'manual';
    const total = Number(state.sealedCount) || 0;
    $('#sealed-count').textContent = `${total} ${total === 1 ? 'note' : 'notes'} sealed`;
    const note = state.current, now = Number.isFinite(state.serverNow) ? state.serverNow + (Date.now() - fetchedAt) : Date.now();
    if (show && (!note || note.id !== show.id)) { exitShow(show, note ? 'fast' : manual ? 'fall' : 'fade'); show = null; }
    if (pending && (note?.id === pending.id || !(state.ready_envelopes || []).some(item => item.id === pending.id))) pending = null;
    if (note && show?.id === note.id) { if (show.letter) stampVerdict(show.letter, note, true); }
    else if (note) {
      if (manual) {
        // Manual: open until it is closed; viewers who arrive late skip the part they missed.
        const revealedAt = Number(note.revealed_at);
        show = startShow(note, { remaining: Infinity, elapsed: Number.isFinite(revealedAt) ? Math.max(0, now - revealedAt) : 0 });
      } else {
        // Automatic: only a missing deadline falls back to 8 s; an expired one is never resurrected.
        const until = Number(state.current_until);
        const remaining = Number.isFinite(until) && until > 0 ? Math.min(until - now, 600000) : 8000;
        show = remaining > 0 ? startShow(note, { remaining, elapsed: 0 }) : { id: note.id, root: null, letter: null, leaving: true };
      }
    }
    const readyItems = (Array.isArray(state.ready_envelopes) ? state.ready_envelopes : []).filter(item => item && item.id !== note?.id).slice(0, 12);
    const readyIds = new Set(readyItems.map(item => item.id));
    const lineItems = (Array.isArray(state.sealed_envelopes) ? state.sealed_envelopes : []).filter(item => item && item.id !== note?.id && !readyIds.has(item.id)).slice(0, 12);
    // ready_envelopes is bounded; ready_count is the full number waiting to be opened.
    const readyTotal = Math.max(readyItems.length, Number(state.ready_count) || 0);
    last = { line: lineItems, ready: readyItems, readyTotal, total: Math.max(0, total - readyTotal) };
    renderReady(readyItems, readyTotal);   // first, so envelopes flying off the line start from their pins
    renderLine(lineItems, last.total);
    settleIfNeeded();
    showReel(state);
    syncControls();
  }

  if (controls) {
    const close = el('button', 'close-note', 'Close note'); close.id = 'close-note'; close.type = 'button'; close.hidden = true;
    close.onclick = () => { if (!show || pending) return; pending = { id: null, at: Date.now() }; syncControls(); ask({ type: 'sealed-overlay-close' }); };
    stage.after(close);
    // The parent console asks for an immediate refresh after it acts.
    addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.type === 'sealed-overlay-refresh') { if (!event.data.ok) pending = null; refresh(); }
      // Edit on: preview `layout` (or the current rope). Edit off: drop the preview; `layout` is what was just saved.
      if (event.data?.type === 'sealed-layout-edit') setEditing(event.data.on === true, event.data.layout ?? null);
    });
  }
  if (measure('resize')) settleIfNeeded();
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => relayout('resize'), 80); });
  if (load) { refresh(); setInterval(refresh, interval); }
  return { refresh, apply };
}
