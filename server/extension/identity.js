import { safeText } from "../../engine/content.js";

/** Only verified shared IDs reach Helix; bounded cache and concurrent work. */
export class ExtensionNames {
  constructor(resolveName = async () => null, now = Date.now) {
    Object.assign(this, { resolveName, now });
    this.cache = new Map();
    this.active = 0;
  }
  async get(userId) {
    if (!userId) return "a viewer";
    const saved = this.cache.get(userId);
    if (saved && saved.until > this.now()) return saved.value;
    if (this.active >= 32) return "a viewer";
    this.active++;
    const lookup = Promise.resolve()
      .then(() => this.resolveName(userId))
      .finally(() => {
        this.active--;
      });
    const value = (async () => {
      let timer;
      try {
        const name = await Promise.race([
          lookup,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), 1200);
          }),
        ]);
        return safeText(name, "a viewer", 24);
      } catch {
        return "a viewer";
      } finally {
        clearTimeout(timer);
      }
    })();
    if (this.cache.size >= 512)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(userId, { until: this.now() + 300000, value });
    return value;
  }
}
