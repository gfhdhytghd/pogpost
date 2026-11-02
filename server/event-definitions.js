import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createTextPolicy } from '../engine/content.js';

export const MAX_EVENT_DEFINITIONS = 12;
const MAX_PRESET_BYTES = 64 * 1024;
const fields = ['id', 'label', 'description', 'mode', 'min_confidence', 'cooldown_s', 'auto_confirm'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const invalid = () => error('invalid_event_definition', 'Invalid event definition.');
const policy = createTextPolicy();
const text = (value, max) => {
  if (typeof value !== 'string' || !value || [...value].length > max || policy.safeText(value, '', max * 2) !== value) throw invalid();
  return value;
};

/** Definitions are bounded data. No executable fields or provider options are accepted. */
export function validateEventDefinition(input) {
  if (!object(input) || ['id', 'label', 'description', 'mode'].some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !fields.includes(key)) ||
    typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(input.id) ||
    !['persistent', 'instant'].includes(input.mode)) throw invalid();
  const min_confidence = input.min_confidence === undefined ? 0.85 : input.min_confidence;
  const cooldown_s = input.cooldown_s === undefined ? 30 : input.cooldown_s;
  const auto_confirm = input.auto_confirm === undefined ? false : input.auto_confirm;
  if (!Number.isFinite(min_confidence) || min_confidence < 0 || min_confidence > 1 ||
    !Number.isInteger(cooldown_s) || cooldown_s < 1 || cooldown_s > 3600 || typeof auto_confirm !== 'boolean') throw invalid();
  return { id: input.id, label: text(input.label, 100), description: text(input.description, 300), mode: input.mode,
    min_confidence, cooldown_s, auto_confirm };
}

export function validateEventDefinitions(input) {
  if (!Array.isArray(input)) throw invalid();
  if (input.length > MAX_EVENT_DEFINITIONS) throw error('event_limit', 'Configure at most 12 events.');
  const ids = new Set();
  return Array.from(input, value => {
    const definition = validateEventDefinition(value);
    if (ids.has(definition.id)) throw error('duplicate_event', 'Event ids must be unique.');
    ids.add(definition.id);
    return definition;
  });
}

/** Read a public, bounded preset without following a final symlink or retaining frame data. */
export async function loadEventPreset(file) {
  let handle;
  let payload;
  const badFile = () => error('invalid_event_preset', 'Invalid event preset file.');
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PRESET_BYTES) throw badFile();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_PRESET_BYTES) throw badFile();
    const buffer = Buffer.alloc(MAX_PRESET_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_PRESET_BYTES) throw badFile();
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } catch { throw badFile(); }
  finally { await handle?.close(); }
  if (!object(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'version') || !Object.hasOwn(payload, 'events') || payload.version !== 1) throw badFile();
  return { version: 1, events: validateEventDefinitions(payload.events) };
}
