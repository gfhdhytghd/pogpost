import { createHash, randomUUID } from 'node:crypto';
import { eventProfileContext } from './event-profiles.js';

const fail = (status, code) => { throw Object.assign(Error(code), { status, code }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = definition => hash(definition);
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(value);
const MAX_RECEIPTS = 512;
const TTL = 30000;

/** Shared private candidate ledger: model observations and authenticated local triggers use one cooldown. */
export class EventSystem {
  constructor({ engine, now = Date.now } = {}) {
    this.engine = engine;
    this.now = now;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.generation=0;
  }
  #enqueue(operation) {
    if (this.pending >= 32) return Promise.reject(Object.assign(Error('events_busy'), { status: 429, code: 'events_busy' }));
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  #runtime() {
    return this.engine.state.event_runtime ??= { receipts: [], cooldowns: {}, candidates: [] };
  }
  #definition(id) { return this.engine.config.events?.find(definition => definition.id === id); }
  #valid(candidate) {
    const def = this.#definition(candidate.event_id);
    return !!def && candidate.fingerprint === fingerprint(def) && candidate.session_id === this.engine.state.session.id &&
      (candidate.profileContext ?? '') === eventProfileContext(this.engine.state.event_profile_active_ref,this.engine.state.event_profile_context_epoch) &&
      this.engine.state.session.wrapped_at === null && this.now() < candidate.expires_at;
  }
  prompts() {
    const candidates = this.engine.state.event_runtime?.candidates || [];
    return candidates.filter(candidate => this.#valid(candidate)).map(candidate => ({
      id: candidate.id, kind: candidate.event_id, moment_id: candidate.event_id, label: candidate.label,
      source: candidate.source, needs_confirmation: true, observed_at: candidate.observed_at,
      created_at: candidate.created_at, expires_at: candidate.expires_at, evidence: candidate.evidence,
    }));
  }
  async reset() {
    this.generation++;
    return this.engine._mutate(() => { this.#runtime().candidates = []; return { reset: true }; });
  }
  async confirm(id) {
    return this.engine._mutate(() => {
      const runtime = this.#runtime();
      const candidate = runtime.candidates.find(item => item.id === id);
      runtime.candidates = runtime.candidates.filter(item => item.id !== id && this.#valid(item));
      if (!candidate || !this.#valid(candidate)) return null;
      return { id: candidate.id, moment_id: candidate.event_id, label: candidate.label,
        source:candidate.source,context: candidate.context, expectedSessionId: candidate.session_id, expires_at: candidate.expires_at,
        expectedProfileContext: candidate.profileContext ?? '',
        definitionFingerprint: candidate.fingerprint };
    });
  }
  trigger(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['event_id', 'context', 'idempotency_key'].includes(key)) ||
      !validId(body.event_id) || typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.idempotency_key) ||
      body.context !== undefined && (typeof body.context !== 'string' || [...body.context].length > 1200))
      return Promise.reject(Object.assign(Error('invalid_event_trigger'), { status: 400, code: 'invalid_event_trigger' }));
    const generation=this.generation;
    const expectedSessionId=this.engine.state.session.id;
    const profileContext=eventProfileContext(this.engine.state.event_profile_active_ref,this.engine.state.event_profile_context_epoch);
    const definition=this.#definition(body.event_id);
    if(!definition)return Promise.reject(Object.assign(Error('event_not_found'),{status:404,code:'event_not_found'}));
    return this.#enqueue(() => this.#accept(body.event_id, { source: 'api', context: body.context || '', key: body.idempotency_key,generation,
      expectedSessionId,profileContext,definitionFingerprint:fingerprint(definition) }));
  }
  propose(eventId, { source = 'ai', observedAt = this.now(), definitionFingerprint } = {}) {
    // Evidence is a fixed local sentence: never store/echo arbitrary model prose or screenshot data.
    if (source !== 'ai' || !validId(eventId) || !Number.isFinite(observedAt) || observedAt > this.now() || this.now() - observedAt > 5000) return Promise.resolve(null);
    const expectedSessionId=this.engine.state.session.id;
    const profileContext=eventProfileContext(this.engine.state.event_profile_active_ref,this.engine.state.event_profile_context_epoch);
    const generation=this.generation;
    definitionFingerprint??=this.#definition(eventId)?fingerprint(this.#definition(eventId)):undefined;
    return this.#enqueue(() => this.#accept(eventId, { source: 'ai', context: '', key: 'ai:' + randomUUID(), observedAt, definitionFingerprint, expectedSessionId,profileContext,generation }))
      .catch(error => { if ([404, 409, 429].includes(error.status)) return null; throw error; });
  }
  async #accept(eventId, { source, context, key, observedAt = this.now(), definitionFingerprint, expectedSessionId,profileContext,generation }) {
    const receiptKey = hash(key);
    const requestFingerprint = hash({ event_id: eventId, context });
    const accepted = await this.engine._mutate(() => {
      if(profileContext!==eventProfileContext(this.engine.state.event_profile_active_ref,this.engine.state.event_profile_context_epoch))fail(409,'stale_profile_context');
      const def = this.#definition(eventId);
      if (!def) fail(404, 'event_not_found');
      if(generation!==this.generation)fail(409,'stale_event_trigger');
      if (definitionFingerprint !== undefined && definitionFingerprint !== fingerprint(def)) fail(409, 'event_definition_changed');
      const session = this.engine.state.session;
      if (session.wrapped_at !== null) fail(409, 'session_wrapped');
      if(expectedSessionId!==undefined&&expectedSessionId!==session.id || source==='ai'&&(observedAt>this.now()||this.now()-observedAt>5000)) fail(409,'stale_event_trigger');
      const runtime = this.#runtime();
      runtime.candidates = runtime.candidates.filter(candidate => this.#valid(candidate));
      const previous = runtime.receipts.find(receipt => receipt.key === receiptKey);
      if (previous) {
        if (previous.request !== requestFingerprint) fail(409, 'idempotency_conflict');
        if (previous.session_id !== session.id) fail(409, 'stale_event_trigger');
        if(previous.result.status==='rejected')fail(409,previous.result.error||'event_trigger_failed');
        return { ...previous.result, duplicate: true };
      }
      // Never evict a current-session key: an old retry must not become a second event.
      if(source==='api'&&runtime.receipts.filter(receipt=>receipt.session_id===session.id).length>=MAX_RECEIPTS)fail(429,'events_history_full');
      const cooldown = runtime.cooldowns[eventId];
      if (cooldown && this.now() < cooldown.until || runtime.candidates.some(candidate => candidate.event_id === eventId)) fail(429, 'event_cooldown');
      const id = randomUUID(), expiresAt = this.now() + TTL;
      const auto = source === 'api' && def.auto_confirm === true;
      const result = { event_id: eventId, receipt_id: id, session_id: session.id,
        status: auto ? 'pending_auto' : 'candidate', ...(auto ? {} : { candidate_id: id }), expires_at: expiresAt };
      runtime.cooldowns[eventId] = { at: this.now(),until:this.now()+def.cooldown_s*1000 };
      // Bound cooldown storage when definitions are replaced; active definitions retain their cooldowns.
      const activeIds = new Set(this.engine.config.events.map(item => item.id));
      for (const [event, value] of Object.entries(runtime.cooldowns))
        if (!activeIds.has(event) && this.now() - value.at >= 3600000) delete runtime.cooldowns[event];
      if (Object.keys(runtime.cooldowns).length > 512) fail(429, 'events_history_full');
      if(source==='api'){
        runtime.receipts.push({ key: receiptKey, request: requestFingerprint, session_id: session.id, result });
        while(runtime.receipts.length>MAX_RECEIPTS){const old=runtime.receipts.findIndex(receipt=>receipt.session_id!==session.id);runtime.receipts.splice(old,1);}
      }
      if (!auto) runtime.candidates.push({ id, event_id: eventId, label: def.label,
        fingerprint: fingerprint(def), session_id: session.id, source, context,profileContext,
        evidence: source === 'ai' ? 'Picture evidence matched the configured event. Confirm only what you observed.' : 'An authenticated local event source requested this event. Confirm only what you observed.',
        observed_at: observedAt, created_at: this.now(), expires_at: expiresAt });
      return { duplicate: false, ...result, auto, definitionFingerprint: fingerprint(def),profileContext };
    });
    if (accepted.duplicate || !accepted.auto) {
      const { auto, definitionFingerprint: acceptedFingerprint, profileContext: acceptedProfileContext, ...publicResult } = accepted;
      return publicResult;
    }
    try {
      await this.engine.occur(eventId, { summary: context || 'Authenticated event API trigger.', event_id: 'events:' + accepted.receipt_id }, 'api-auto', {
        expectedSessionId: accepted.session_id, expiresAt: accepted.expires_at,
        expectedEventDefinition: accepted.definitionFingerprint,
        expectedProfileContext: accepted.profileContext,
      });
      accepted.status = 'occurred';
    } catch (error) {
      accepted.status = 'rejected';
      accepted.error = ['stale_confirmation', 'session_wrapped', 'event_definition_changed', 'stale_profile_context'].includes(error.code) ? error.code : 'event_trigger_failed';
    }
    const { auto, definitionFingerprint: acceptedFingerprint, profileContext: acceptedProfileContext, ...publicResult } = accepted;
    await this.engine._mutate(() => {
      const receipt = this.#runtime().receipts.find(item => item.key === receiptKey);
      if (receipt) receipt.result = publicResult;
      return null;
    });
    if (accepted.status === 'rejected') fail(409, accepted.error);
    return publicResult;
  }
}
