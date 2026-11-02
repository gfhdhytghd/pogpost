import { EventWatcher } from './event-watcher.js';
import preset from '../presets/ksp.json' with { type: 'json' };

export const KSP_EVENTS = Object.freeze(Object.fromEntries(preset.events.map(definition =>
  [definition.id.replace(/^ksp-/, ''), Object.freeze({ id: definition.id, label: definition.label, evidence: definition.description })])));
export const KSP_MOMENTS = Object.freeze(Object.values(KSP_EVENTS).map(({ id, label }) =>
  Object.freeze({ id, label, kind: 'ai', long_lived: false })));
const legacyKind = id => Object.entries(KSP_EVENTS).find(([, value]) => value.id === id)?.[0] || id;
const legacyPrompt = prompt => ({ ...prompt, kind: legacyKind(prompt.kind) });

/** Compatibility names and judge shape only; observation state lives in EventWatcher. */
export class KSPWatcher extends EventWatcher {
  constructor({ judgements, cooldownMs, ...options } = {}) {
    // Legacy callers retain their historical latch semantics. The production event
    // system consumes the current demo-oriented preset directly.
    const definitions = preset.events.map(definition => ({ ...definition,
      mode: definition.id === 'ksp-explosion' ? 'instant' : 'persistent',
      ...(cooldownMs === undefined ? {} : { cooldown_s: Math.ceil(Math.max(30000, Number(cooldownMs) || 30000) / 1000) }) }));
    super({ ...options, cooldownMs, definitions, judgements: { async eventFrames(frames, events) {
      if (typeof judgements?.eventFrames === 'function') return judgements.eventFrames(frames, events);
      const result = await judgements.kspFrames(frames);
      return { ...result, scene: result?.scene === 'flight' ? 'gameplay' : result?.scene,
        events: Object.fromEntries(Object.entries(KSP_EVENTS).map(([kind, spec]) => [spec.id, result?.events?.[kind]])) };
    } } });
  }
  get tracks() { return new Map(Object.entries(KSP_EVENTS).map(([kind, spec]) => [kind, this._tracks.get(spec.id)])); }
  emit(name, ...args) { return super.emit(name, ...(name === 'confirmation' ? args.map(legacyPrompt) : args)); }
  async observe(observation) { const proposals = await super.observe(observation); return proposals?.map(legacyPrompt) || null; }
  prompts() { return super.prompts().map(legacyPrompt); }
  state() { return { ...super.state(), profile: 'ksp' }; }
}
