import { createHash } from 'node:crypto';
import { createTextPolicy } from '../engine/content.js';
import { validateEventDefinitions } from './event-definitions.js';
import { BUILTIN_EVENT_PRESET_IDS } from './event-presets.js';

export const MAX_EVENT_PROFILES = 20;
export const eventProfileContext = (ref, epoch = 0) => !ref && epoch === 0 ? '' : JSON.stringify([ref?.kind ?? null, ref?.id ?? null, ref?.revision ?? null, epoch]);
export function validateEventProfileContextEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Invalid event profile context.'), { status: 503, code: 'profile_context_unavailable' });
  return value;
}
const ID = /^profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code = 'invalid_profile', message = 'Invalid event profile.', status = 400) => Object.assign(new Error(message), { status, code });
const policy = createTextPolicy();
const text = (value, maximum, optional = false) => {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || !value || [...value].length > maximum || policy.safeText(value, '', maximum * 2) !== value) throw error();
  return value;
};
const exact = (value, allowed, required) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw error();
};
export const profileLabelKey = label => label.normalize('NFKC').toLowerCase();
export function validateProfileId(id) {
  if (BUILTIN_EVENT_PRESET_IDS.includes(id)) throw error('profile_read_only', 'Built-in profiles cannot be overwritten.', 403);
  if (typeof id !== 'string' || !ID.test(id)) throw error();
  return id;
}
export function validateProfileRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw error('profile_revision_required', 'A saved profile revision is required.');
  return value;
}

/** Only this operator-owned input can create or update a saved snapshot. */
export function validateEventProfileInput(input) {
  exact(input, ['id', 'expected_revision', 'label', 'description', 'events'], ['label', 'events']);
  const result = { label: text(input.label, 80), description: text(Object.hasOwn(input, 'description') ? input.description : '', 300, true), events: validateEventDefinitions(input.events) };
  if (Object.hasOwn(input, 'id')) {
    result.id = validateProfileId(input.id);
    result.expected_revision = validateProfileRevision(input.expected_revision);
  } else if (Object.hasOwn(input, 'expected_revision')) throw error();
  return result;
}

/** Sorting normalized definitions makes metadata independent of display order. */
export function eventProfileHash(events) {
  const canonical = validateEventDefinitions(events).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function validateStoredEventProfiles(input) {
  if (!Array.isArray(input)) throw error();
  if (input.length > MAX_EVENT_PROFILES) throw error('profile_limit', 'Save at most 20 event profiles.');
  const ids = new Set(), labels = new Set();
  return Array.from(input, profile => {
    exact(profile, ['id','revision','label','description','events','created_at','updated_at'], ['id','revision','label','description','events','created_at','updated_at']);
    const id = validateProfileId(profile.id), revision = validateProfileRevision(profile.revision);
    const label = text(profile.label, 80), description = text(profile.description, 300, true);
    if (ids.has(id)) throw error();
    if (labels.has(profileLabelKey(label))) throw error('profile_name_in_use', 'A saved profile already uses this name.', 409);
    ids.add(id); labels.add(profileLabelKey(label));
    if (!Number.isSafeInteger(profile.created_at) || profile.created_at < 0 || !Number.isSafeInteger(profile.updated_at) || profile.updated_at < profile.created_at) throw error();
    return { id, revision, label, description, events: validateEventDefinitions(profile.events), created_at: profile.created_at, updated_at: profile.updated_at };
  });
}

export function validateEventProfileActiveRef(input, profiles) {
  if (input === null) return null;
  exact(input, ['kind','id','revision','label','events_hash'], ['kind','id','revision','label','events_hash']);
  if (!['builtin', 'profile'].includes(input.kind)) throw error();
  const revision = validateProfileRevision(input.revision), label = text(input.label, 80);
  if (typeof input.events_hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.events_hash)) throw error();
  if (input.kind === 'builtin') {
    if (!BUILTIN_EVENT_PRESET_IDS.includes(input.id) || revision !== 1) throw error();
  } else {
    validateProfileId(input.id);
    const profile = profiles.find(value => value.id === input.id);
    if (!profile || revision > profile.revision) throw error();
  }
  return { kind: input.kind, id: input.id, revision, label, events_hash: input.events_hash };
}

export function validateEventProfileSelection(input) {
  exact(input, ['kind','id','expected_revision'], ['kind','id']);
  if (!['builtin','profile'].includes(input.kind)) throw error();
  if (input.kind === 'builtin') {
    if (!BUILTIN_EVENT_PRESET_IDS.includes(input.id)) throw error('profile_not_found', 'Event profile not found.', 404);
    if (Object.hasOwn(input, 'expected_revision') && validateProfileRevision(input.expected_revision) !== 1) throw error('profile_revision_conflict', 'This profile changed. Refresh before applying.', 409);
    return { kind: input.kind, id: input.id };
  }
  return { kind: input.kind, id: validateProfileId(input.id), expected_revision: validateProfileRevision(input.expected_revision) };
}
