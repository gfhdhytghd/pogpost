import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import legacyFramePreset from '../presets/generic-legacy.json' with { type: 'json' };

const EVENTS = new Set(Object.keys(legacyFramePreset.events));
const MOMENTS = Object.freeze(Object.fromEntries(Object.entries(legacyFramePreset.events).map(([id,event])=>[id,event.moment_id])));
const LABELS = Object.freeze(Object.fromEntries(Object.entries(legacyFramePreset.events).map(([id,event])=>[id,event.label])));

/** Frames only propose confirmations; this class never declares an occurred moment. */
export class FrameWatcher extends EventEmitter {
  constructor({ judgements, readFrame, intervalMs = 2000, onConfirmation, momentMapping = MOMENTS, now = Date.now, promptTtlMs = 60000,
    events = EVENTS, labels = LABELS } = {}) {
    super();
    this.judgements = judgements;
    this.readFrame = readFrame;
    this.intervalMs = Math.max(2000, Number(intervalMs) || 2000);
    this.last = 'unsure';
    this.streak = 0;
    this.prompted = null;
    this.timer = null;
    this.busy = false;
    this.closed = false;
    this.reading = false;
    this.queue = [];
    this.momentMapping = { ...momentMapping };
    this.now = now;
    this.promptTtlMs = Math.max(1, Math.min(60000, Number(promptTtlMs) || 60000));
    this.events = events;
    this.labels = labels;
    if (onConfirmation) this.on('confirmation', onConfirmation);
  }
  async observe(image) {
    if (this.closed || this.busy) return null;
    this.busy = true;
    try {
      let result;
      try { result = await this.judgements.frame(image); } catch { result = 'unsure'; }
      if (this.closed) return null;
      this.streak = result === this.last ? this.streak + 1 : 1;
      this.last = result;
      if (!this.events.has(result)) { this.prompted = null; return null; }
      if (this.streak < 2 || this.prompted === result) return null;
      this.prompted = result;
      const moment_id = this.momentMapping[result];
      if (typeof moment_id !== 'string' || !moment_id) return null;
      this.#prune();
      if (this.queue.some((item) => item.kind === result)) return null;
      const proposal = { id: randomUUID(), kind: result, moment_id, source: 'ai', needs_confirmation: true,
        label: this.labels[result], created_at: this.now(), expires_at: this.now() + this.promptTtlMs };
      this.queue.push(proposal);
      if (this.queue.length > 8) this.queue.shift();
      this.emit('confirmation', proposal);
      return proposal;
    } finally { this.busy = false; }
  }
  start() {
    if (this.closed || this.timer || typeof this.readFrame !== 'function') return false;
    this.timer = setInterval(async () => {
      if (this.busy || this.reading || this.closed) return;
      this.reading = true;
      try { await this.observe(await this.readFrame()); } catch { this.last = 'unsure'; this.streak = 0; this.prompted = null; }
      finally { this.reading = false; }
    }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  #prune() { this.queue = this.queue.filter((item) => item.expires_at > this.now()); }
  prompts() { this.#prune(); return this.queue.map((item) => ({ ...item })); }
  confirm(id) {
    this.#prune();
    const index = this.queue.findIndex((item) => item.id === id);
    if (index < 0 || this.closed) return null;
    const [item] = this.queue.splice(index, 1);
    return { id: item.id, moment_id: item.moment_id, label: item.label };
  }
  close() { this.closed = true; this.stop(); this.queue = []; this.removeAllListeners(); }
  state() { return { enabled: !!this.timer, source_configured: typeof this.readFrame === 'function', busy: this.busy || this.reading, needs_confirmation: true, pending: this.prompts().length }; }
}

/** Local transcripts only. No microphone capture or speech recognition runs here. */
export class SpeechWatcher extends FrameWatcher {
  constructor({ judgements, readTranscript, momentMapping = { blames_game: 'ai-blames-game', boast: 'ai-boast', laughing: 'ai-laughing' }, ...options } = {}) {
    super({ ...options, readFrame: readTranscript, judgements: { frame: (chunk) => judgements.speech(typeof chunk === 'string' ? chunk : chunk?.text) }, momentMapping,
      events: new Set(['blames_game', 'boast', 'laughing']), labels: { blames_game: 'Streamer blames the game', boast: 'Streamer boasts', laughing: 'Streamer laughs' } });
    this.lastChunkId = null;
  }
  observe(chunk) {
    if (!chunk || (typeof chunk !== 'string' && typeof chunk.text !== 'string')) return Promise.resolve(null);
    if (typeof chunk === 'object' && chunk.id) {
      if (chunk.id === this.lastChunkId) return Promise.resolve(null);
      this.lastChunkId = chunk.id;
    }
    return super.observe(chunk);
  }
}
