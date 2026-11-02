import { randomUUID, createHash } from 'node:crypto';
import { DEFAULT_CONFIG, TEST_MODE_LABEL, BIT_TIERS, validateConfig, domainError } from './config.js';
import { MemoryStore } from './store.js';
import { groupMomentChoices } from '../public/moment-choices.js';
import { validateEventDefinition, validateEventDefinitions } from './event-definitions.js';
import { listEventPresets } from './event-presets.js';
import { MAX_EVENT_PROFILES, validateEventProfileInput, validateStoredEventProfiles, validateEventProfileActiveRef, validateEventProfileSelection, eventProfileHash, profileLabelKey, eventProfileContext, validateEventProfileContextEpoch } from './event-profiles.js';
import { validateCondition, conditionExpired, conditionMatches } from './conditions.js';
import { createTextPolicy, normalizeText } from '../engine/content.js';

const clone = value => structuredClone(value);
const fail = (code, message, status = 400) => { throw domainError(code, message, status); };
const ACTIVE = new Set(['sealed', 'held', 'pending_review']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const newSession = now => ({ id: randomUUID(), started_at: now, wrapped_at: null });
const fresh = now => ({ schema: 1, config: clone(DEFAULT_CONFIG), session: newSession(now), sessions: [], notes: [], occurrences: [], occurrence_sequence: 0, wallets: {}, identities: { opaque: {}, users: {} }, idempotency: [], events: [], queue: [], current_id: null, current_until: null, reel: null, event_profiles: [], event_profile_active_ref: null, event_profile_context_epoch: 0 });

/** Domain methods serialize decisions, wallet changes, and durable snapshots together. */
export class NotesEngine {
  constructor({ store = new MemoryStore(), decisions, payments, publisher, now = Date.now } = {}) {
    this.store = store;
    this.decisions = decisions;
    this.livePayments = payments;
    this.publisher = publisher;
    this.now = now;
    this.state = store.read() ?? fresh(now());
    this.state.config = validateConfig(this.state.config, this.state.config);
    this.state.event_profiles = validateStoredEventProfiles(Object.hasOwn(this.state, 'event_profiles') ? this.state.event_profiles : []);
    this.state.event_profile_context_epoch = validateEventProfileContextEpoch(Object.hasOwn(this.state, 'event_profile_context_epoch') ? this.state.event_profile_context_epoch : 0);
    this.state.event_profile_active_ref = validateEventProfileActiveRef(Object.hasOwn(this.state, 'event_profile_active_ref') ? this.state.event_profile_active_ref : null, this.state.event_profiles);
    for (const note of this.state.notes) if (note.sealed_at !== null && !note.category_snapshot) note.category_snapshot = clone(this.state.config.categories.find(category => category.id === note.category_id) ?? { id: note.category_id, name: note.category_id });
    this._tail = Promise.resolve();
    this._pending = 0;
    // A process restart retains the visible reveal and pending metadata-only queue.
    this.store.replace(this.state);
  }
  get config() { return clone(this.state.config); }
  _mutate(operation) {
    if (this._pending >= 32) return Promise.reject(domainError('engine_busy', 'The notes queue is full. Try again shortly.', 429));
    this._pending++;
    const next = this._tail.then(async () => {
      const previous = this.state;
      this.state = clone(previous);
      try {
        const result = await operation();
        this.store.replace(this.state);
        return clone(result);
      } catch (error) { this.state = previous; throw error; }
    }).finally(() => { this._pending--; });
    this._tail = next.catch(() => {});
    return next;
  }
  _identity(identity) {
    if (!identity || typeof identity.opaqueId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(identity.opaqueId)) fail('identity_required', 'A viewer identity is required.', 401);
    if (identity.userId !== undefined && identity.userId !== null && (typeof identity.userId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(identity.userId))) fail('invalid_identity', 'Invalid linked identity.', 401);
    return identity;
  }
  _accountKeys(identity) {
    const ids = this.state.identities;
    const get = (map, key) => key && Object.hasOwn(map, key) ? map[key] : undefined;
    return new Set([get(ids.users, identity.userId), get(ids.opaque, identity.opaqueId)].filter(Boolean));
  }
  _mergeAccount(source, target) {
    if (!source || source === target) return;
    for (const wallets of Object.values(this.state.wallets)) {
      if (!Object.hasOwn(wallets, source)) continue;
      if (!Object.hasOwn(wallets, target)) wallets[target] = wallets[source];
      else {
        // Identity sharing combines spending; it never grants a second wallet allowance.
        wallets[target].points += wallets[source].points - 10000;
        wallets[target].bits += wallets[source].bits - 1000;
      }
      delete wallets[source];
    }
    for (const map of Object.values(this.state.identities)) for (const [id, key] of Object.entries(map)) if (key === source) map[id] = target;
    for (const note of this.state.notes) {
      if (note.account_id === source) note.account_id = target;
      if (note.payment_account_id === source) note.payment_account_id = target;
    }
  }
  _account(identity) {
    this._identity(identity);
    const ids = this.state.identities;
    const get = (map, key) => key && Object.hasOwn(map, key) ? map[key] : undefined;
    const opaqueAccount = get(ids.opaque, identity.opaqueId);
    const userAccount = get(ids.users, identity.userId);
    const key = userAccount ?? opaqueAccount ?? `viewer:${identity.opaqueId}`;
    if (userAccount && opaqueAccount && userAccount !== opaqueAccount) this._mergeAccount(opaqueAccount, userAccount);
    Object.defineProperty(ids.opaque, identity.opaqueId, { value: key, enumerable: true, writable: true, configurable: true });
    if (identity.userId) Object.defineProperty(ids.users, identity.userId, { value: key, enumerable: true, writable: true, configurable: true });
    return key;
  }
  _owned(note, identity) { return note.author_opaque_id === identity.opaqueId || Boolean(identity.userId && note.author_user_id === identity.userId); }
  _notesFor(identity) {
    const accounts = this._accountKeys(identity);
    return this.state.notes.filter(note => this._owned(note, identity) || accounts.has(note.account_id));
  }
  _wallet(identity) {
    const account = this._account(identity);
    const wallets = this.state.wallets[this.state.session.id] ??= {};
    return wallets[account] ??= { points: 10000, bits: 1000 };
  }
  _freeRemaining(identity) {
    const used = this._notesFor(identity).filter(note => (note.payment_session_id ?? note.stream_session_id) === this.state.session.id && note.payment?.mode === 'free' && note.sealed_at !== null).length;
    return this.state.config.payments.free_enabled ? Math.max(0, this.state.config.payments.free_notes - used) : 0;
  }
  _validateInput(identity, input) {
    this._identity(identity);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_note', 'A note is required.');
    if (this.state.session.wrapped_at !== null) fail('session_wrapped', 'Start a new session before sealing a note.', 409);
    if (!this.state.config.moderation.allow_anonymous && !identity.userId) fail('identity_required', 'Share your Twitch identity first.', 403);
    if (typeof input.body !== 'string' || !input.body.trim() || [...input.body].length > 140 || [...normalizeText(input.body)].length > 140) fail('invalid_body', 'Write 1–140 characters.');
    if (input.request_id !== undefined && (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.request_id))) fail('invalid_request_id', 'Invalid request id.');
    const moment = this.state.config.moments.find(moment => moment.id === input.moment_id);
    if (!moment) fail('invalid_moment', 'Choose a moment.');
    const category = this.state.config.categories.find(category => category.id === input.category_id);
    if (!category && this.state.config.category_mode !== 'ai') fail('invalid_category', 'Choose a category.');
    const condition = validateCondition(input.condition, this.state.config.moments);
    if (condition.type === 'after' && condition.after_moment_id === moment.id) fail('invalid_condition', 'Choose a different preceding moment.');
    if (condition.type === 'window' && conditionExpired({ condition }, this.state.session, this.now())) fail('window_expired', 'This time window has ended.', 409);
    return { moment, category, condition };
  }
  _pricing(identity, input, category, moment, condition) {
    const cfg = this.state.config;
    const wallet = this._wallet(identity);
    const free_remaining = this._freeRemaining(identity);
    let mode = input.payment_mode ?? input.payment?.mode ?? (free_remaining ? 'free' : 'sim_points');
    if (mode === 'points') mode = 'sim_points';
    if (mode === 'bits') mode = 'sim_bits';
    if (mode === 'free' && free_remaining < 1) fail('free_allowance_used', 'Your free notes are used. Choose a test payment.', 409);
    let amount = 0, balance = null;
    if (mode === 'sim_points') {
      if (!cfg.payments.points_enabled) fail('payment_unavailable', 'Test Channel Points are disabled.');
      amount = category?.price ?? cfg.payments.points_price; balance = wallet.points;
    } else if (mode === 'sim_bits') {
      if (!cfg.payments.bits_enabled) fail('payment_unavailable', 'Test Bits are disabled.');
      amount = input.bits_tier ?? input.payment?.amount ?? cfg.payments.bits_tier;
      if (!BIT_TIERS.includes(amount)) fail('invalid_bits_tier', 'Choose 50, 100, 200, or 500 test Bits.');
      balance = wallet.bits;
    } else if (mode !== 'free') fail('invalid_payment', 'Choose a test payment method.');
    if (cfg.payments.bits_advanced_only && (moment.long_lived || condition.type !== 'moment') && mode !== 'sim_bits') fail('bits_required', 'This condition requires a test Bits seal.');
    if (balance !== null && balance < amount) fail('insufficient_balance', 'Your test balance is too low.', 402);
    return { mode, amount, guaranteed: amount > 0 && cfg.payments.paid_guaranteed, balance, test_mode: true, label: TEST_MODE_LABEL, config_version: cfg.version, free_remaining };
  }
  quote(identity, input) {
    return this._mutate(() => {
      const { moment, category, condition } = this._validateInput(identity, input);
      return this._pricing(identity, input, category, moment, condition);
    });
  }
  _localVerdict(body) {
    const normalized = normalizeText(body);
    const safe = createTextPolicy({ bannedWords: this.state.config.moderation.custom_words }).safeText(normalized, '', 280);
    const urls = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|gg|me|dev)\b)/i;
    return !normalized || !safe || safe !== normalized || urls.test(normalized) ? 'violates' : 'safe';
  }
  _event(type, note, extra = {}) {
    this.state.events.push({ id: randomUUID(), type, note_id: note.id, author_opaque_id: note.author_opaque_id, author_user_id: note.author_user_id, at: this.now(), ...extra });
    this.state.events = this.state.events.slice(-2000);
  }
  _charge(note, identity, input) {
    const category = this.state.config.categories.find(category => category.id === note.category_id);
    const moment = this.state.config.moments.find(moment => moment.id === note.moment_id) ?? note.moment;
    const price = this._pricing(identity, input, category, moment, note.condition);
    const wallet = this._wallet(identity);
    if (price.mode === 'sim_points') wallet.points -= price.amount;
    if (price.mode === 'sim_bits') wallet.bits -= price.amount;
    note.payment = { mode: price.mode, amount: price.amount, txn_id: randomUUID(), test_mode: true };
    note.payment_session_id = this.state.session.id;
    note.payment_account_id = this._account(identity);
    note.category_snapshot = clone(category ?? note.category_snapshot ?? { id: note.category_id, name: note.category_id });
    note.guaranteed = price.guaranteed;
    note.status = 'sealed'; note.sealed_at = this.now();
    note.condition_sequence = this.state.occurrence_sequence;
    this._event('sealed', note);
  }
  submit(identity, input) {
    return this._mutate(async () => {
      this._identity(identity);
      const fingerprint = digest({ body: input?.body, category_id: input?.category_id, moment_id: input?.moment_id, condition: input?.condition, payment_mode: input?.payment_mode, bits_tier: input?.bits_tier, show_name: input?.show_name });
      const prior = input?.request_id && this.state.idempotency.find(item => item.request_id === input.request_id && (this._owned(item, identity) || this._notesFor(identity).some(note => note.id === item.note_id)));
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('idempotency_conflict', 'This request id belongs to a different note.', 409);
        return this._receipt(this.state.notes.find(note => note.id === prior.note_id));
      }
      const { moment, category, condition } = this._validateInput(identity, input);
      const existing = this._notesFor(identity).filter(note => note.stream_session_id === this.state.session.id && note.status !== 'rejected');
      if (existing.length >= this.state.config.moderation.max_notes_per_viewer) fail('viewer_limit', 'Your notes limit for this stream is reached.', 429);
      // The quote verifies funds but never consumes free allowance or charges a wallet.
      this._pricing(identity, input, category, moment, condition);
      const policy = createTextPolicy({ bannedWords: this.state.config.moderation.custom_words });
      const note = {
        id: randomUUID(), channel_id: this.state.config.channel_id, stream_session_id: this.state.session.id,
        account_id: this._account(identity), author_opaque_id: identity.opaqueId,
        ...(identity.userId ? { author_user_id: identity.userId } : {}),
        ...(identity.userId && input.show_name === true && policy.safeText(identity.displayName, '', 40) ? { display_name: policy.safeText(identity.displayName, '', 40) } : {}),
        body: normalizeText(input.body), category_id: category?.id ?? this.state.config.categories[0].id,
        category_source: category ? 'viewer' : 'ai', moment_id: moment.id, moment: clone(moment),
        condition, condition_sequence: this.state.occurrence_sequence,
        ...(condition.type === 'window' ? { condition_deadline_at: this.state.session.started_at + condition.before_minutes * 60000 } : {}),
        status: 'pending_review', moderation: null, classification: null,
        payment: null, guaranteed: false, created_at: this.now(), sealed_at: null,
        payment_request: { payment_mode: input.payment_mode ?? input.payment?.mode, bits_tier: input.bits_tier ?? input.payment?.amount },
      };
      let decision;
      if (this._localVerdict(input.body) === 'violates') {
        decision = { moderation: { verdict: 'violates', source: 'rules', confidence: 1, latency_ms: 0 }, classification: { category_id: note.category_id, confidence: 0, latency_ms: 0 }, fit: 'unsure' };
      } else {
        try { decision = await this.decisions?.evaluate(note.body, this.config, clone(moment), category?.id, { key: identity.opaqueId }); }
        catch { /* An unavailable judgement service always falls back to human review. */ }
        decision ??= { moderation: { verdict: 'unsure', source: 'rules', confidence: 0, latency_ms: 0 }, classification: { category_id: category?.id ?? null, confidence: 0, latency_ms: 0 }, fit: 'unsure' };
      }
      const verdict = ['safe', 'violates', 'unsure'].includes(decision.moderation?.verdict) ? decision.moderation.verdict : 'unsure';
      note.moderation = { verdict, source: decision.moderation?.source === 'decisions' ? 'decisions' : 'rules', confidence: Number.isFinite(decision.moderation?.confidence) ? decision.moderation.confidence : 0, latency_ms: Number.isFinite(decision.moderation?.latency_ms) ? decision.moderation.latency_ms : 0 };
      const classified = this.state.config.categories.find(cat => cat.id === decision.classification?.category_id);
      note.classification = { category_id: classified?.id ?? null, confidence: Number.isFinite(decision.classification?.confidence) ? decision.classification.confidence : 0, latency_ms: Number.isFinite(decision.classification?.latency_ms) ? decision.classification.latency_ms : 0 };
      const mode = this.state.config.moderation.mode;
      let held = mode === 'all_human' || verdict === 'unsure';
      let rejected = verdict === 'violates' || mode !== 'all_human' && verdict === 'unsure' && this.state.config.moderation.unsure === 'reject';
      const unavailable = !this.decisions || note.moderation.source === 'rules' && verdict === 'unsure';
      if (unavailable) { held = true; rejected = false; }
      if (!rejected && decision.fit === 'mismatched') fail('moment_mismatch', 'This note fits a different moment. Choose another moment.', 409);
      if (this.state.config.category_mode === 'ai' && classified) { note.category_id = classified.id; note.category_source = 'ai'; }
      if (this.state.config.category_mode === 'viewer_check' && classified && classified.id !== note.category_id) {
        if (this.state.config.category_mismatch === 'hold') held = true;
        else { note.category_id = classified.id; note.category_source = 'ai'; }
      }
      // Missing/unsure classification does not change moderation or reject a note.
      if (rejected) { note.status = 'rejected'; this._event('rejected', note); }
      else if (held) { note.status = 'held'; this._event('held', note); }
      else this._charge(note, identity, note.payment_request);
      this.state.notes.push(note);
      if (input.request_id) {
        this.state.idempotency.push({ request_id: input.request_id, fingerprint, note_id: note.id, author_opaque_id: note.author_opaque_id, author_user_id: note.author_user_id });
        this.state.idempotency = this.state.idempotency.slice(-1000);
      }
      return this._receipt(note);
    });
  }
  _receipt(note) {
    return { id: note.id, status: note.status, category_id: note.category_id, moment_id: note.moment_id, condition: clone(note.condition), payment: note.payment ? clone(note.payment) : null, guaranteed: note.guaranteed, created_at: note.created_at, sealed_at: note.sealed_at, revealed_at: note.revealed_at ?? null, ...(note.prediction_verdict ? { prediction_verdict: note.prediction_verdict } : {}), test_mode: true, label: TEST_MODE_LABEL };
  }
  _refund(note, reason) {
    if (!note.payment || !note.payment.amount || note.payment.refunded_at !== undefined || !this.state.config.payments[`refund_on_${reason}`]) return false;
    const wallet = this.state.wallets[note.payment_session_id ?? note.stream_session_id]?.[note.payment_account_id ?? note.account_id];
    if (wallet && note.payment.mode === 'sim_points') wallet.points += note.payment.amount;
    if (wallet && note.payment.mode === 'sim_bits') wallet.bits += note.payment.amount;
    note.payment.refunded_at = this.now(); note.payment.refund_reason = reason;
    this._event('refunded', note, { reason });
    return true;
  }
  review(id, approve) {
    return this._mutate(() => {
      if (typeof approve !== 'boolean') fail('invalid_review', 'Choose approve or reject.');
      const note = this.state.notes.find(note => note.id === id);
      if (!note) fail('note_not_found', 'Note not found.', 404);
      if (approve && note.moderation.verdict === 'violates') fail('moderation_floor', 'The fixed moderation floor cannot be overridden.', 403);
      if (!['held', 'pending_review', 'sealed'].includes(note.status)) fail('invalid_status', 'This note cannot be reviewed.', 409);
      if (!approve) {
        this._refund(note, 'reject'); note.status = 'rejected';
        this.state.queue = this.state.queue.filter(entry => entry.id !== id);
        this._event('rejected', note); return this._receipt(note);
      }
      if (note.status === 'sealed') return this._receipt(note);
      if (this._localVerdict(note.body) === 'violates') fail('moderation_floor', 'This note violates the current rules.', 403);
      if (this.state.session.wrapped_at !== null) fail('session_wrapped', 'This stream has wrapped up.', 409);
      if (conditionExpired(note, this.state.session, this.now())) fail('window_expired', 'This time window has ended.', 409);
      const identity = { opaqueId: note.author_opaque_id, userId: note.author_user_id };
      this._charge(note, identity, note.payment_request);
      note.moderation = { ...note.moderation, source: 'human', verdict: 'safe' };
      return this._receipt(note);
    });
  }
  _queued(id) { return this.state.current_id === id || this.state.queue.some(entry => entry.id === id); }
  async _select(candidates, moment, context, options = {}) {
    const available = candidates.filter(note => note.status === 'sealed' && !this._queued(note.id));
    if (this.state.config.reveal.mode === 'manual') {
      // The streamer chooses from all eligible envelopes; AI selection is for autoplay only.
      for (const note of available) this.state.queue.push({ id: note.id, context,
        confirmed_by: options.confirmedBy ?? 'streamer', never_opened: options.neverOpened === true });
      return available.map(note => note.id);
    }
    const guaranteed = available.filter(note => note.guaranteed);
    const ordinary = available.filter(note => !note.guaranteed);
    const slots = Math.max(0, (options.limit ?? this.state.config.reveal.max_per_moment) - guaranteed.length);
    const picked = [];
    let remaining = ordinary;
    while (picked.length < slots && remaining.length) {
      const batch = remaining.slice(0, 10);
      let choices;
      try { choices = await this.decisions?.choose(batch.map(note => ({ id: note.id, body: note.body, category_id: note.category_id })), clone(moment), context); } catch {}
      const ids = Array.isArray(choices) ? choices : choices ? [choices] : [];
      const selected = ids.map(id => batch.find(note => note.id === id)).filter(Boolean).filter((note, i, array) => array.findIndex(other => other.id === note.id) === i).slice(0, slots - picked.length);
      if (!selected.length) selected.push(batch[0]);
      picked.push(...selected);
      remaining = remaining.filter(note => !selected.some(chosen => chosen.id === note.id));
    }
    for (const note of [...guaranteed, ...picked]) this.state.queue.push({ id: note.id, context, confirmed_by: options.confirmedBy ?? 'streamer', never_opened: options.neverOpened === true });
    return [...guaranteed, ...picked].map(note => note.id);
  }
  async _advance({ manualOpen = false } = {}) {
    if (this.state.config.reveal.mode === 'manual' && !manualOpen) return;
    if (this.state.current_id && this.now() < this.state.current_until) return;
    this.state.current_id = null; this.state.current_until = null;
    let entry;
    while ((entry = this.state.queue.shift())) {
      const note = this.state.notes.find(note => note.id === entry.id);
      if (!note || note.status !== 'sealed') continue;
      note.confirmed_by = entry.confirmed_by;
      note.reliability = entry.confirmed_by === 'api-auto' ? 'API event · automatic' : entry.confirmed_by === 'api-confirmed' ? 'API event · confirmed by mod' : entry.confirmed_by === 'twitch' ? 'Twitch event' : entry.confirmed_by === 'ai-confirmed' || note.moment.kind === 'ai' ? 'AI-detected · confirmed by mod' : 'Streamer confirmed';
      if (entry.never_opened) { note.never_opened = true; this._refund(note, 'never'); }
      if (note.category_id === 'prediction') {
        let verdict;
        try { verdict = await this.decisions?.predict({ id: note.id, body: note.body, category_id: note.category_id }, entry.context); } catch {}
        note.prediction_verdict = ['came_true', 'missed', 'unclear'].includes(verdict) ? verdict : 'unclear';
      }
      note.status = 'revealed'; note.revealed_at = this.now();
      this.state.current_id = note.id;
      this.state.current_until = this.state.config.reveal.mode === 'manual' ? null : this.now() + this.state.config.reveal.duration_ms;
      this._event('opened', note, { revealed_at: note.revealed_at });
      break;
    }
  }
  _expire() {
    for (const note of this.state.notes) {
      if (!ACTIVE.has(note.status) || this._queued(note.id)) continue;
      if (conditionExpired(note, this.state.session, this.now())) {
        note.status = 'expired'; this._refund(note, 'expire'); this._event('expired', note);
      }
    }
  }
  occur(momentId, context = {}, confirmedBy = 'streamer', { expectedSessionId, expiresAt, expectedEventDefinition, expectedProfileContext } = {}) {
    return this._mutate(async () => {
      // Check at mutation admission, not before queueing behind a stream transition.
      if (expectedProfileContext !== undefined && expectedProfileContext !== eventProfileContext(this.state.event_profile_active_ref, this.state.event_profile_context_epoch)) fail('stale_profile_context', 'The active event profile changed before confirmation.', 409);
      if (expectedEventDefinition !== undefined) {
        const definition = this.state.config.events.find(value => value.id === momentId);
        if (!definition || digest(definition) !== expectedEventDefinition) fail('event_definition_changed', 'This event definition changed before confirmation.', 409);
      }
      if (expectedSessionId !== undefined && expectedSessionId !== this.state.session.id ||
        expiresAt !== undefined && (!Number.isFinite(expiresAt) || this.now() >= expiresAt))
        fail('stale_confirmation', 'This observation no longer belongs to the current stream.', 409);
      this._expire();
      const moment = this.state.config.moments.find(moment => moment.id === momentId);
      if (!moment) fail('invalid_moment', 'Unknown moment.');
      if (this.state.session.wrapped_at !== null) fail('session_wrapped', 'This stream has wrapped up.', 409);
      if (momentId === 'never') fail('wrap_required', 'Never notes open only at wrap-up.', 409);
      if (!['streamer', 'broadcaster', 'moderator', 'twitch', 'ai-confirmed', 'api-auto', 'api-confirmed', 'demo'].includes(confirmedBy) || moment.kind === 'ai' && !['streamer', 'broadcaster', 'moderator', 'ai-confirmed', 'api-auto', 'api-confirmed'].includes(confirmedBy)) fail('confirmation_required', 'A streamer or moderator must confirm this moment.', 403);
      if (context && typeof context === 'object' && (context.warmup || context.source === 'warmup')) fail('warmup_event', 'Warm-up cannot trigger stream moments.', 409);
      const eventId = typeof context === 'object' ? context?.event_id ?? context?.eventId : undefined;
      const duplicate = this.state.occurrences.find(event => event.session_id === this.state.session.id && event.moment_id === momentId && (eventId ? event.event_id === eventId : ['end', 'first-death'].includes(momentId)));
      if (duplicate) return { moment_id: momentId, duplicate: true, selected: [] };
      const occurrence = { moment_id: momentId, session_id: this.state.session.id, at: this.now(), sequence: ++this.state.occurrence_sequence, confirmed_by: confirmedBy, ...(eventId ? { event_id: String(eventId).slice(0, 200) } : {}) };
      this.state.occurrences.push(occurrence);
      const candidates = this.state.notes.filter(note => note.status === 'sealed' && (note.stream_session_id === this.state.session.id || note.moment.long_lived) && conditionMatches(note, occurrence, this.state.occurrences, this.state.session));
      const selected = await this._select(candidates, moment, context, { confirmedBy });
      await this._advance();
      return { moment_id: momentId, duplicate: false, selected };
    });
  }
  reveal(id) {
    return this._mutate(async () => {
      this._expire();
      const note = this.state.notes.find(note => note.id === id);
      if (!note) fail('note_not_found', 'Note not found.', 404);
      if (this.state.config.reveal.mode === 'manual') {
        if (this.state.current_id === id) return this._receipt(note);
        if (this.state.current_id) fail('reveal_in_progress', 'Close the current envelope first.', 409);
        if (!this.state.queue.some(entry => entry.id === id)) fail('moment_not_ready', 'Declare the matching event before opening this envelope.', 409);
      }
      if (note.status !== 'sealed') fail('invalid_status', 'Only sealed notes can be revealed.', 409);
      if (!this._queued(id)) this.state.queue.push({ id, context: 'Manually opened by the streamer.', confirmed_by: 'streamer', never_opened: false });
      if (this.state.config.reveal.mode === 'manual') {
        const index = this.state.queue.findIndex(entry => entry.id === id);
        const [selected] = this.state.queue.splice(index, 1);
        this.state.queue.unshift(selected);
      }
      await this._advance({ manualOpen: true });
      return this._receipt(note);
    });
  }
  skip() { return this._mutate(async () => {
    if (this.state.config.reveal.mode === 'manual') {
      const note = this.state.notes.find(note => note.id === this.state.current_id);
      this.state.current_id = null; this.state.current_until = null;
      if (note) this._event('closed', note);
    } else { this.state.current_until = 0; await this._advance(); }
    return this.overlayState();
  }); }
  tick() {
    const now = this.now();
    const revealDue = this.state.config.reveal.mode !== 'manual' && (this.state.current_id ? now >= this.state.current_until : this.state.queue.length > 0);
    const expiryDue = this.state.notes.some(note => ACTIVE.has(note.status) && !this._queued(note.id) && conditionExpired(note, this.state.session, now));
    if (!revealDue && !expiryDue) return Promise.resolve({ current_id: this.state.current_id });
    return this._mutate(async () => { this._expire(); await this._advance(); return { current_id: this.state.current_id }; });
  }
  wrap() {
    return this._mutate(async () => {
      if (this.state.session.wrapped_at !== null) return { duplicate: true, reel: this.state.reel };
      this._expire();
      const end = this.state.config.moments.find(moment => moment.id === 'end');
      const endNotes = this.state.notes.filter(note => note.status === 'sealed' && note.moment_id === 'end' && !this._queued(note.id));
      // End-of-stream guarantees are not subject to selection limits.
      for (const note of endNotes) this.state.queue.push({ id: note.id, context: 'End of stream.', confirmed_by: 'streamer', never_opened: false });
      this.state.occurrences.push({ moment_id: end.id, session_id: this.state.session.id, at: this.now(), sequence: ++this.state.occurrence_sequence, confirmed_by: 'streamer' });
      const remaining = this.state.notes.filter(note => note.status === 'sealed' && !note.moment.long_lived && !this._queued(note.id));
      const never = remaining.filter(note => !this.state.occurrences.some(event => event.session_id === this.state.session.id && conditionMatches(note, event, this.state.occurrences.filter(item => item.sequence <= event.sequence), this.state.session)));
      for (const note of remaining.filter(note => !never.includes(note))) { note.status = 'expired'; this._refund(note, 'expire'); this._event('expired', note); }
      const candidates = never.slice(0, 3);
      this.state.reel = { count: never.length, note_ids: candidates.map(note => note.id), created_at: this.now(), label: 'This never happened' };
      for (const note of never) this._refund(note, 'never');
      for (const note of candidates) this.state.queue.push({ id: note.id, context: 'This moment never happened before wrap-up.', confirmed_by: 'streamer', never_opened: true });
      for (const note of never.filter(note => !candidates.includes(note))) { note.status = 'expired'; this._event('expired', note); }
      for (const note of this.state.notes.filter(note => ['held', 'pending_review'].includes(note.status) && !note.moment.long_lived)) { note.status = 'expired'; this._refund(note, 'expire'); this._event('expired', note); }
      this.state.session.wrapped_at = this.now();
      await this._advance();
      return { duplicate: false, reel: clone(this.state.reel), queued: this.state.queue.length };
    });
  }
  newSession() {
    return this._mutate(() => {
      if (this.state.current_id || this.state.queue.length) fail('reveals_pending', 'Finish or skip the reveal queue before starting a stream.', 409);
      for (const note of this.state.notes) if (ACTIVE.has(note.status) && !note.moment.long_lived) { note.status = 'expired'; this._refund(note, 'expire'); this._event('expired', note); }
      this.state.sessions.push(clone(this.state.session));
      this.state.session = newSession(this.now());
      this.state.reel = null;
      return clone(this.state.session);
    });
  }
  _bumpEventProfileContext() {
    const epoch = validateEventProfileContextEpoch(this.state.event_profile_context_epoch);
    if (epoch >= Number.MAX_SAFE_INTEGER) fail('profile_context_unavailable', 'The event profile context cannot advance safely.', 503);
    this.state.event_profile_context_epoch = epoch + 1;
    if (this.state.event_runtime && typeof this.state.event_runtime === 'object') this.state.event_runtime.candidates = [];
  }
  _setEventDefinitions(definitions) {
    const cfg = validateConfig({ events: validateEventDefinitions(definitions) }, this.state.config);
    if (eventProfileHash(cfg.events) !== eventProfileHash(this.state.config.events)) this._bumpEventProfileContext();
    cfg.version = this.state.config.version + 1;
    this.state.config = cfg;
    return clone(cfg.events);
  }
  listEventDefinitions() { return this._mutate(() => clone(this.state.config.events)); }
  upsertEventDefinition(input) {
    return this._mutate(() => {
      const definition = validateEventDefinition(input);
      const definitions = clone(this.state.config.events);
      const index = definitions.findIndex(value => value.id === definition.id);
      if (index < 0) definitions.push(definition); else definitions[index] = definition;
      this._setEventDefinitions(definitions);
      return definition;
    });
  }
  deleteEventDefinition(id) {
    return this._mutate(() => {
      if (typeof id !== 'string' || !this.state.config.events.some(value => value.id === id)) fail('event_not_found', 'Event definition not found.', 404);
      // Keep its moment for sealed notes, after conditions, and historical receipts.
      this._setEventDefinitions(this.state.config.events.filter(value => value.id !== id));
      return { id, deleted: true };
    });
  }
  importEventDefinitions(definitions) { return this._mutate(() => {
    const previousEpoch = this.state.event_profile_context_epoch;
    const events = this._setEventDefinitions(definitions);
    if (this.state.event_profile_active_ref !== null && this.state.event_profile_context_epoch === previousEpoch) this._bumpEventProfileContext();
    this.state.event_profile_active_ref = null;
    return events;
  }); }
  _eventProfilesState() {
    const active_ref = this.state.event_profile_active_ref;
    return { profiles: clone(this.state.event_profiles), active_ref: clone(active_ref), dirty: active_ref !== null && eventProfileHash(this.state.config.events) !== active_ref.events_hash };
  }
  listEventProfiles() { return this._mutate(() => this._eventProfilesState()); }
  saveEventProfile(input) {
    return this._mutate(() => {
      const request = validateEventProfileInput(input);
      const previous = request.id ? this.state.event_profiles.find(value => value.id === request.id) : null;
      if (request.id && !previous) fail('profile_not_found', 'Event profile not found.', 404);
      if (previous && previous.revision !== request.expected_revision) fail('profile_revision_conflict', 'This profile changed. Refresh before saving.', 409);
      if (!previous && this.state.event_profiles.length >= MAX_EVENT_PROFILES) fail('profile_limit', 'Save at most 20 event profiles.');
      if (this.state.event_profiles.some(value => value.id !== request.id && profileLabelKey(value.label) === profileLabelKey(request.label))) fail('profile_name_in_use', 'A saved profile already uses this name.', 409);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || previous && now < previous.created_at || previous && previous.revision >= Number.MAX_SAFE_INTEGER) fail('invalid_profile', 'Invalid event profile.');
      const profile = { id: previous?.id ?? `profile-${randomUUID()}`, revision: (previous?.revision ?? 0) + 1, label: request.label, description: request.description, events: clone(request.events), created_at: previous?.created_at ?? now, updated_at: now };
      if (previous) this.state.event_profiles[this.state.event_profiles.findIndex(value => value.id === previous.id)] = profile;
      else this.state.event_profiles.push(profile);
      return clone(profile);
    });
  }
  activateEventProfile(input) {
    return this._mutate(async () => {
      const request = validateEventProfileSelection(input);
      let selected;
      if (request.kind === 'builtin') selected = { ...(await listEventPresets()).find(value => value.id === request.id), revision: 1 };
      else {
        selected = this.state.event_profiles.find(value => value.id === request.id);
        if (!selected) fail('profile_not_found', 'Event profile not found.', 404);
        if (selected.revision !== request.expected_revision) fail('profile_revision_conflict', 'This profile changed. Refresh before applying.', 409);
      }
      const previousEpoch = this.state.event_profile_context_epoch;
      const previousContext = eventProfileContext(this.state.event_profile_active_ref, previousEpoch);
      let events;
      try { events = this._setEventDefinitions(selected.events); }
      catch (error) {
        if (error.code === 'invalid_config' && error.message === 'Configure at most 40 moments.') fail('profile_moment_limit', 'Applying this profile would exceed 40 retained moments. Remove unused moments in broadcaster configuration first.', 409);
        throw error;
      }
      this.state.event_profile_active_ref = { kind: request.kind, id: selected.id, revision: selected.revision, label: selected.label, events_hash: eventProfileHash(events) };
      if (this.state.event_profile_context_epoch === previousEpoch && previousContext !== eventProfileContext(this.state.event_profile_active_ref, this.state.event_profile_context_epoch)) this._bumpEventProfileContext();
      return { events, active_ref: clone(this.state.event_profile_active_ref), dirty: false };
    });
  }
  setStageLayout(layout) {
    return this.updateConfig({ reveal: { rope: layout === null ? clone(DEFAULT_CONFIG.reveal.rope) : layout } });
  }
  updateConfig(input) {
    return this._mutate(() => {
      const cfg = validateConfig(input, this.state.config);
      const activeMomentIds = this.state.notes.filter(note => ACTIVE.has(note.status)).flatMap(note => [note.moment_id, ...(note.condition.type === 'after' ? [note.condition.after_moment_id] : [])]);
      if (activeMomentIds.some(id => !cfg.moments.some(moment => moment.id === id))) fail('moment_in_use', 'A sealed note still uses this moment.', 409);
      if (eventProfileHash(cfg.events) !== eventProfileHash(this.state.config.events)) this._bumpEventProfileContext();
      cfg.version = this.state.config.version + 1;
      this.state.config = cfg;
      return this.config;
    });
  }
  addMoment({ label, long_lived = false } = {}) {
    return this._mutate(() => {
      const id = `moment-${randomUUID().slice(0, 8)}`;
      const cfg = validateConfig({ moments: [...this.state.config.moments, { id, label, kind: 'declared', long_lived }] }, this.state.config);
      cfg.version++;
      this.state.config = cfg;
      return clone(cfg.moments.find(moment => moment.id === id));
    });
  }
  overrideVerdict(id, verdict) {
    return this._mutate(() => {
      if (!['came_true', 'missed', 'unclear'].includes(verdict)) fail('invalid_verdict', 'Choose a prediction verdict.');
      const note = this.state.notes.find(note => note.id === id);
      if (!note || note.status !== 'revealed' || note.category_id !== 'prediction') fail('invalid_prediction', 'Choose an opened prediction.', 409);
      note.prediction_verdict = verdict; note.prediction_override = true;
      return this._publicNote(note);
    });
  }
  _publicNote(note) {
    return { ...this._receipt(note), body: note.body, display_name: note.display_name ?? null, moment_label: note.moment.label, condition_label: this._sealedEnvelope(note).condition_label, category: clone(note.category_snapshot ?? this.state.config.categories.find(category => category.id === note.category_id) ?? { id: note.category_id, name: note.category_id }), reliability: note.reliability, never_opened: Boolean(note.never_opened), stream_session_id: note.stream_session_id, prediction_override: Boolean(note.prediction_override) };
  }
  _metadata(note) { return { ...this._receipt(note), moderation: clone(note.moderation), classification: clone(note.classification), moment_label: note.moment.label, long_lived: note.moment.long_lived, ...(note.status === 'revealed' ? this._publicNote(note) : {}) }; }
  _counts() {
    const counts = {};
    for (const note of this.state.notes) if (note.status === 'sealed') counts[note.moment_id] = (counts[note.moment_id] ?? 0) + 1;
    return counts;
  }
  recipient(id) {
    const note = this.state.notes.find(note => note.id === id);
    return note ? note.author_opaque_id : null;
  }
  momentChoices() {
    const config = this.config;
    const groups = groupMomentChoices(config.moments, config.events);
    return [...groups.current_profile, ...groups.stream_general];
  }
  viewerState(identity) {
    this._identity(identity);
    const wallets = [...this._accountKeys(identity)].map(account => this.state.wallets[this.state.session.id]?.[account]).filter(Boolean);
    const wallet = wallets.length ? wallets.reduce((sum, value) => ({ points: sum.points + value.points - 10000, bits: sum.bits + value.bits - 1000 }), { points: 10000, bits: 1000 }) : { points: 10000, bits: 1000 };
    const config = this.config;
    const moment_groups = groupMomentChoices(config.moments, config.events);
    const moments = [...moment_groups.current_profile, ...moment_groups.stream_general];
    return { config: {...config, moments}, moments, moment_groups, session: clone(this.state.session), wallet: clone(wallet), free_remaining: this._freeRemaining(identity), notes: this._notesFor(identity).map(note => this._metadata(note)), events: this.events(identity), presentation: this.viewerPresentation(), sealedCount: Object.values(this._counts()).reduce((a, b) => a + b, 0), test_mode: true, label: TEST_MODE_LABEL };
  }
  operatorState() {
    const notes = this.state.notes.map(note => this._metadata(note));
    const config = this.config;
    const moment_groups = groupMomentChoices(config.moments, config.events);
    return { config, moments: [...moment_groups.current_profile, ...moment_groups.stream_general], moment_groups, session: clone(this.state.session), event_profiles: this._eventProfilesState(), notes, held: this.state.notes.filter(note => ['held', 'pending_review'].includes(note.status)).map(note => ({ ...this._metadata(note), body: note.body })), queue: this.state.queue.map(entry => this._metadata(this.state.notes.find(note => note.id === entry.id))), current: this.overlayState().current, counts: this._counts(), reel: clone(this.state.reel), sealedCount: Object.values(this._counts()).reduce((a, b) => a + b, 0) };
  }
  _sealedEnvelope(note) {
    const label = note.moment.label;
    const condition = note.condition;
    let conditionLabel = label;
    if (condition.type === 'count') conditionLabel = `${label} · occurrence ${condition.count}`;
    else if (condition.type === 'window') conditionLabel = `${label} · before ${condition.before_minutes} min`;
    else if (condition.type === 'after') {
      const earlier = this.state.config.moments.find(moment => moment.id === condition.after_moment_id)?.label ?? condition.after_moment_id;
      conditionLabel = `${label} · after ${earlier}`;
    }
    // A sealed envelope has a public cover, never its contents or account identifiers.
    return { id: note.id, display_name: note.display_name ?? null, moment_label: label,
      condition_label: conditionLabel, category_id: note.category_id,
      payment_mode: note.payment?.mode ?? null };
  }
  viewerPresentation() {
    const view = this.overlayState();
    return { ...view, queue: view.queue.map(entry => ({ id: entry.id })) };
  }
  overlayState() {
    const current = this.state.notes.find(note => note.id === this.state.current_id && note.status === 'revealed');
    const manual = this.state.config.reveal.mode === 'manual';
    const ready = new Set(this.state.queue.map(entry => entry.id));
    const readyNotes = this.state.notes.filter(note => note.status === 'sealed' && ready.has(note.id));
    const sealedEnvelopes = this.state.notes.filter(note => note.status === 'sealed' && (!manual || !ready.has(note.id))).slice(0, 12).map(note => this._sealedEnvelope(note));
    return { presentation_mode: manual ? 'manual' : 'auto', ready_count: readyNotes.length,
      ready_envelopes: manual ? readyNotes.slice(0, 12).map(note => this._sealedEnvelope(note)) : [], serverNow: this.now(), sealed_envelopes: sealedEnvelopes, current: current ? this._publicNote(current) : null, current_until: this.state.current_until, queue: this.state.queue.map(entry => this._receipt(this.state.notes.find(note => note.id === entry.id))), sealedCount: Object.values(this._counts()).reduce((a, b) => a + b, 0), counts: this._counts(), config: this.config, moments: this.config.moments, reel: clone(this.state.reel), session: clone(this.state.session), test_mode: true, label: TEST_MODE_LABEL };
  }
  archive() { return this.state.notes.filter(note => note.status === 'revealed').map(note => this._publicNote(note)); }
  events(identity) {
    this._identity(identity);
    const ownedIds = new Set(this._notesFor(identity).map(note => note.id));
    return this.state.events.filter(event => ownedIds.has(event.note_id)).map(event => ({ id: event.id, type: event.type, note_id: event.note_id, at: event.at, ...(event.revealed_at !== undefined ? { revealed_at: event.revealed_at } : {}), ...(event.reason ? { reason: event.reason } : {}) }));
  }
}
