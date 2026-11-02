import { createTextPolicy } from '../engine/content.js';
import { validateEventDefinitions } from './event-definitions.js';

export const TEST_MODE_LABEL = 'TEST MODE — no real charge';
export const BIT_TIERS = Object.freeze([50, 100, 200, 500]);
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  channel_id: 'wilf_lin',
  moderation: {
    mode: 'auto_queue', unsure: 'hold', strictness: 'standard',
    max_notes_per_viewer: 10, allow_anonymous: true,
    forbidden_topics: [], custom_words: [],
  },
  category_mode: 'viewer_check', category_mismatch: 'ai',
  events: [],
  signals: {
    clip_poll_enabled: false,
    chat_spike: { enabled: false, window_seconds: 10, min_messages: 20, min_viewers: 5, cooldown_seconds: 60 },
  },
  categories: [
    { id: 'advice', name: 'Advice', envelope_color: '#66d9c4', subtitle: 'Listen to chat', icon: 'compass', description: 'Useful advice for this moment.' },
    { id: 'prediction', name: 'Prediction', envelope_color: '#b5a1ff', subtitle: 'I called it', icon: 'sparkles', description: 'A prediction about what will happen.' },
    { id: 'joke', name: 'Joke', envelope_color: '#ffbd75', subtitle: "Don't take it personally", icon: 'smile', description: 'A lighthearted joke.' },
    { id: 'encouragement', name: 'Encouragement', envelope_color: '#ff9ab8', subtitle: "You've got this", icon: 'heart', description: 'Support and encouragement.' },
  ],
  moments: [
    { id: 'margit', label: 'Beat Margit', kind: 'declared', long_lived: false },
    { id: 'key', label: 'Find the key', kind: 'declared', long_lived: false },
    { id: 'finish', label: 'Finish the game', kind: 'declared', long_lived: true },
    { id: 'end', label: 'End of stream', kind: 'builtin', long_lived: false },
    { id: 'first-death', label: 'First death', kind: 'builtin', long_lived: false },
    { id: 'never', label: 'This never happened', kind: 'builtin', long_lived: false },
    { id: 'raid', label: 'A raid arrives', kind: 'twitch', long_lived: false },
    { id: 'poll-ended', label: 'A poll ends', kind: 'twitch', long_lived: false },
    { id: 'new-follower', label: 'A new follower', kind: 'twitch', long_lived: false },
    { id: 'new-sub', label: 'A new subscription', kind: 'twitch', long_lived: false },
    { id: 'stream-15', label: '15 minutes live', kind: 'twitch', long_lived: false, trigger: { type: 'stream_minutes', minutes: 15 } },
    { id: 'clip-created', label: 'A clip is created', kind: 'twitch', long_lived: false },
    { id: 'chat-spike', label: 'Chat lights up', kind: 'twitch', long_lived: false },
  ],
  payments: {
    free_enabled: true, free_notes: 1,
    points_enabled: true, points_price: 200,
    bits_enabled: true, bits_tier: 100,
    paid_guaranteed: true, bits_advanced_only: false,
    refund_on_reject: true, refund_on_expire: true, refund_on_never: true,
  },
  reveal: { max_per_moment: 3, duration_ms: 8000, mode: 'auto', rope: { left: { x: 0, y: 0.025 }, right: { x: 1, y: 0.025 } } },
});

export function domainError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high, name) => {
  if (!Number.isInteger(value) || value < low || value > high) throw domainError('invalid_config', `Invalid ${name}.`);
};
const enumValue = (value, values, name) => {
  if (!values.includes(value)) throw domainError('invalid_config', `Invalid ${name}.`);
};
const allowed = (input, defaults, name) => {
  if (!object(input)) throw domainError('invalid_config', `Invalid ${name}.`);
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw domainError('invalid_config', `Unknown ${name} field.`);
  return { ...structuredClone(defaults), ...structuredClone(input) };
};

export function validateRopeLayout(input) {
  const invalid = () => { throw domainError('invalid_stage_layout', 'Use two points inside the stage, with the right point at least 10% to the right of the left point.'); };
  if (!object(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'left') || !Object.hasOwn(input, 'right')) invalid();
  for (const side of ['left', 'right']) {
    const point = input[side];
    if (!object(point) || Object.keys(point).length !== 2 || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y')) invalid();
    for (const axis of ['x', 'y']) if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis]) || point[axis] < 0 || point[axis] > 1) invalid();
  }
  if (input.right.x - input.left.x < 0.1 - Number.EPSILON) invalid();
  return structuredClone(input);
}

export function validateConfig(input = {}, previous = DEFAULT_CONFIG) {
  previous = { ...structuredClone(DEFAULT_CONFIG), ...previous, reveal: { ...DEFAULT_CONFIG.reveal, ...previous.reveal }, signals: { ...structuredClone(DEFAULT_CONFIG.signals), ...previous.signals, chat_spike: { ...DEFAULT_CONFIG.signals.chat_spike, ...previous.signals?.chat_spike } } };
  const cfg = allowed(input, previous, 'config');
  cfg.moderation = allowed(input.moderation ?? {}, previous.moderation, 'moderation');
  cfg.payments = allowed(input.payments ?? {}, previous.payments, 'payments');
  cfg.reveal = allowed(input.reveal ?? {}, previous.reveal, 'reveal');
  cfg.reveal.rope = validateRopeLayout(cfg.reveal.rope);
  cfg.signals = allowed(input.signals ?? {}, previous.signals, 'signals');
  cfg.signals.chat_spike = allowed(input.signals?.chat_spike ?? {}, previous.signals.chat_spike, 'chat spike');
  if (typeof cfg.signals.clip_poll_enabled !== 'boolean' || typeof cfg.signals.chat_spike.enabled !== 'boolean') throw domainError('invalid_config', 'Invalid signal switch.');
  integer(cfg.signals.chat_spike.window_seconds, 2, 120, 'chat window');
  integer(cfg.signals.chat_spike.min_messages, 2, 10000, 'chat message threshold');
  integer(cfg.signals.chat_spike.min_viewers, 2, 1000, 'chat viewer threshold');
  integer(cfg.signals.chat_spike.cooldown_seconds, 10, 3600, 'chat cooldown');
  enumValue(cfg.moderation.mode, ['auto', 'auto_queue', 'all_human'], 'moderation mode');
  enumValue(cfg.moderation.unsure, ['hold', 'reject'], 'unsure handling');
  enumValue(cfg.moderation.strictness, ['lenient', 'standard', 'strict'], 'strictness');
  enumValue(cfg.category_mode, ['viewer', 'ai', 'viewer_check'], 'category mode');
  enumValue(cfg.category_mismatch, ['ai', 'hold'], 'category mismatch');
  integer(cfg.moderation.max_notes_per_viewer, 1, 100, 'viewer limit');
  integer(cfg.payments.free_notes, 0, 100, 'free allowance');
  integer(cfg.payments.points_price, 1, 100000, 'points price');
  enumValue(cfg.payments.bits_tier, BIT_TIERS, 'Bits tier');
  integer(cfg.reveal.max_per_moment, 1, 10, 'selection limit');
  integer(cfg.reveal.duration_ms, 8000, 60000, 'reveal duration');
  enumValue(cfg.reveal.mode, ['auto', 'manual'], 'reveal mode');
  for (const key of ['allow_anonymous']) if (typeof cfg.moderation[key] !== 'boolean') throw domainError('invalid_config', `Invalid ${key}.`);
  for (const key of ['free_enabled', 'points_enabled', 'bits_enabled', 'paid_guaranteed', 'bits_advanced_only', 'refund_on_reject', 'refund_on_expire', 'refund_on_never']) {
    if (typeof cfg.payments[key] !== 'boolean') throw domainError('invalid_config', `Invalid ${key}.`);
  }
  if (!Array.isArray(cfg.moderation.custom_words) || cfg.moderation.custom_words.length > 50 || cfg.moderation.custom_words.some(w => typeof w !== 'string' || !w.trim() || w.length > 80)) throw domainError('invalid_config', 'Invalid custom words.');
  if (!Array.isArray(cfg.moderation.forbidden_topics) || cfg.moderation.forbidden_topics.some(t => !['spoilers', 'backseating', 'other_creators', 'politics'].includes(t))) throw domainError('invalid_config', 'Invalid forbidden topics.');
  const policy = createTextPolicy();
  const text = (value, max, name) => {
    if (typeof value !== 'string' || !value || [...value].length > max || policy.safeText(value, '', max * 2) !== value) throw domainError('invalid_config', `Invalid ${name}.`);
    return value;
  };
  text(cfg.channel_id, 80, 'channel');
  if (!Array.isArray(cfg.categories) || cfg.categories.length < 3 || cfg.categories.length > 6) throw domainError('invalid_config', 'Use 3–6 categories.');
  const categoryIds = new Set();
  cfg.categories = cfg.categories.map(category => {
    if (!object(category) || !/^[a-z][a-z0-9-]{0,39}$/.test(category.id) || categoryIds.has(category.id) || ['unsure', 'safe', 'violates'].includes(category.id)) throw domainError('invalid_config', 'Invalid category id.');
    categoryIds.add(category.id);
    const out = { id: category.id, name: text(category.name, 40, 'category name'), envelope_color: category.envelope_color, subtitle: text(category.subtitle, 80, 'subtitle'), icon: text(category.icon, 24, 'icon'), description: text(category.description, 250, 'description') };
    if (!['#66d9c4', '#b5a1ff', '#ffbd75', '#ff9ab8', '#9dcfff', '#e5df88'].includes(out.envelope_color)) throw domainError('invalid_config', 'Choose a preset envelope color.');
    if (category.price !== undefined) { integer(category.price, 1, 100000, 'category price'); out.price = category.price; }
    return out;
  });
  if (!Array.isArray(cfg.moments) || cfg.moments.length > 40) throw domainError('invalid_config', 'Invalid moments.');
  const momentIds = new Set();
  cfg.moments = cfg.moments.map(moment => {
    if (!object(moment) || !/^[a-z][a-z0-9-]{0,59}$/.test(moment.id) || momentIds.has(moment.id)) throw domainError('invalid_config', 'Invalid moment id.');
    momentIds.add(moment.id);
    enumValue(moment.kind, ['builtin', 'declared', 'ai', 'twitch'], 'moment kind');
    if (typeof moment.long_lived !== 'boolean') throw domainError('invalid_config', 'Invalid long-lived setting.');
    const out = { id: moment.id, label: text(moment.label, 100, 'moment label'), kind: moment.kind, long_lived: moment.long_lived };
    if (moment.trigger !== undefined) {
      const trigger = moment.trigger;
      if (moment.kind !== 'twitch' || !object(trigger) || Object.keys(trigger).some(key => !['type', 'minutes'].includes(key)) || trigger.type !== 'stream_minutes' || !Number.isFinite(trigger.minutes) || trigger.minutes < 1 || trigger.minutes > 1440) throw domainError('invalid_config', 'Invalid moment trigger.');
      out.trigger = { type: 'stream_minutes', minutes: trigger.minutes };
    }
    return out;
  });
  for (const id of ['end', 'first-death', 'never']) {
    if (!momentIds.has(id)) cfg.moments.push(structuredClone(DEFAULT_CONFIG.moments.find(m => m.id === id)));
    else { const m = cfg.moments.find(m => m.id === id); m.kind = 'builtin'; m.long_lived = false; }
  }
  cfg.events = validateEventDefinitions(cfg.events);
  for (const definition of cfg.events) {
    const moment = cfg.moments.find(value => value.id === definition.id);
    if (moment && moment.kind !== 'ai' && !(moment.id === 'first-death' && moment.kind === 'builtin')) throw domainError('event_moment_conflict', 'This event id belongs to a non-AI moment.', 409);
    if (moment) moment.label = definition.label;
    else cfg.moments.push({ id: definition.id, label: definition.label, kind: 'ai', long_lived: false });
  }
  if (cfg.moments.length > 40) throw domainError('invalid_config', 'Configure at most 40 moments.');
  cfg.version = previous.version;
  return cfg;
}
