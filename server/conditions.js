import { domainError } from './config.js';

export function validateCondition(input, moments) {
  if (input === undefined || input === null) return { type: 'moment' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw domainError('invalid_condition', 'Invalid condition.');
  const type = input.type ?? input.kind;
  if (type === 'moment') return { type };
  if (type === 'count') {
    const count = input.count ?? input.n;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw domainError('invalid_condition', 'Count must be between 1 and 100.');
    return { type, count };
  }
  if (type === 'window') {
    const before_minutes = input.before_minutes ?? input.before_minute;
    if (!Number.isFinite(before_minutes) || before_minutes <= 0 || before_minutes > 1440) throw domainError('invalid_condition', 'Window must be between 0 and 1440 minutes.');
    return { type, before_minutes };
  }
  if (type === 'after') {
    const after_moment_id = input.after_moment_id ?? input.after;
    if (!moments.some(moment => moment.id === after_moment_id) || after_moment_id === 'never') throw domainError('invalid_condition', 'Unknown preceding moment.');
    return { type, after_moment_id };
  }
  throw domainError('invalid_condition', 'Unknown condition type.');
}

export function conditionExpired(note, session, now) {
  return note.condition.type === 'window' && now >= (note.condition_deadline_at ?? session.started_at + note.condition.before_minutes * 60000);
}

/** Count and after conditions start at sealing; earlier events cannot open a new note. */
export function conditionMatches(note, occurrence, occurrences, session) {
  if (note.moment_id !== occurrence.moment_id || occurrence.at < note.sealed_at) return false;
  const events = occurrences.filter(event => event.sequence > (note.condition_sequence ?? 0));
  switch (note.condition.type) {
    case 'count': return events.filter(event => event.moment_id === note.moment_id).length >= note.condition.count;
    case 'window': return occurrence.at < (note.condition_deadline_at ?? session.started_at + note.condition.before_minutes * 60000);
    case 'after': return events.some(event => event.moment_id === note.condition.after_moment_id && event.sequence < occurrence.sequence);
    default: return true;
  }
}

/** Optional text compilers can only produce this bounded data schema. */
export function validateCompiledCondition(input, moments) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw domainError('invalid_condition', 'Invalid compiled condition.');
  const fields = { count: ['type', 'count'], window: ['type', 'before_minutes'], after: ['type', 'after_moment_id'] };
  const allowed = typeof input.type === 'string' && Object.hasOwn(fields, input.type) ? fields[input.type] : null;
  if (!allowed || Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) throw domainError('invalid_condition', 'The compiler must return a count, window, or after condition.');
  return validateCondition(input, moments);
}
