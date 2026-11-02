/** Fixed windows bound per-identity work and total work, with bounded LRU storage. */
export class IngressLimiter {
  constructor({
    perIdentity = 40,
    global = 2000,
    capacity = 10000,
    windowMs = 1000,
  } = {}) {
    Object.assign(this, { perIdentity, global, capacity, windowMs });
    this.identities = new Map();
    this.window = -1;
    this.total = 0;
  }
  accept(identity, now = Date.now()) {
    const window = Math.floor(now / this.windowMs);
    if (window !== this.window) {
      this.window = window;
      this.total = 0;
      this.identities.clear();
    }
    const count = this.identities.get(identity) || 0;
    if (count >= this.perIdentity || this.total >= this.global) return false;
    this.identities.delete(identity);
    if (this.identities.size >= this.capacity)
      this.identities.delete(this.identities.keys().next().value);
    this.identities.set(identity, count + 1);
    this.total++;
    return true;
  }
}
