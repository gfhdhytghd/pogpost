import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOBSSource } from '../server/obs-source.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';

/** Exercise the OBS v5 handshake and request/response protocol without network access. */
function mockOBS() {
  const sockets = [], sent = [], waiting = [], requests = [];
  const factory = () => {
    const socket = new EventEmitter();
    socket.closed = false;
    socket.close = () => {
      if (socket.closed) return;
      socket.closed = true;
      socket.emit('close');
    };
    socket.send = raw => {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.op === 1) queueMicrotask(() => socket.emit('message', JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })));
      if (message.op === 6) {
        const request = { socket, message };
        if (waiting.length) waiting.shift()(request);
        else requests.push(request);
      }
    };
    sockets.push(socket);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ op: 0, d: { rpcVersion: 1 } })));
    return socket;
  };
  const nextRequest = () => requests.length ? Promise.resolve(requests.shift()) : new Promise(resolve => waiting.push(resolve));
  const reply = (request, { image = PNG, success = true } = {}) => request.socket.emit('message', JSON.stringify({
    op: 7,
    d: {
      requestId: request.message.d.requestId,
      requestType: 'GetSourceScreenshot',
      requestStatus: { result: success, code: success ? 100 : 600 },
      responseData: { imageData: image },
    },
  }));
  return { factory, nextRequest, reply, sockets, sent };
}

test('OBS observations share a capture across both APIs and keep the successful response timestamp', async t => {
  let now = 1000;
  const mock = mockOBS();
  const source = createOBSSource({ sourceName: 'Selected Source', password: 'private-password', socketFactory: mock.factory, now: () => now });
  t.after(() => source.close());
  const observationPromise = source.readObservation();
  assert.equal(source.readObservation(), observationPromise);
  const framePromise = source.readFrame();
  assert.equal(source.readFrame(), framePromise);
  const request = await mock.nextRequest();
  assert.equal(request.message.d.requestType, 'GetSourceScreenshot');
  assert.deepEqual(request.message.d.requestData, { sourceName: 'Selected Source', imageFormat: 'png', imageWidth: 960, imageHeight: 540 });
  now = 1234;
  mock.reply(request);
  now = 1400;
  const observation = await observationPromise;
  assert.equal(await framePromise, PNG);
  assert.deepEqual(Object.keys(observation).sort(), ['at', 'dataUrl', 'id']);
  assert.equal(observation.dataUrl, PNG);
  assert.equal(observation.at, 1234);
  assert.equal(typeof observation.id, 'string');
  assert.match(observation.id, /^\d+$/);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(source.state().requests, 1);
  assert.equal(JSON.stringify(observation).includes('private-password'), false);
  assert.equal(JSON.stringify(observation).includes('Selected Source'), false);
  assert.equal(JSON.stringify(source.state()).includes(PNG), false);

  now = 2999;
  assert.equal(await source.readObservation(), observation);
  assert.equal(await source.readFrame(), PNG);
  assert.equal((await source.readObservation()).at, 1234);
  assert.equal(source.state().requests, 1);

  now = 3000;
  const nextPromise = source.readObservation();
  const nextRequest = await mock.nextRequest();
  now = 3456;
  mock.reply(nextRequest);
  const next = await nextPromise;
  assert.equal(next.at, 3456);
  assert.ok(Number(next.id) > Number(observation.id));
  assert.equal(next.dataUrl, observation.dataUrl); // Identical pixels still come from a distinct capture.
  assert.equal(mock.sockets.length, 1);
  assert.equal(source.state().requests, 2);
});

test('disconnect discards cached metadata and reconnect keeps capture ids increasing', async t => {
  let now = 0;
  const mock = mockOBS();
  const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory, now: () => now });
  t.after(() => source.close());
  const firstPromise = source.readObservation();
  const firstRequest = await mock.nextRequest();
  now = 100;
  mock.reply(firstRequest);
  const first = await firstPromise;
  mock.sockets[0].close();
  now = 101;
  assert.equal(await source.readObservation(), null);
  assert.equal(await source.readFrame(), null);
  assert.equal(source.state().connected, false);
  assert.equal(mock.sockets.length, 1);
  now = 2000;
  const secondPromise = source.readObservation();
  const secondRequest = await mock.nextRequest();
  now = 2100;
  mock.reply(secondRequest);
  const second = await secondPromise;
  assert.equal(second.at, 2100);
  assert.ok(Number(second.id) > Number(first.id));
  assert.equal(mock.sockets.length, 2);
  source.close();
  assert.equal(await source.readObservation(), null);
  assert.equal(await source.readFrame(), null);
  assert.equal(source.state().status, 'closed');
  assert.equal(mock.sockets.length, 2);
});

test('failed or malformed results clear old observations instead of refreshing their metadata', async t => {
  for (const failure of [{ success: false }, { image: 'data:image/png;base64,AAAA' }]) {
    let now = 0;
    const mock = mockOBS();
    const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory, now: () => now });
    t.after(() => source.close());
    const firstPromise = source.readObservation();
    mock.reply(await mock.nextRequest());
    const first = await firstPromise;
    now = 2000;
    const failedPromise = source.readObservation();
    mock.reply(await mock.nextRequest(), failure);
    assert.equal(await failedPromise, null);
    assert.equal(await source.readObservation(), null);
    assert.equal(await source.readFrame(), null);
    assert.equal(source.state().failures, 1);
    now = 4000;
    const recoveredPromise = source.readObservation();
    mock.reply(await mock.nextRequest());
    const recovered = await recoveredPromise;
    assert.equal(recovered.at, 4000);
    assert.ok(Number(recovered.id) > Number(first.id));
  }
});

test('closing or disconnecting immediately after a response cannot resurrect an observation', async () => {
  for (const closeSource of [false, true]) {
    const mock = mockOBS();
    const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory });
    const reading = source.readObservation();
    const request = await mock.nextRequest();
    mock.reply(request);
    if (closeSource) source.close(); else request.socket.close();
    assert.equal(await reading, null);
    assert.equal(await source.readObservation(), null);
    source.close();
  }
});

test('OBS dimensions accept only bounded integers and form an explicit screenshot payload', async t => {
  for (const options of [
    { width: 319 }, { width: 1921 }, { height: 179 }, { height: 1081 },
    { width: 1280.5 }, { height: 720.5 }, { width: '1280' }, { height: null },
    { width: NaN }, { height: Infinity },
  ]) assert.throws(() => createOBSSource(options), /Invalid OBS screenshot dimensions/);
  for (const [width, height] of [[320,180], [1920,1080], [1280,720]]) {
    const mock = mockOBS();
    const source = createOBSSource({ sourceName: 'Game', width, height, socketFactory: mock.factory, requestData: { sourceName: 'Other Source', imageFormat: 'jpeg' } });
    t.after(() => source.close());
    const reading = source.readObservation();
    const request = await mock.nextRequest();
    assert.deepEqual(request.message.d.requestData, { sourceName: 'Game', imageFormat: 'png', imageWidth: width, imageHeight: height });
    mock.reply(request);
    assert.equal((await reading).dataUrl, PNG);
  }
});

test('unconfigured and pending closed readers return no observation and never retain frames', async () => {
  const unconfigured = createOBSSource({ socketFactory: () => assert.fail('must not connect') });
  assert.equal(await unconfigured.readObservation(), null);
  unconfigured.close();
  const mock = mockOBS();
  const source = createOBSSource({ sourceName: 'Game', socketFactory: mock.factory });
  const observation = source.readObservation();
  const frame = source.readFrame();
  await mock.nextRequest();
  source.close();
  assert.equal(await observation, null);
  assert.equal(await frame, null);
  assert.equal(await source.readObservation(), null);
  assert.equal(mock.sockets.length, 1);
});

test('explicit 5 Hz OBS capture produces distinct metadata and throttles duplicate reads', async t => {
  let now = 0;
  const mock = mockOBS();
  const source = createOBSSource({ sourceName: 'Game', width: 640, height: 360, intervalMs: 200, socketFactory: mock.factory, now: () => now });
  t.after(() => source.close());
  const ids = new Set();
  for (let i = 0; i < 6; i++) {
    now = i * 200;
    const pending = source.readObservation();
    const request = await mock.nextRequest();
    mock.reply(request);
    const observation = await pending;
    ids.add(observation.id);
    now += 199;
    assert.equal(await source.readObservation(), observation);
  }
  assert.equal(ids.size, 6);
  assert.equal(source.state().requests, 6);
  assert.equal(source.state().interval_ms, 200);
  for (const intervalMs of [0, 199, 10001, '200', NaN, 200.5]) assert.throws(() => createOBSSource({ intervalMs }), /capture interval/);
});

test('bounded scheduler tolerance avoids cached duplicates on a nominal 5 Hz timer', async t => {
  let now = 0;
  const mock = mockOBS();
  const source = createOBSSource({ sourceName: 'Game', intervalMs: 200, scheduleToleranceMs: 20, socketFactory: mock.factory, now: () => now });
  t.after(() => source.close());
  let previous;
  for (const tick of [0, 199, 399, 598, 798]) {
    now = tick;
    const pending = source.readObservation();
    mock.reply(await mock.nextRequest());
    const observation = await pending;
    assert.notEqual(observation.id, previous?.id);
    previous = observation;
    now += 179;
    assert.equal(await source.readObservation(), observation);
  }
  assert.equal(source.state().requests, 5);
  for (const scheduleToleranceMs of [-1, 21, '20', NaN, 1.5]) assert.throws(() => createOBSSource({ scheduleToleranceMs }), /scheduler tolerance/);
});
