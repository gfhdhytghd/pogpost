import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { validateEventDefinitions } from './event-definitions.js';
import { debugCall } from './debug-hooks.js';

const freshTrack = lastPrompt => ({ yes: 0, no: 0, armed: false, latched: false, lastPrompt });
const fingerprint = definition => createHash('sha256').update(JSON.stringify(definition)).digest('hex');

/** Bounded visual evidence; accepting a candidate and declaring an event are separate operations. */
export class EventWatcher extends EventEmitter {
  constructor({ judgements, definitions = [], readObservation, now = Date.now,
    getSessionId = () => '', isActive = () => true, onCandidate,
    intervalMs = 2000, promptTtlMs = 30000, cooldownMs = 30000,
    adaptive = false, reviewConfidence = 0.6, reviewMode = 'screened', debugRecorder = null } = {}) {
    super();
    Object.assign(this, { judgements, readObservation, now, getSessionId, isActive });
    this.onCandidate = typeof onCandidate === 'function' ? onCandidate : null;
    this.adaptive = adaptive === true;
    if (!['screened', 'window'].includes(reviewMode)) throw Error('Unknown review mode. Use window or screened.');
    this.reviewMode = reviewMode;
    this.unavailableReviews = 0;
    this.debugRecorder = debugRecorder;
    if (!Number.isFinite(reviewConfidence) || reviewConfidence < 0.5 || reviewConfidence > 1) throw Error('Review confidence must be between 0.5 and 1.');
    this.reviewConfidence = reviewConfidence;
    this.intervalMs = this.adaptive ? 200 : Math.max(2000, Number(intervalMs) || 2000);
    this.lastScreenAt = -Infinity;
    this.screenRequests = 0;
    this.reviewRequests = 0;
    this.promptTtlMs = Math.max(1, Math.min(60000, Number(promptTtlMs) || 30000));
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 30000);
    this.frames = [];
    this.queue = [];
    this._tracks = new Map();
    this.lastPrompts = new Map();
    this.timer = null;
    this.busy = false;
    this.reading = false;
    this.closed = false;
    this.epoch = 0;
    this.sessionId = this.getSessionId();
    this.lastObservationId = null;
    this.highWaterAt = -Infinity;
    this.notBefore = this.now();
    this.lastAt = null;
    this.definitions = Object.freeze([]);
    this.setDefinitions(definitions);
  }
  get tracks() { return this._tracks; }
  setDefinitions(definitions) {
    const normalized = validateEventDefinitions(definitions).map(definition => Object.freeze({ ...definition }));
    if (JSON.stringify(normalized) === JSON.stringify(this.definitions)) return false;
    this.#pruneCooldowns();
    this.definitions = Object.freeze(normalized);
    this._tracks = new Map(normalized.map(definition => [definition.id, freshTrack(this.lastPrompts.get(definition.id) ?? -Infinity)]));
    this.reset('definitions_changed');
    return true;
  }
  // Cooldowns and observation high-water marks survive evidence resets.
  reset(reason = 'manual_reset', requestId = null) {
    debugCall(this.debugRecorder,'recordDecision',{kind:'reset',reason,epoch:this.epoch,request_id:requestId});
    this.epoch++;
    this.notBefore = this.now();
    this.frames = [];
    this.queue = [];
    this.lastAt = null;
    this.unavailableReviews = 0;
    for (const track of this._tracks.values()) { track.yes = 0; track.no = 0; track.armed = false; }
    this.sessionId = this.getSessionId();
  }
  #prune() { this.queue = this.queue.filter(item => item.expires_at > this.now()); }
  #pruneCooldowns() {
    // Definition validation caps every cooldown at one hour. Retain active entries
    // rather than evicting them, which would allow delete/re-add to bypass policy.
    for (const [id, at] of this.lastPrompts) if (this.now() - at >= 3600000) this.lastPrompts.delete(id);
  }
  #sessionChanged() { return this.sessionId !== this.getSessionId(); }
  #current(epoch, session, requestId = null) {
    if (this.closed || epoch !== this.epoch) {
      debugCall(this.debugRecorder,'recordDecision',{kind:'discard',reason:this.closed?'watcher_closed':'epoch_changed',epoch,request_id:requestId});
      return false;
    }
    if (session !== this.getSessionId() || !this.isActive()) { this.reset('session_changed_or_inactive',requestId); return false; }
    return true;
  }
  async observe(observation) {
    if (this.closed || (!this.adaptive && this.busy)) return null;
    if (this.#sessionChanged()) this.reset('session_changed');
    if (!this.isActive()) { this.reset('session_inactive'); return null; }
    const time = this.now();
    if (!observation || typeof observation.id !== 'string' || !observation.id || observation.id.length > 128 ||
      !Number.isFinite(observation.at) || observation.at < this.notBefore || observation.at > time || time - observation.at > 5000 ||
      typeof observation.dataUrl !== 'string' || observation.dataUrl.length > 4_000_000 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(observation.dataUrl)) {
      this.reset('capture_invalid_or_stale'); return null;
    }
    if (observation.id === this.lastObservationId) return null;
    if (observation.at <= this.highWaterAt) { this.reset('capture_time_regressed'); return null; }
    if (this.lastAt !== null && observation.at - this.lastAt > (this.adaptive ? 600 : 6000)) this.reset('capture_gap');
    this.lastObservationId = observation.id;
    this.highWaterAt = observation.at;
    this.lastAt = observation.at;
    this.frames = [...this.frames.filter(frame => observation.at - frame.at <= (this.adaptive ? 1000 : 8000)),
      { dataUrl: observation.dataUrl, at: observation.at, ...(this.debugRecorder?{id:observation.id}:{}) }].slice(this.adaptive ? -5 : -4);
    if (this.frames.length < (this.adaptive ? 5 : 2) || !this.definitions.length) return null;
    if (this.busy || (this.adaptive && time - this.lastScreenAt < 1000)) return null;
    if (this.adaptive && this.frames.some((frame, index, rows) => index && frame.at - rows[index - 1].at > 400)) return null;
    this.busy = true;
    const epoch = this.epoch, session = this.getSessionId(), definitions = this.definitions;
    const window = this.frames.map(frame => ({ ...frame }));
    let requestId = null;
    try {
      let result;
      try {
        if (this.adaptive && this.reviewMode === 'screened') {
          this.lastScreenAt = time;
          this.screenRequests++;
          requestId=debugCall(this.debugRecorder,'beginRequest',{stage:'screen',frames:[window.at(-1)],definitions});
          const screen = await this.judgements.eventScreen({ ...window.at(-1) }, definitions.map(definition => ({ ...definition })),{debugRequestId:requestId});
          debugCall(this.debugRecorder,'finishRequest',requestId,{normalized:screen,
            ...(this.judgements.debugRecorder===this.debugRecorder?{}:{outcome:screen?.valid?'ok':'unavailable'})});
          if (!this.#current(epoch, session, requestId)) return null;
          if (this.now() - observation.at > 5000 || !screen?.valid || screen.scene !== 'gameplay') {
            this.reset(this.now()-observation.at>5000?'stale_screen':!screen?.valid?'screen_unavailable':'non_gameplay_screen',requestId);return null;
          }
          let gateReason='review_not_required', gateEvent=null, gateConfidence=null, gateThreshold=null;
          const needsReview = definitions.some(definition => {
            const answer = screen.events?.[definition.id], track = this._tracks.get(definition.id);
            if (!Number.isFinite(answer?.confidence) || answer.confidence < 0 || answer.confidence > 1) return false;
            if (answer.choice === 'yes' && answer.confidence >= this.reviewConfidence) {
              gateReason='positive_screen_threshold';gateEvent=definition.id;gateConfidence=answer.confidence;gateThreshold=this.reviewConfidence;return true;
            }
            // Preserve the original two verified negative windows for baseline/rearm.
            // A single image never advances evidence, including negative evidence.
            const baseline=answer.choice === 'no' && answer.confidence >= definition.min_confidence &&
              (definition.mode === 'persistent' ? !track.armed : track.latched);
            if(baseline){gateReason='negative_baseline_or_rearm';gateEvent=definition.id;gateConfidence=answer.confidence;gateThreshold=definition.min_confidence;}
            return baseline;
          });
          debugCall(this.debugRecorder,'recordDecision',{kind:'gate',reason:gateReason,request_id:requestId,
            event_id:gateEvent,confidence:gateConfidence,threshold:gateThreshold});
          if (!needsReview) {
            for (const track of this._tracks.values()) { track.yes = 0; track.no = 0; }
            return null;
          }
          this.reviewRequests++;
        }
        if (this.adaptive && this.reviewMode === 'window') {
          this.lastScreenAt = time;
          this.reviewRequests++;
          debugCall(this.debugRecorder,'recordDecision',{kind:'gate',reason:'direct_window_review'});
        }
        requestId=debugCall(this.debugRecorder,'beginRequest',{stage:'review',frames:window,definitions});
        result = await this.judgements.eventFrames(window, definitions.map(definition => ({ ...definition })),{debugRequestId:requestId});
        debugCall(this.debugRecorder,'finishRequest',requestId,{normalized:result,
          ...(this.judgements.debugRecorder===this.debugRecorder?{}:{outcome:'ok'})});
      } catch {
        debugCall(this.debugRecorder,'finishRequest',requestId,{outcome:'judgement_exception'});
        if (this.#current(epoch, session, requestId)) {
          if (this.adaptive && this.reviewMode === 'window') this.#unavailable(requestId);
          else this.reset('judgement_exception',requestId);
        }
        return null;
      }
      if (!this.#current(epoch, session, requestId)) return null;
      // An unavailable/uncertain answer supplies no evidence. In demo window mode,
      // retain nearby captures for the next scheduled attempt instead of starving it.
      if (this.adaptive && this.reviewMode === 'window' && this.now() - observation.at <= 5000 &&
        (!result || (result.scene === 'unknown' && result.continuity === 'unknown'))) {
        this.#unavailable(requestId);
        return null;
      }
      this.unavailableReviews = 0;
      if (this.now() - observation.at > 5000 || result?.scene !== 'gameplay' || result?.continuity !== 'same') {
        this.reset(this.now()-observation.at>5000?'stale_review':result?.scene!=='gameplay'?'non_gameplay_review':'continuity_unverified',requestId);return null;
      }
      this.#prune();
      const proposals = [];
      for (const definition of definitions) {
        if (!this.#current(epoch, session, requestId) || this.now() - observation.at > 5000) return null;
        const track = this._tracks.get(definition.id), answer = result?.events?.[definition.id];
        if (answer === 'no') {
          track.yes = 0; track.no++;
          if (track.no >= 2) { track.armed = true; track.latched = false; }
          debugCall(this.debugRecorder,'recordDecision',{kind:'evidence',reason:'verified_negative',event_id:definition.id,request_id:requestId,
            yes_count:track.yes,no_count:track.no,armed:track.armed,latched:track.latched});
          continue;
        }
        track.no = 0;
        if (answer !== 'yes') { track.yes = 0;
          debugCall(this.debugRecorder,'recordDecision',{kind:'evidence',reason:'review_unsure',event_id:definition.id,request_id:requestId,
            yes_count:track.yes,no_count:track.no,armed:track.armed,latched:track.latched});continue; }
        track.yes++;
        debugCall(this.debugRecorder,'recordDecision',{kind:'evidence',reason:'verified_positive',event_id:definition.id,request_id:requestId,
          yes_count:track.yes,no_count:track.no,armed:track.armed,latched:track.latched});
        if (definition.mode === 'instant' ? track.latched : (!track.armed || track.yes < 2)) continue;
        // Suppressed evidence is consumed rather than resurfacing from the same persistent positive.
        track.armed = false; track.latched = true; track.yes = 0;
        const evidence = 'Observed a matching visual event window. Human confirmation is required.';
        if (this.onCandidate) {
          let accepted;
          try {
            accepted = await this.onCandidate(definition.id, { source: 'ai', observedAt: observation.at,
              evidence, definitionFingerprint: fingerprint(definition) });
          } catch {
            if (this.#current(epoch, session, requestId)) this.reset('candidate_exception',requestId);
            return null;
          }
          if (!this.#current(epoch, session, requestId)) return null;
          debugCall(this.debugRecorder,'recordDecision',{kind:'candidate',reason:accepted?'candidate_accepted':'candidate_suppressed',event_id:definition.id,request_id:requestId});
          if (accepted) proposals.push(accepted);
          continue;
        }
        const cooldown = Number.isFinite(definition.cooldown_s) ? definition.cooldown_s * 1000 : this.cooldownMs;
        if (this.now() - track.lastPrompt < cooldown || this.queue.some(item => item.event_id === definition.id)) continue;
        this.#pruneCooldowns();
        if (!this.lastPrompts.has(definition.id) && this.lastPrompts.size >= 512) continue;
        const proposal = { id: randomUUID(), event_id: definition.id, kind: definition.id, moment_id: definition.id,
          source: 'ai', needs_confirmation: true, label: definition.label, evidence, observed_at: observation.at,
          created_at: this.now(), expires_at: this.now() + this.promptTtlMs, definitionFingerprint: fingerprint(definition) };
        this.queue.push(proposal);
        track.lastPrompt = this.now();
        this.lastPrompts.set(definition.id, track.lastPrompt);
        proposals.push(proposal);
        this.emit('confirmation', { ...proposal });
        debugCall(this.debugRecorder,'recordDecision',{kind:'candidate',reason:'candidate_accepted',event_id:definition.id,request_id:requestId});
      }
      if (this.queue.length > 12) this.queue.splice(0, this.queue.length - 12);
      return proposals.length ? proposals : null;
    } finally { this.busy = false; }
  }
  #unavailable(requestId) {
    for (const track of this._tracks.values()) { track.yes = 0; track.no = 0; }
    this.unavailableReviews++;
    debugCall(this.debugRecorder,'recordDecision',{kind:'discard',reason:'review_unavailable',request_id:requestId});
    // Bound retention of any verified baseline through repeated provider failures.
    if (this.unavailableReviews >= 3) this.reset('repeated_review_unavailable', requestId);
  }
  /** Capture fencing starts before awaiting a source, including completion-stamped observations. */
  async capture() {
    if (this.closed || (!this.adaptive && this.busy) || this.reading || typeof this.readObservation !== 'function') return null;
    if (this.#sessionChanged()) this.reset('session_changed');
    if (!this.isActive()) { this.reset('session_inactive'); return null; }
    this.reading = true;
    const epoch = this.epoch, session = this.getSessionId();
    let observation;
    try {
      observation = await this.readObservation();
      if (!this.#current(epoch, session)) return null;
    } catch {
      if (this.#current(epoch, session)) this.reset('capture_exception');
      return null;
    } finally { this.reading = false; }
    return await this.observe(observation);
  }
  start() {
    if (this.closed || this.timer || typeof this.readObservation !== 'function') return false;
    this.timer = setInterval(() => { void this.capture(); }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }
  prompts() {
    if (this.#sessionChanged() || !this.isActive()) this.reset('session_changed_or_inactive');
    this.#prune();
    return this.queue.map(item => ({ ...item }));
  }
  confirm(id) {
    this.prompts();
    if (this.closed) return null;
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) return null;
    const [item] = this.queue.splice(index, 1);
    return { id: item.id, moment_id: item.moment_id, label: item.label, expires_at: item.expires_at };
  }
  state() { return { profile: 'events', enabled: !!this.timer, busy: this.busy || this.reading,
    pending: this.prompts().length, needs_confirmation: true, frame_count: this.frames.length,
    interval_ms: this.intervalMs, definition_count: this.definitions.length,
    ...(this.adaptive ? { strategy: this.reviewMode === 'window' ? 'direct_window' : 'single_then_window', capture_hz: 5, screen_interval_ms: 1000,
      review_frames: 5, review_confidence: this.reviewConfidence, screen_requests: this.screenRequests, review_requests: this.reviewRequests } : {}) }; }
  close() { this.closed = true; clearInterval(this.timer); this.timer = null; this.reset('watcher_closed'); this.removeAllListeners(); }
}
