import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createApplication } from '../server/index.js';

const command = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts');
const work = await mkdtemp(path.join(tmpdir(), 'sealed-notes-recording-'));
const childEnv = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: '/tmp' };
await mkdir(output, { recursive: true });
const app = await createApplication({ demo: true, env: {} });
// Capture takes longer than the normal eight-second presentation. Manual skips
// retain one-at-a-time playback while the fixture holds each card for recording.
await app.engine.updateConfig({ reveal: { duration_ms: 60000 } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const auth = await (await fetch(`${origin}/demo/auth?viewer=one&shared=1`)).json();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: childEnv });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
context.setDefaultTimeout(12000);
const errors = [], scenes = [];
let frameNumber = 0;
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort('blockedbyclient');
  if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: '/* Offline recording supplies Twitch.ext. */' });
  return route.continue();
});
await context.addInitScript(auth => {
  const authorization = { token: auth.token, channelId: auth.channelId, userId: '101', clientId: 'offline-recording' };
  window.Twitch = { ext: {
    onAuthorized(fn) { queueMicrotask(() => fn(authorization)); },
    onContext(fn) { queueMicrotask(() => fn({ hlsLatencyBroadcaster: 9 }, ['hlsLatencyBroadcaster'])); },
    listen() {}, unlisten() {},
    actions: { requestIdShare() {} },
    bits: { useBits() { throw new Error('Live Bits are disabled'); }, onTransactionComplete() {}, onTransactionCancelled() {} },
  } };
}, auth);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function page(route) {
  const value = await context.newPage();
  value.on('pageerror', error => errors.push(error.message));
  await value.goto(`${origin}${route}`);
  return value;
}
async function caption(value, text) {
  await value.evaluate(text => {
    document.querySelector('#recording-caption')?.remove();
    const banner = document.createElement('aside');
    banner.id = 'recording-caption';
    Object.assign(banner.style, { position: 'fixed', zIndex: '99999', bottom: '0', left: '0', width: '100%', height: '68px', display: 'flex', gap: '28px', alignItems: 'center', padding: '12px 34px', background: '#091428', borderTop: '1px solid #e7c470', color: '#fffdf8', font: '22px/1.35 system-ui', boxSizing: 'border-box' });
    const label = document.createElement('strong'); label.textContent = 'LOCAL DEMO';
    Object.assign(label.style, { color: '#e7c470', whiteSpace: 'nowrap', fontSize: '16px', letterSpacing: '2px' });
    const message = document.createElement('span'); message.textContent = text;
    banner.append(label, message); document.body.append(banner);
  }, text);
}
async function scene(value, name, text, seconds, action = async () => {}) {
  await value.bringToFront();
  await caption(value, text);
  const started = Date.now(), frames = [], writes = [];
  const save = (data, at) => {
    const filename = path.join(work, `frame-${String(++frameNumber).padStart(6, '0')}.jpg`);
    frames.push({ filename, at }); writes.push(writeFile(filename, data));
  };
  save(await value.screenshot({ type: 'jpeg', quality: 85 }), 0);
  const session = await context.newCDPSession(value);
  session.on('Page.screencastFrame', event => {
    save(Buffer.from(event.data, 'base64'), Math.max(0, Date.now() - started));
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await action();
  await pause(Math.max(0, seconds * 1000 - (Date.now() - started)));
  await session.send('Page.stopScreencast');
  const duration = Date.now() - started;
  await session.detach(); await Promise.all(writes);
  scenes.push({ name, caption: text, duration_ms: duration, frames });
  console.log(`Recorded local scene: ${name}`);
}
async function operator(desk, body) {
  const response = await desk.request.post(`${origin}/api/operator/action`, { headers: { 'X-Sealed-Action': '1' }, data: body });
  assert.equal(response.status(), 200, `Operator ${body.action}`);
  return response.json();
}
async function fixture(body, category_id, moment_id = 'margit') {
  const response = await fetch(`${origin}/ebs/notes`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body, category_id, moment_id, payment_mode: 'sim_points', show_name: true, request_id: crypto.randomUUID() }) });
  assert.equal(response.status, 200, 'Offline fixture submission');
  const value = await response.json(); return value.note || value;
}

try {
  const home = await page('/');
  const panel = await page('/panel.html?demo=1');
  const desk = await page('/console');
  await desk.request.get(`${origin}/api/operator/bootstrap`);
  const obs = await page('/overlay');
  const privateOverlay = await page('/video_overlay.html?demo=1');
  await panel.getByRole('button', { name: /Prediction/ }).waitFor();
  await privateOverlay.waitForResponse(response => new URL(response.url()).pathname === '/ebs/events');

  await scene(home, 'pitch', 'A private note. A future moment. One shared reveal.', 5);
  await scene(panel, 'compose', 'Choose a category and a moment. Every price is simulated.', 12, async () => {
    await panel.getByLabel('What would you like to say?').pressSequentially('I predict a clean victory. Chat believes in this run.', { delay: 55 });
    await panel.getByRole('button', { name: /Prediction/ }).click();
    await panel.getByLabel(/^Open when/).selectOption('margit');
    await panel.getByLabel('Show my Twitch name').check();
  });
  await scene(panel, 'sealed', 'After sealing, the words disappear — even from the author.', 7, async () => {
    await pause(800);
    await panel.getByRole('button', { name: /Seal this note/ }).click();
    await panel.getByText('Sealed. See you at the moment.', { exact: true }).waitFor();
    assert.equal(await panel.getByLabel('What would you like to say?').inputValue(), '');
  });
  await scene(desk, 'human-confirmation', 'The streamer declares the moment. There is no game integration.', 7, async () => {
    await desk.getByLabel('What just happened?').fill('A clean victory. The prediction came true.');
    await pause(3000);
    await desk.locator('.moment-row').filter({ hasText: 'Beat Margit' }).getByRole('button', { name: 'Declare moment' }).click();
    await obs.getByText('CALLED IT', { exact: true }).waitFor();
  });
  await scene(obs, 'prediction', 'The canonical reveal credits the viewer. CALLED IT is a demo verdict.', 6);
  await privateOverlay.getByText('Your note was opened', { exact: true }).waitFor({ timeout: 15000 });
  await scene(privateOverlay, 'private-notice', 'Only the author gets this notice, delayed by the viewer latency fixture.', 5);
  await operator(desk, { action: 'skip' });

  for (const [category, body, explanation] of [
    ['advice', 'Try rolling toward the attack. Save a little stamina.', 'Advice: a sea-glass envelope, a compass, and a clear subtitle.'],
    ['joke', 'That boss owes chat a refund.', 'Joke: an apricot envelope and a lighthearted moment.'],
    ['encouragement', 'You have got this. Keep going, we believe in you.', 'Encouragement: a rose envelope. Color is never the only cue.'],
  ]) {
    await fixture(body, category);
    await operator(desk, { action: 'moment', moment_id: 'margit', context: 'A streamer-confirmed local demo victory.' });
    await obs.getByText(body, { exact: true }).waitFor();
    await scene(obs, category, explanation, 6);
    await operator(desk, { action: 'skip' });
  }

  const held = await fixture('[demo:hold] A moderator should review this encouragement.', 'encouragement', 'key');
  assert.equal(held.status, 'held');
  await desk.reload();
  const heldBody = desk.getByText('[demo:hold] A moderator should review this encouragement.', { exact: true });
  await heldBody.waitFor(); await heldBody.scrollIntoViewIfNeeded();
  await scene(desk, 'moderation', 'Uncertain moderation holds the note before any charge. A human decides.', 8, async () => {
    await pause(4000);
    await desk.locator('#review-queue').getByRole('button', { name: 'Reject', exact: true }).click();
    await desk.getByText('All clear. Notes held for review will appear here.', { exact: true }).waitFor();
  });
  await fixture('A secret for a moment that never came.', 'joke', 'never');
  await operator(desk, { action: 'wrap' });
  await obs.getByText('A secret for a moment that never came.', { exact: true }).waitFor();
  await scene(obs, 'never-note', 'Wrap-up opens a sample of the moments that never happened.', 5);
  await operator(desk, { action: 'skip' });
  await obs.locator('.reel-count').waitFor();
  await scene(obs, 'never-count', 'The never-opened reel counts missed moments. Simulated payment is refunded.', 4);
  const archive = await page('/archive');
  await archive.getByText('I predict a clean victory. Chat believes in this run.', { exact: true }).waitFor();
  await scene(archive, 'archive', 'Opened notes become a public keepsake, with a filter for each stream.', 7);

  const end = await context.newPage();
  await end.setContent('<!doctype html><html lang="en"><body style="margin:0;background:#101e36;color:#fffdf8;font:30px/1.6 system-ui;display:grid;place-items:center;height:100vh"><main style="max-width:1350px"><p style="color:#e7c470;letter-spacing:5px;font-size:20px">SEALED NOTES · LOCAL DEMO</p><h1 style="font:86px/1.15 Georgia;margin:24px 0">A little note.<br>A big moment.</h1><p>Built with Codex.<br>Runtime judgements integrate the Decisions API (gpt-6-luna).</p><p style="font-size:24px;color:#a6b7ce">This recording uses offline fixtures and simulated payments.<br>Twitch Hosted Test and live-service footage remain to be recorded.</p></main></body></html>');
  await scene(end, 'scope-and-credits', 'No live API calls. No Twitch broadcast. No real charge.', 10);
  assert.deepEqual(errors, [], 'No unhandled browser errors during recording');

  const entries = [];
  for (const value of scenes) {
    for (let i = 0; i < value.frames.length; i++) {
      const frame = value.frames[i], next = value.frames[i + 1]?.at ?? value.duration_ms;
      const duration = Math.max(0, next - frame.at) / 1000;
      if (!duration) continue;
      entries.push(`file '${frame.filename}'\nduration ${duration.toFixed(3)}`);
    }
  }
  entries.push(`file '${scenes.at(-1).frames.at(-1).filename}'`);
  const concat = path.join(work, 'frames.txt'); await writeFile(concat, `${entries.join('\n')}\n`);
  const temporary = path.join(output, 'sealed-notes-local-demo.partial.mp4');
  await command('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-preset', 'medium', '-movflags', '+faststart', '-an', temporary], { env: childEnv, timeout: 180000 });
  const { stdout } = await command('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate', '-of', 'json', temporary], { env: childEnv });
  const probe = JSON.parse(stdout), duration = Number(probe.format.duration);
  assert.ok(duration > 60 && duration <= 180, 'Video is between one and three minutes');
  assert.ok(probe.streams.some(stream => stream.width === 1920 && stream.height === 1080 && stream.codec_name === 'h264'), 'Video is 1920×1080 H.264');
  await command('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '35', '-i', temporary, '-frames:v', '1', '-y', path.join(output, 'local-demo-verification-frame.png')], { env: childEnv });
  const video = path.join(output, 'sealed-notes-local-demo.mp4'); await rename(temporary, video);
  await writeFile(path.join(output, 'local-demo-recording.json'), JSON.stringify({ recorded_at: new Date().toISOString(), mode: 'local-offline-demo', duration_seconds: duration, bytes: (await stat(video)).size, viewport: { width: 1920, height: 1080 }, audio: false, provider_calls: false, twitch_broadcast: false, scenes: scenes.map(({ frames, ...value }) => ({ ...value, frames: frames.length })), ffprobe: probe }, null, 2) + '\n');
  console.log(`Local demo video: ${video} (${duration.toFixed(2)} seconds)`);
} finally {
  await context.close(); await browser.close(); await app.close(); await rm(work, { recursive: true, force: true });
}
