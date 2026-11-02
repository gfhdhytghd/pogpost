import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16384;
const sha256 = (value) => createHash('sha256').update(value).digest('base64');
const unavailable = () => Error('OBS screenshot unavailable');

function localURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('OBS WebSocket URL must use loopback'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw Error('OBS WebSocket URL must use loopback');
  // A literal destination prevents a local hostname override from forwarding authentication elsewhere.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

function screenshot(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 40 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable();
  const encoded = value.slice(value.indexOf(',') + 1);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 8 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes.toString('base64') !== encoded) throw unavailable();
  return value;
}

/** Optional, lazy OBS WebSocket v5 reader. It requests exactly one named source and never controls OBS. */
export function createOBSSource({ url = 'ws://127.0.0.1:4455', password = '', sourceName = '', socketFactory = (address, options) => new WebSocket(address, options),
  timeoutMs = 1500, now = Date.now, width = 960, height = 540, intervalMs = 2000, scheduleToleranceMs = 0 } = {}) {
  const address = localURL(url);
  if (typeof password !== 'string' || typeof sourceName !== 'string' || sourceName.length > 256) throw Error('Invalid OBS screenshot configuration');
  if (!Number.isInteger(width) || width < 320 || width > 1920 || !Number.isInteger(height) || height < 180 || height > 1080) throw Error('Invalid OBS screenshot dimensions');
  const timeout = Math.max(1, Math.min(3000, Number(timeoutMs) || 1500));
  if (!Number.isInteger(intervalMs) || intervalMs < 200 || intervalMs > 10000) throw Error('Invalid OBS capture interval');
  if (!Number.isInteger(scheduleToleranceMs) || scheduleToleranceMs < 0 || scheduleToleranceMs > 20) throw Error('Invalid OBS scheduler tolerance');
  let socket = null, connectPromise = null, connectWaiter = null, readPromise = null, framePromise = null, ready = false, closed = false;
  let lastObservation = null, observationSequence = 0, lastRequestAt = -Infinity, requests = 0, failures = 0, status = sourceName ? 'idle' : 'unconfigured';
  const pending = new Map();
  function disconnect() {
    ready = false;
    const old = socket;
    socket = null;
    lastObservation = null;
    connectWaiter?.reject(unavailable());
    connectWaiter = null;
    for (const item of pending.values()) item.reject(unavailable());
    pending.clear();
    try { old?.close(); } catch { /* The public error remains generic. */ }
  }
  function connect() {
    if (ready && socket) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { finish(unavailable()); disconnect(); }, timeout);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connectWaiter = null;
        if (error) reject(unavailable()); else resolve();
      };
      connectWaiter = { reject: finish };
      try {
        const current = socketFactory(address, { maxPayload: MAX_MESSAGE_BYTES, followRedirects: false });
        socket = current;
        current.on('error', () => { if (socket === current) { finish(unavailable()); disconnect(); } });
        current.on('close', () => { if (socket === current) { finish(unavailable()); disconnect(); if (!closed) status = 'unavailable'; } });
        current.on('message', (raw) => {
          if (socket !== current || closed) return;
          try {
            if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw unavailable();
            const message = JSON.parse(raw.toString());
            if (message.op === 0 && !ready) {
              const auth = message.d?.authentication;
              if (auth && (typeof auth.salt !== 'string' || auth.salt.length > 1024 || typeof auth.challenge !== 'string' || auth.challenge.length > 1024)) throw unavailable();
              const authentication = auth ? sha256(sha256(password + auth.salt) + auth.challenge) : undefined;
              current.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(authentication ? { authentication } : {}) } }));
            } else if (message.op === 2) {
              ready = true;
              status = 'ready';
              finish();
            } else if (message.op === 7) {
              const item = pending.get(message.d?.requestId);
              if (!item) return;
              pending.delete(message.d.requestId);
              if (message.d.requestStatus?.result === true) item.resolve(message.d.responseData);
              else item.reject(unavailable());
            }
          } catch { finish(unavailable()); disconnect(); }
        });
      } catch { finish(unavailable()); disconnect(); }
    }).finally(() => { connectPromise = null; });
    return connectPromise;
  }
  function requestScreenshot() {
    requests++;
    lastRequestAt = now();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(unavailable());
        disconnect();
      }, timeout);
      const finish = (error, data) => {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(unavailable()); else resolve(data);
      };
      pending.set(id, { resolve: (data) => finish(null, { data, at: now() }), reject: () => finish(unavailable()) });
      try {
        socket.send(JSON.stringify({ op: 6, d: { requestType: 'GetSourceScreenshot', requestId: id,
          requestData: { sourceName, imageFormat: 'png', imageWidth: width, imageHeight: height } } }));
      } catch { finish(unavailable()); disconnect(); }
    });
  }
  function readObservation() {
    if (closed || !sourceName) return Promise.resolve(null);
    if (readPromise) return readPromise;
    // A bounded tolerance prevents a nominal 200 ms timer's 199 ms tick from losing a frame.
    if (now() - lastRequestAt < intervalMs - scheduleToleranceMs) return Promise.resolve(lastObservation);
    readPromise = (async () => {
      try {
        status = 'connecting';
        await connect();
        if (closed) return null;
        const captureSocket = socket;
        const result = await requestScreenshot();
        if (closed || socket !== captureSocket || !ready) return null;
        const dataUrl = screenshot(result.data?.imageData);
        if (!Number.isFinite(result.at)) throw unavailable();
        lastObservation = Object.freeze({ dataUrl, at: result.at, id: String(++observationSequence) });
        status = 'ready';
        return lastObservation;
      } catch {
        failures++;
        status = closed ? 'closed' : 'unavailable';
        disconnect();
        return null;
      } finally { readPromise = null; }
    })();
    return readPromise;
  }
  return {
    readObservation,
    readFrame() {
      if (closed || !sourceName) return Promise.resolve(null);
      if (framePromise) return framePromise;
      framePromise = readObservation().then(observation => !closed && observation === lastObservation ? observation?.dataUrl ?? null : null).finally(() => { framePromise = null; });
      return framePromise;
    },
    close() { closed = true; status = 'closed'; disconnect(); },
    state() { return { configured: !!sourceName, status, connected: ready, in_flight: !!readPromise, interval_ms: intervalMs, width, height, requests, failures, max_image_bytes: MAX_IMAGE_BYTES }; },
  };
}
