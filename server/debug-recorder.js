import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG = '89504e470d0a1a0a';
const MAX_IMAGE = 2 * 1024 * 1024;
const ENUM = new Set(['yes','no','unsure','gameplay','map','editor','menu','unknown','same','changed','ready']);
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const number = value => Number.isFinite(value) ? value : undefined;
const code = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(value) ? value : undefined;
const id = value => typeof value === 'string' && UUID.test(value) ? value : undefined;
const eventId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(value) ? value : undefined;
const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const bounded = (value, maximum) => Math.max(1, Math.min(maximum, Number.isInteger(value) ? value : maximum));

function structuredAnswers(raw) {
  const source = Array.isArray(raw) ? raw : raw?.answers;
  if (!Array.isArray(source)) return null;
  return { answers: source.slice(0, 14).map(answer => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { malformed: true };
    const name = typeof answer.name === 'string' && /^(?:scene|continuity|event:[a-z][a-z0-9-]{0,59})$/.test(answer.name) ? answer.name : undefined;
    const refusal = Object.hasOwn(answer, 'refusal') || answer.type === 'refusal';
    const result = clean({ name, type: ['choice','refusal'].includes(answer.type) ? answer.type : undefined,
      choice: ENUM.has(answer.choice) ? answer.choice : undefined,
      confidence: Number.isFinite(answer.confidence) ? answer.confidence : undefined,
      refusal: refusal ? true : undefined,
      malformed: answer.malformed === true ? true : undefined });
    if (answer.choice !== undefined && !ENUM.has(answer.choice)) result.malformed = true;
    if (answer.name !== undefined && name === undefined) result.malformed = true;
    if ((!refusal || Object.hasOwn(answer, 'confidence')) && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) { result.invalid_confidence = true; result.malformed = true; }
    if (answer.type !== undefined && !['choice','refusal'].includes(answer.type)) result.malformed = true;
    return result;
  }) };
}
function normalizedResult(result) {
  if (!result || typeof result !== 'object') return null;
  const events = {};
  for (const [name, value] of Object.entries(result.events || {}).slice(0, 12)) {
    if (!eventId(name)) continue;
    if (ENUM.has(value)) events[name] = value;
    else if (value && typeof value === 'object') events[name] = clean({ choice: ENUM.has(value.choice) ? value.choice : 'unsure',
      confidence: Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : null });
  }
  return clean({ valid: typeof result.valid === 'boolean' ? result.valid : undefined,
    scene: ENUM.has(result.scene) ? result.scene : undefined,
    continuity: ENUM.has(result.continuity) ? result.continuity : undefined, events });
}
function usageResult(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return clean({ input_tokens: number(usage.input_tokens), output_tokens: number(usage.output_tokens), total_tokens: number(usage.total_tokens),
    input_tokens_details: usage.input_tokens_details ? clean({ cached_tokens: number(usage.input_tokens_details.cached_tokens),
      cache_write_tokens: number(usage.input_tokens_details.cache_write_tokens) }) : undefined });
}
function definitionsResult(definitions) {
  return (Array.isArray(definitions) ? definitions : []).slice(0, 12).filter(item => eventId(item?.id)).map(item => clean({
    id: item.id, label: text(item.label, 100), description: text(item.description, 600), mode: ['instant','persistent'].includes(item.mode) ? item.mode : undefined,
    min_confidence: number(item.min_confidence) }));
}
function requestResult(row) {
  return { id: row.id, seq: Number.isSafeInteger(row.seq) ? row.seq : 0, stage: row.stage === 'review' ? 'review' : 'screen',
    started_at: number(row.started_at) ?? 0, finished_at: number(row.finished_at) ?? null,
    frame_ids: Array.isArray(row.frame_ids) ? row.frame_ids.filter(id).slice(0, 5) : [],
    missing_frames: Math.max(0, Math.min(5, Number.isInteger(row.missing_frames) ? row.missing_frames : 0)),
    definitions: definitionsResult(row.definitions), status: code(row.status) || 'interrupted', model: 'gpt-6-luna',
    latency_ms: number(row.latency_ms) ?? null, raw: structuredAnswers(row.raw), normalized: normalizedResult(row.normalized), usage: usageResult(row.usage) };
}
function decisionResult(value, fallback = {}) {
  return clean({ id: id(value.id) || fallback.id, seq: Number.isSafeInteger(value.seq) ? value.seq : fallback.seq,
    at: number(value.at) ?? fallback.at, kind: code(value.kind) || 'observation', reason: code(value.reason),
    event_id: eventId(value.event_id), request_id: id(value.request_id), frame_ids: Array.isArray(value.frame_ids) ? value.frame_ids.filter(id).slice(0, 5) : undefined,
    confidence: number(value.confidence), threshold: number(value.threshold), accepted: typeof value.accepted === 'boolean' ? value.accepted : undefined,
    stage: ['screen','review'].includes(value.stage) ? value.stage : undefined,
    yes_count: Number.isSafeInteger(value.yes_count) ? value.yes_count : undefined,
    no_count: Number.isSafeInteger(value.no_count) ? value.no_count : undefined,
    armed: typeof value.armed === 'boolean' ? value.armed : undefined,
    latched: typeof value.latched === 'boolean' ? value.latched : undefined,
    outcome: code(value.outcome), epoch: Number.isSafeInteger(value.epoch) ? value.epoch : undefined });
}

/** Private bounded diagnostics. Recorder failures are fixed codes and never escape into recognition. */
export class DebugRecorder {
  constructor({ directory, now = Date.now, maxFrames = 5000, maxBytes = 512 * 1024 * 1024, maxRequests = 5000, maxDecisions = 10000,
    maxMetadataBytes = 32 * 1024 * 1024 } = {}) {
    if (!directory) throw Error('A private debug directory is required.');
    this.directory = path.resolve(directory);
    this.now = now;
    this.limits = { max_frames: bounded(maxFrames, 5000), max_bytes: bounded(maxBytes, 512 * 1024 * 1024),
      max_requests: bounded(maxRequests, 5000), max_decisions: bounded(maxDecisions, 10000), max_metadata_bytes: bounded(maxMetadataBytes, 32 * 1024 * 1024) };
    this.enabled = false;
    this.closed = false;
    this.frames = [];
    this.requests = [];
    this.decisions = [];
    this.sequence = 0;
    this.counts = { total_frames: 0, expired_frames: 0, dropped_frames: 0, expired_requests: 0, expired_decisions: 0, storage_errors: 0 };
    this.bytes = 0;
    this.metadataBytes = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.ready = false;
    this.storageBlocked = false;
    this.dirty = false;
    this.timer = null;
  }
  static async open(options) {
    const recorder = new DebugRecorder(options);
    const indexedFiles = new Set();
    try {
      const stat = await fs.lstat(recorder.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe debug directory');
      await recorder.ensureDirectory();
      const handle = await fs.open(path.join(recorder.directory, 'index.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let saved;
      try { recorder.metadataBytes = (await handle.stat()).size; if (recorder.metadataBytes > 64 * 1024 * 1024) throw Error('Debug index too large'); await handle.chmod(0o600); saved = JSON.parse(await handle.readFile('utf8')); }
      finally { await handle.close(); }
      if (saved?.version !== 1 || !Array.isArray(saved.frames) || !Array.isArray(saved.requests) || !Array.isArray(saved.decisions)) throw Error('Invalid debug index');
      recorder.enabled = saved.enabled === true;
      recorder.sequence = Number.isSafeInteger(saved.sequence) ? saved.sequence : 0;
      for (const row of saved.frames) if (id(row?.id)) indexedFiles.add(row.id + '.png');
      for (const row of saved.frames.slice(-recorder.limits.max_frames)) {
        if (!id(row.id) || !Number.isSafeInteger(row.seq) || !Number.isFinite(row.captured_at) || !Number.isInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_IMAGE) continue;
        recorder.frames.push({ id: row.id, seq: row.seq, capture_id: text(row.capture_id, 128) || '', captured_at: row.captured_at,
          width: number(row.width) ?? 0, height: number(row.height) ?? 0, bytes: row.bytes, image_available: row.image_available === true,
          screen_request_ids: (Array.isArray(row.screen_request_ids) ? row.screen_request_ids : []).filter(id).slice(-20),
          review_request_ids: (Array.isArray(row.review_request_ids) ? row.review_request_ids : []).filter(id).slice(-20) });
        recorder.bytes += row.bytes;
      }
      recorder.requests = saved.requests.filter(row => id(row?.id)).slice(-recorder.limits.max_requests).map(requestResult);
      recorder.decisions = saved.decisions.filter(row => id(row?.id)).slice(-recorder.limits.max_decisions).map(row => decisionResult(row));
      for (const name of Object.keys(recorder.counts)) if (Number.isSafeInteger(saved.counts?.[name]) && saved.counts[name] >= 0) recorder.counts[name] = saved.counts[name];
      // First use is off; an explicit operator choice survives an application restart.
      for (const request of recorder.requests) if (request.status === 'pending') { request.status = 'interrupted'; request.finished_at = recorder.now(); }
    } catch (error) { if (error.code !== 'ENOENT') { recorder.counts.storage_errors++; recorder.storageBlocked = true; recorder.enabled = false; } }
    if (recorder.ready && !recorder.storageBlocked) {
      try {
        const retained = new Set(recorder.frames.map(row => row.id + '.png'));
        for (const filename of await fs.readdir(path.join(recorder.directory, 'frames'))) {
          if (filename.endsWith('.png') && id(filename.slice(0, -4)) && !retained.has(filename)) {
            if (indexedFiles.has(filename)) { await fs.unlink(path.join(recorder.directory, 'frames', filename)); continue; }
            // Recover a completed image write whose debounced index did not survive a crash.
            const file = path.join(recorder.directory, 'frames', filename);
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE) continue;
              const header = Buffer.alloc(24); await handle.read(header, 0, 24, 0);
              if (header.toString('hex', 0, 8) !== PNG) continue;
              recorder.frames.push({ id: filename.slice(0, -4), seq: ++recorder.sequence, capture_id: 'recovered-after-interruption',
                captured_at: stat.mtimeMs, width: header.readUInt32BE(16), height: header.readUInt32BE(20), bytes: stat.size,
                image_available: true, screen_request_ids: [], review_request_ids: [] });
              recorder.bytes += stat.size; recorder.counts.total_frames++;
            } finally { await handle.close(); }
          }
        }
        recorder.evictFrames();
        for (const row of recorder.frames) {
          try {
            const file = path.join(recorder.directory, 'frames', row.id + '.png');
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.bytes) throw Error('Missing debug image');
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { await handle.chmod(0o600); } finally { await handle.close(); }
            row.image_available = true;
          } catch { row.image_available = false; }
        }
      } catch { recorder.counts.storage_errors++; }
    }
    return recorder;
  }
  async ensureDirectory() {
    for (const directory of [this.directory, path.join(this.directory, 'frames')]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await fs.lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('Unsafe debug directory');
      await fs.chmod(directory, 0o700);
    }
    this.ready = true;
  }
  enqueue(operation) {
    this.pending++;
    this.queue = this.queue.then(operation).catch(() => { this.counts.storage_errors++; }).finally(() => { this.pending--; });
    return this.queue;
  }
  scheduleIndex() {
    this.dirty = true;
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.persist(); }, 1000);
    this.timer.unref?.();
  }
  serializeIndex() {
    const serialize = () => JSON.stringify({ version: 1, enabled: this.enabled, sequence: this.sequence, frames: this.frames,
      requests: this.requests, decisions: this.decisions, counts: this.counts });
    let data = serialize();
    let bytes = Buffer.byteLength(data);
    if (bytes <= this.limits.max_metadata_bytes) return data;
    // Subtract row sizes before serializing again: never repeatedly serialize a multi-MiB
    // manifest once per expired row. Frame identities and sent-to-model links survive.
    const target = Math.max(0, this.limits.max_metadata_bytes - 1024);
    while (bytes > target && (this.requests.length || this.decisions.length)) {
      if (this.requests.length && (!this.decisions.length || this.requests[0].seq <= this.decisions[0].seq)) {
        const row = this.requests.shift();
        bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
        this.counts.expired_requests++;
      } else {
        const row = this.decisions.shift();
        bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
        this.counts.expired_decisions++;
      }
    }
    data = serialize();
    if (Buffer.byteLength(data) > this.limits.max_metadata_bytes) throw Error('Debug metadata quota exceeded');
    return data;
  }
  async persist() {
    if (!this.dirty || !this.ready || this.storageBlocked) return;
    this.dirty = false;
    return this.enqueue(async () => {
      await this.ensureDirectory();
      const data = this.serializeIndex();
      const temporary = path.join(this.directory, `index.${randomUUID()}.tmp`);
      let created = false;
      try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        const target = path.join(this.directory, 'index.json');
        try { if ((await fs.lstat(target)).isSymbolicLink()) throw Error('Unsafe debug index'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temporary, target);
        this.metadataBytes = Buffer.byteLength(data);
      } finally { if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(Error('invalid_debug_enabled'), { status: 400, code: 'invalid_debug_enabled' });
    if (this.closed) throw Object.assign(Error('debug_unavailable'), { status: 503, code: 'debug_unavailable' });
    if (this.storageBlocked && enabled) throw Object.assign(Error('debug_storage_unavailable'), { status: 503, code: 'debug_storage_unavailable' });
    if (enabled) {
      try { await this.ensureDirectory(); } catch { this.counts.storage_errors++; throw Object.assign(Error('debug_storage_unavailable'), { status: 503, code: 'debug_storage_unavailable' }); }
    }
    this.enabled = enabled;
    this.scheduleIndex();
    await this.flush();
    return this.state();
  }
  recordFrame(observation) {
    if (!this.enabled || this.closed || this.storageBlocked) return null;
    try {
      this.counts.total_frames++;
      const known = this.findFrame(observation);
      if (known) { this.counts.total_frames--; return known.id; }
      if (this.pending >= 64) { this.counts.dropped_frames++; this.scheduleIndex(); return null; }
      if (!observation || typeof observation.id !== 'string' || !observation.id || observation.id.length > 128 || !Number.isFinite(observation.at)) throw Error('Invalid frame');
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(observation.dataUrl || '');
      if (!match || match[1].length > Math.ceil(MAX_IMAGE * 4 / 3) + 4) throw Error('Invalid frame');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length < 24 || bytes.length > MAX_IMAGE || bytes.toString('hex', 0, 8) !== PNG || bytes.toString('base64') !== match[1]) throw Error('Invalid frame');
      const row = { id: randomUUID(), seq: ++this.sequence, capture_id: observation.id, captured_at: observation.at,
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, image_available: false,
        screen_request_ids: [], review_request_ids: [] };
      if (!row.width || !row.height || row.width > 1920 || row.height > 1080) throw Error('Invalid frame');
      this.frames.push(row);
      // Account for reserved writes immediately, keeping both disk and queued bytes bounded.
      this.bytes += row.bytes;
      this.enqueue(async () => {
        try {
          await this.ensureDirectory();
          if (!this.frames.includes(row)) return;
          const handle = await fs.open(path.join(this.directory, 'frames', row.id + '.png'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
          row.image_available = true;
        } catch { this.counts.dropped_frames++; throw Error('Debug image unavailable'); }
      });
      this.evictFrames();
      this.scheduleIndex();
      return row.id;
    } catch { this.counts.dropped_frames++; this.scheduleIndex(); return null; }
  }
  findFrame(frame) {
    if (!frame || !Number.isFinite(frame.at)) return null;
    return this.frames.findLast(row => row.captured_at === frame.at && (frame.id === undefined || row.capture_id === frame.id));
  }
  evictFrames() {
    while (this.frames.length > this.limits.max_frames || this.bytes > this.limits.max_bytes) {
      const row = this.frames.shift();
      if (!row) break;
      this.bytes = Math.max(0, this.bytes - row.bytes);
      this.counts.expired_frames++;
      this.enqueue(async () => { await fs.unlink(path.join(this.directory, 'frames', row.id + '.png')).catch(error => { if (error.code !== 'ENOENT') throw error; }); });
    }
  }
  beginRequest({ stage, frames = [], definitions = [] } = {}) {
    if (!this.enabled || this.closed || !['screen','review'].includes(stage)) return null;
    try {
      const frameRows = frames.slice(0, 5).map(frame => typeof frame === 'string' ? this.frames.find(row => row.id === frame) : this.findFrame(frame)).filter(Boolean);
      const row = { id: randomUUID(), seq: ++this.sequence, stage, started_at: this.now(), finished_at: null,
        frame_ids: frameRows.map(frame => frame.id), missing_frames: Math.max(0, Math.min(5, frames.length) - frameRows.length),
        definitions: definitionsResult(definitions), status: 'pending', model: 'gpt-6-luna', latency_ms: null,
        raw: null, normalized: null, usage: null };
      for (const frame of frameRows) {
        const links = frame[stage === 'screen' ? 'screen_request_ids' : 'review_request_ids'];
        links.push(row.id);
        if (links.length > 20) links.splice(0, links.length - 20);
      }
      this.requests.push(row);
      if (this.requests.length > this.limits.max_requests) this.counts.expired_requests += this.requests.splice(0, this.requests.length - this.limits.max_requests).length;
      this.scheduleIndex();
      return row.id;
    } catch { this.counts.storage_errors++; return null; }
  }
  finishRequest(requestId, result = {}) {
    try {
      const row = this.requests.find(item => item.id === requestId);
      if (!row) return;
      row.finished_at = this.now();
      if (Object.hasOwn(result, 'outcome')) row.status = code(result.outcome) || 'completed';
      else if (row.status === 'pending') row.status = 'unavailable';
      if (Object.hasOwn(result, 'model') && result.model === 'gpt-6-luna') row.model = result.model;
      if (Object.hasOwn(result, 'latency_ms')) row.latency_ms = number(result.latency_ms) ?? null;
      if (Object.hasOwn(result, 'raw')) row.raw = structuredAnswers(result.raw);
      if (Object.hasOwn(result, 'normalized')) row.normalized = normalizedResult(result.normalized);
      if (Object.hasOwn(result, 'usage')) row.usage = usageResult(result.usage);
      this.scheduleIndex();
    } catch { this.counts.storage_errors++; }
  }
  recordDecision(value = {}) {
    if (!this.enabled || this.closed) return null;
    try {
      const row = decisionResult({ ...value, id: randomUUID(), seq: ++this.sequence, at: this.now() });
      this.decisions.push(row);
      if (this.decisions.length > this.limits.max_decisions) this.counts.expired_decisions += this.decisions.splice(0, this.decisions.length - this.limits.max_decisions).length;
      this.scheduleIndex();
      return row.id;
    } catch { this.counts.storage_errors++; return null; }
  }
  state() {
    return { enabled: this.enabled, limits: { ...this.limits }, stats: { frames: this.frames.length, bytes: this.bytes, metadata_bytes: this.metadataBytes, requests: this.requests.length, decisions: this.decisions.length,
      ...this.counts, pending_writes: this.pending } };
  }
  query({ before, limit = 100, frame_id, request_id } = {}) {
    const count = Math.max(1, Math.min(250, Number.isInteger(limit) ? limit : 100));
    let frames, requests;
    if (frame_id) {
      frames = this.frames.filter(row => row.id === frame_id);
      requests = this.requests.filter(row => row.frame_ids.includes(frame_id));
    } else if (request_id) {
      requests = this.requests.filter(row => row.id === request_id);
      frames = this.frames.filter(frame => requests.some(request => request.frame_ids.includes(frame.id)));
    } else {
      frames = this.frames.filter(row => before === undefined || row.seq < before).slice(-count).reverse();
      const referenced = new Set(frames.flatMap(frame => [...frame.screen_request_ids, ...frame.review_request_ids]));
      requests = this.requests.filter((row, index) => referenced.has(row.id) || index >= this.requests.length - 100);
    }
    const associatedRequests = new Set(requests.map(row => row.id));
    const decisions = this.decisions.filter((row, index) => associatedRequests.has(row.request_id) || index >= this.decisions.length - 100).slice(-1000);
    return structuredClone({ ...this.state(), frames: frames.map(row => ({ ...row, image_url: `/api/operator/debug/frame/${row.id}` })),
      requests, decisions, next_cursor: !frame_id && !request_id && frames.length === count ? frames.at(-1).seq : null });
  }
  request(requestId) { return structuredClone(this.requests.find(row => row.id === requestId) || null); }
  async image(frameId) {
    if (!id(frameId)) return null;
    const row = this.frames.find(item => item.id === frameId);
    if (!row?.image_available) return null;
    try {
      // Recheck every parent each read; a local symlink substitution must never disclose another file.
      for (const directory of [this.directory, path.join(this.directory, 'frames')]) {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      }
      const handle = await fs.open(path.join(this.directory, 'frames', frameId + '.png'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_IMAGE) return null; const data = await handle.readFile();
        if (data.toString('hex', 0, 8) !== PNG) return null; return { data, type: 'image/png' }; }
      finally { await handle.close(); }
    } catch { return null; }
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.persist();
    await this.queue;
  }
  async close() { await this.flush(); this.closed = true; }
}
