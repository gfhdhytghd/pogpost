/* Deterministic 2D cable + pendulum simulation. No DOM, clocks, random numbers or network.
   Pixel coordinates at the boundary; width-normalized units inside. Fixed-step Verlet
   integration and mass-weighted distance constraints (PBD) keep the cable stable. */
const STEP = 1 / 120;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const point = value => value && finite(value.x) && finite(value.y);
const copy = p => ({ x: p.x, y: p.y });
const signedSeed = id => { let hash = 7; for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; return hash % 2 ? 1 : -1; };

export class RopePhysics {
  constructor({ left, right, scale = 1000, nodes = 33, slack = 1.012, gravity = 1.05, damping = 0.982, iterations = 14 } = {}) {
    if (!point(left) || !point(right) || !finite(scale) || scale <= 0 || !Number.isInteger(nodes) || nodes < 8 || nodes > 65 ||
      !finite(slack) || slack < 1 || slack > 1.2 || !finite(gravity) || gravity < 0 || gravity > 10 ||
      !finite(damping) || damping <= 0 || damping >= 1 || !Number.isInteger(iterations) || iterations < 2 || iterations > 30) throw TypeError('Invalid rope parameters');
    Object.assign(this, { scale, count: nodes, slack, gravity, damping, iterations });
    this.loads = new Map(); this.accumulator = 0;
    this.setAnchors(left, right, { scale, snap: true });
  }
  setAnchors(left, right, { scale = this.scale, snap = false } = {}) {
    if (!point(left) || !point(right) || !finite(scale) || scale <= 0 || Math.hypot(right.x - left.x, right.y - left.y) < scale * 0.001) throw TypeError('Invalid rope anchors');
    this.scale = scale;
    this.left = { x: left.x / scale, y: left.y / scale };
    this.right = { x: right.x / scale, y: right.y / scale };
    const chord = Math.hypot(this.right.x - this.left.x, this.right.y - this.left.y);
    this.segmentLength = chord * this.slack / (this.count - 1);
    if (snap || !this.nodes) {
      const sag = chord * Math.sqrt((this.slack - 1) * 3 / 8);
      this.nodes = Array.from({ length: this.count }, (_, index) => {
        const t = index / (this.count - 1), x = this.left.x + (this.right.x - this.left.x) * t;
        const y = this.left.y + (this.right.y - this.left.y) * t + sag * 4 * t * (1 - t);
        return { x, y, px: x, py: y, inverseMass: 1 };
      });
      this.accumulator = 0;
      for (const load of this.loads.values()) { load.anchor = null; load.vx = load.vy = load.omega = load.angle = 0; }
    }
    this._masses(); this._pin();
  }
  setLoads(input = []) {
    if (!Array.isArray(input) || input.length > 64) throw TypeError('Invalid rope loads');
    const next = new Map();
    for (const entry of input) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || next.has(entry.id) || !finite(entry.t) || entry.t < 0 || entry.t > 1 ||
        !finite(entry.mass) || entry.mass <= 0 || entry.mass > 100 || (entry.length !== undefined && (!finite(entry.length) || entry.length <= 0))) throw TypeError('Invalid rope load');
      const old = this.loads.get(entry.id), load = old || { angle: 0, omega: signedSeed(entry.id) * 0.08, vx: 0, vy: 0, anchor: null };
      Object.assign(load, { id: entry.id, t: entry.t, mass: entry.mass, length: Math.max(0.015, (entry.length ?? this.scale * 0.07) / this.scale) });
      if (old && Math.abs(old.previousT - entry.t) > 0.03) { load.anchor = null; load.vx = load.vy = 0; }
      load.previousT = entry.t; next.set(entry.id, load);
    }
    const removed = [...this.loads.values()].filter(load => !next.has(load.id));
    const added = [...next.values()].filter(load => !this.loads.has(load.id));
    this.loads = next; this._masses();
    for (const load of removed) this.impulse(load.t, { x: 0, y: -this.scale * 0.065 });
    for (const load of added) this.impulse(load.t, { x: signedSeed(load.id) * this.scale * 0.008, y: this.scale * 0.035 });
  }
  _masses() {
    const mass = Array(this.count).fill(1);
    for (const load of this.loads.values()) {
      const f = load.t * (this.count - 1), i = Math.min(this.count - 2, Math.floor(f)), part = f - i;
      mass[i] += load.mass * (1 - part); mass[i + 1] += load.mass * part;
    }
    this.nodes.forEach((node, i) => { node.inverseMass = i === 0 || i === this.count - 1 ? 0 : 1 / mass[i]; });
  }
  _pin() {
    for (const [node, anchor] of [[this.nodes[0], this.left], [this.nodes.at(-1), this.right]]) Object.assign(node, { x: anchor.x, y: anchor.y, px: anchor.x, py: anchor.y });
  }
  impulse(t, velocity) {
    if (!finite(t) || t < 0 || t > 1 || !point(velocity)) throw TypeError('Invalid rope impulse');
    const center = t * (this.count - 1), vx = clamp(velocity.x / this.scale, -2, 2), vy = clamp(velocity.y / this.scale, -2, 2);
    for (let i = Math.max(1, Math.floor(center) - 2); i < Math.min(this.count - 1, Math.ceil(center) + 3); i++) {
      const weight = Math.max(0, 1 - Math.abs(i - center) / 3), node = this.nodes[i];
      node.px -= vx * STEP * weight; node.py -= vy * STEP * weight;
    }
  }
  advance(seconds) {
    if (!finite(seconds) || seconds < 0) return;
    // Hidden tabs do not accumulate minutes of unstable catch-up work.
    this.accumulator += Math.min(seconds, 0.1);
    const steps = Math.min(12, Math.floor((this.accumulator + 1e-10) / STEP));
    this.accumulator = Math.max(0, this.accumulator - steps * STEP);
    for (let n = 0; n < steps; n++) this._step();
  }
  _step() {
    for (let i = 1; i < this.count - 1; i++) {
      const node = this.nodes[i], vx = clamp((node.x - node.px) * this.damping, -3 * STEP, 3 * STEP), vy = clamp((node.y - node.py) * this.damping, -3 * STEP, 3 * STEP);
      node.px = node.x; node.py = node.y; node.x += vx; node.y += vy + this.gravity * STEP * STEP;
    }
    this._pin();
    for (let pass = 0; pass < this.iterations; pass++) {
      for (let j = 0; j < this.count - 1; j++) {
        const i = pass % 2 ? this.count - 2 - j : j, a = this.nodes[i], b = this.nodes[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy), mass = a.inverseMass + b.inverseMass;
        if (distance < 1e-12 || !mass) continue;
        const correction = (distance - this.segmentLength) / distance / mass;
        a.x += dx * correction * a.inverseMass; a.y += dy * correction * a.inverseMass;
        b.x -= dx * correction * b.inverseMass; b.y -= dy * correction * b.inverseMass;
      }
      this._pin();
    }
    for (const load of this.loads.values()) {
      const anchor = this._sample(load.t);
      if (load.anchor) {
        const vx = (anchor.x - load.anchor.x) / STEP, vy = (anchor.y - load.anchor.y) / STEP;
        const ax = clamp((vx - load.vx) / STEP, -8, 8), ay = clamp((vy - load.vy) / STEP, -8, 8);
        const acceleration = -((this.gravity + ay) * Math.sin(load.angle) + ax * Math.cos(load.angle)) / load.length - 3.6 * load.omega;
        load.omega = clamp(load.omega + acceleration * STEP, -6, 6);
        load.angle = clamp(load.angle + load.omega * STEP, -0.6, 0.6);
        load.vx = vx; load.vy = vy;
      }
      load.anchor = anchor;
    }
  }
  settle(steps = 360) {
    if (!Number.isInteger(steps) || steps < 0 || steps > 1200) throw TypeError('Invalid settling steps');
    for (let i = 0; i < steps; i++) this._step();
    for (const node of this.nodes) { node.px = node.x; node.py = node.y; }
    for (const load of this.loads.values()) { load.angle = load.omega = load.vx = load.vy = 0; load.anchor = this._sample(load.t); }
    this.accumulator = 0;
  }
  _sample(t) {
    const f = clamp(t, 0, 1) * (this.count - 1), i = Math.min(this.count - 2, Math.floor(f)), part = f - i;
    const a = this.nodes[i], b = this.nodes[i + 1];
    return { x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  sample(t) {
    if (!finite(t)) throw TypeError('Invalid rope position');
    const value = this._sample(t); return { x: value.x * this.scale, y: value.y * this.scale, angle: value.angle };
  }
  sampleLoad(id) {
    const load = this.loads.get(id); if (!load) return null;
    return { ...this.sample(load.t), angle: load.angle };
  }
  points() { return this.nodes.map(node => ({ x: node.x * this.scale, y: node.y * this.scale })); }
  activity() {
    let value = 0;
    for (const p of this.nodes) value += ((p.x - p.px) ** 2 + (p.y - p.py) ** 2) / (STEP * STEP);
    for (const load of this.loads.values()) value += load.omega ** 2 * 0.02;
    return value;
  }
}
