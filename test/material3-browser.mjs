import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import os from 'node:os';
import { createApplication } from '../server/index.js';

// Isolated demo-only review. No user browser, .env, provider client, OBS or OAuth action.
const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const report = { started_at: new Date().toISOString(), scope: 'offline demo, isolated Chromium',
  methodology: {
    application: 'createApplication({demo:true,env:{}}), fresh in-memory fixtures; no credential/OAuth actions',
    themes: 'Matching light/dark system media and explicit data-theme on ordinary pages; overlays intentionally retain their fixed light scheme',
    viewports: 'Panel: 318x844; other pages: 390x844 and 1440x1000',
    contrast: 'Visible direct core text in headings, paragraphs, labels, controls, statuses, badges and reveal metadata. Computed foreground/background colors are alpha-composited through ancestor/group opacity.',
    thresholds: 'Ordinary text: 4.5:1; text >=24px or >=18.6667px at weight >=700: 3:1',
    image_handling: 'Images/gradients under text remain unverified and fail the check. Tiny non-repeating select arrows wholly inside reserved right padding are excluded from the text background calculation.',
    exclusions: 'Disabled control text, decorative icons, placeholders, hover/focus states, image text and glyph antialiasing are not contrast-certified. Theme toggle persistence and real Twitch context delivery are outside this script.',
    privacy: 'A synthetic sealed body must not occur in visible body text or input/textarea values; this is not an exhaustive security review.',
    transparency: 'PNG screenshots omit the browser default background; all four corner alpha values must be zero.',
    boundary: 'This targeted browser review is not full-site WCAG conformance or Twitch/OBS/live-service acceptance.',
  }, checks: [], issues: [], external: [], screenshots: [], pages: [] };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed, ...detail });
  if (!passed) report.issues.push({ name, ...detail });
};
const routes = [
  { name: 'hub', route: '/', core: /Sealed Notes/i },
  { name: 'console', route: '/console', core: /Event recognition|Operator desk|call the moment/i },
  { name: 'archive', route: '/archive', core: /opened|archive|notes/i },
  { name: 'setup', route: '/setup', core: /setup|credentials|authorization/i },
  { name: 'panel', route: '/panel.html?demo=1', core: /seal|note for later|write a note/i },
  { name: 'config', route: '/config.html?demo=1&role=broadcaster', core: /rules|moderation|configuration/i },
  { name: 'overlay', route: '/overlay', core: /notes? sealed/i, transparent: true },
  { name: 'video-overlay', route: '/video_overlay.html?demo=1', core: /notes? sealed/i, transparent: true },
];
const app = await createApplication({ demo: true, env: {} });
let browser;
const sealedCanary = 'M3_SEALED_BODY_CANARY';
try {
  const preset = JSON.parse(await fs.readFile(path.join(ROOT, 'presets/ksp.json'), 'utf8'));
  await app.engine.importEventDefinitions(preset.events);
  await app.engine.updateConfig({ reveal: { duration_ms: 60000 } });
  const author = { opaqueId: 'Um3review' };
  await app.engine.submit(author, { body: 'A clear moment deserves a readable note.', category_id: 'advice', moment_id: 'key', payment_mode: 'sim_points' });
  await app.engine.occur('key', 'Offline review fixture.');
  await app.engine.submit(author, { body: sealedCanary, category_id: 'joke', moment_id: 'margit', payment_mode: 'sim_points' });
  await app.engine.submit(author, { body: '[demo:hold] A synthetic note for human review.', category_id: 'advice', moment_id: 'margit', payment_mode: 'sim_points' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  await fs.mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'en_US.UTF-8' } });

  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(8000);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      report.external.push({ theme, method: route.request().method(), url: url.origin + url.pathname });
      return route.abort('blockedbyclient');
    });
    for (const target of routes) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        const response = await page.goto(origin + target.route, { waitUntil: 'domcontentloaded' });
        check(`${theme}/${target.name}: HTTP 200`, response?.status() === 200, { status: response?.status() });
        await page.evaluate(async () => { await document.fonts.ready; });
        if (target.name === 'panel' || target.name === 'config') {
          await page.waitForFunction(() => window.SealedHarness?.authorizedCount > 0).catch(() => {});
        }
        if (target.name === 'console') await page.locator('#event-list .event-row').first().waitFor().catch(() => {});
        await page.waitForTimeout(250);
        // Test both explicit CSS schemes as well as the matching system media query.
        await page.evaluate(theme => { if (!document.documentElement.classList.contains('transparent-root')) document.documentElement.dataset.theme = theme; }, theme);
        const widths = target.name === 'panel' ? [318] : [390, 1440];
        for (const width of widths) {
          await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
          await page.waitForTimeout(60);
          const prefix = `${theme}/${target.name}/${width}`;
          const text = await page.locator('body').innerText();
          check(`${prefix}: visible core text`, target.core.test(text) && text.trim().length >= 5);
          const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
          check(`${prefix}: no horizontal overflow`, layout.scrollWidth <= layout.width + 1, layout);
          const privacy = await page.evaluate(canary => !document.body.innerText.includes(canary) &&
            [...document.querySelectorAll('input,textarea')].every(element => !element.value.includes(canary)), sealedCanary);
          check(`${prefix}: sealed fixture body stays private`, privacy);
          const contrast = await inspectContrast(page);
          report.pages.push({ theme, surface: target.name, width, contrast_samples: contrast.samples.length,
            contrast_failures: contrast.failures, contrast_unverified: contrast.unverified,
            root_background: contrast.rootBackground, body_background: contrast.bodyBackground, color_scheme: contrast.colorScheme });
          check(`${prefix}: core text contrast`, contrast.samples.length > 0 && contrast.failures.length === 0 && contrast.unverified.length === 0,
            { failures: contrast.failures, unverified: contrast.unverified, samples: contrast.samples.length });
          if (target.transparent) {
            const name = `m3-review-${theme}-${target.name}-${width}-alpha.png`;
            const png = await page.screenshot({ path: path.join(SHOTS, name), omitBackground: true, animations: 'disabled' });
            report.screenshots.push(name);
            const alpha = await page.evaluate(async bytes => {
              const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0);
              return [[0, 0], [bitmap.width - 1, 0], [0, bitmap.height - 1], [bitmap.width - 1, bitmap.height - 1]]
                .map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
            }, [...png]);
            check(`${prefix}: four transparent corner pixels`, alpha.every(value => value === 0), { alpha });
          }
          if (['hub', 'panel', 'console'].includes(target.name)) {
            await page.evaluate(() => scrollTo(0, 0));
            const name = `m3-review-${theme}-${target.name}-${width}.png`;
            await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
            report.screenshots.push(name);
          }
          if (target.name === 'console') {
            const section = page.locator('#events-section');
            if (await section.count()) {
              const name = `m3-review-${theme}-events-${width}.png`;
              await section.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
              report.screenshots.push(name);
            } else check(`${prefix}: events section exists`, false);
          }
        }
        check(`${theme}/${target.name}: no unhandled page errors`, errors.length === 0, { errors });
      } catch (error) {
        check(`${theme}/${target.name}: review completed`, false, { error: error.message });
      } finally { await page.close(); }
    }
    await context.close();
  }
  check('All browser requests remain on the isolated loopback app', report.external.length === 0, { external: report.external });
} finally {
  await browser?.close();
  await app.close();
  report.completed_at = new Date().toISOString();
  report.passed = report.issues.length === 0;
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.writeFile(path.join(ROOT, 'docs/material3-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, issues: report.issues,
    screenshots: report.screenshots.length, report: path.join(ROOT, 'docs/material3-evidence.json') }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

async function inspectContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = canvas.height = 1;
    const parse = color => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const p = ctx.getImageData(0, 0, 1, 1).data;
      return [p[0], p[1], p[2], p[3] / 255];
    };
    const over = (front, back) => {
      const a = front[3] + back[3] * (1 - front[3]);
      return a ? [...[0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / a), a] : [0, 0, 0, 0];
    };
    const luminance = color => color.slice(0, 3).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    const samples = [], failures = [], unverified = [], seen = new Set();
    const selector = 'h1,h2,h3,h4,p,strong,button,a,label,legend,summary,select,input,textarea,[role="status"],[role="alert"],.pill,.reveal-body,.reveal-author,.reveal-footer span,.category-option-description,#sealed-count';
    for (const element of document.querySelectorAll(selector)) {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || style.visibility !== 'visible' || Number(style.opacity) === 0 || element.closest('[hidden]')) continue;
      if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') continue;
      let text = [...element.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (element instanceof HTMLSelectElement) text = element.selectedOptions[0]?.textContent?.trim() || '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) text = element.value;
      if (!text || text.length < 2 || !/[A-Za-z0-9]/.test(text)) continue;
      const chain = []; for (let parent = element; parent; parent = parent.parentElement) chain.unshift(parent);
      const layers = chain.map(node => ({ node, style: getComputedStyle(node) }));
      // Tiny, non-repeating right-edge select arrows lie in reserved padding, outside text.
      const endAdornment = ({ node, style }) => node === element && node instanceof HTMLSelectElement &&
        Number.parseFloat(style.paddingRight) >= 32 && style.backgroundRepeat.split(',').every(part => part.trim() === 'no-repeat') &&
        style.backgroundPositionX.split(',').every(part => /100%|right/.test(part)) &&
        style.backgroundSize.split(',').every(part => /^\s*\d+(?:\.\d+)?px\s+\d+(?:\.\d+)?px\s*$/.test(part) &&
          part.trim().split(/\s+/).every(value => Number.parseFloat(value) <= 8));
      let uncertain = false;
      for (const layer of layers) {
        if (parse(layer.style.backgroundColor)[3] >= 0.999) uncertain = false;
        if (layer.style.backgroundImage !== 'none' && !endAdornment(layer)) uncertain = true;
      }
      // Paint bottom-up so an element/group opacity composites both its text and background.
      const paint = foreground => {
        let value = foreground || [0, 0, 0, 0];
        for (let index = layers.length - 1; index >= 0; index--) {
          value = over(value, parse(layers[index].style.backgroundColor));
          value[3] *= Number(layers[index].style.opacity);
        }
        return value;
      };
      const background = paint(null);
      const foreground = parse(style.color), size = Number.parseFloat(style.fontSize), weight = Number.parseInt(style.fontWeight, 10) || 400;
      const threshold = size >= 24 || size >= 18.6667 && weight >= 700 ? 3 : 4.5;
      const detail = { tag: element.tagName.toLowerCase(), id: element.id || undefined, text: text.slice(0, 110), font_size: size,
        font_weight: weight, required: threshold, foreground: style.color, background: background.slice(0, 3).map(Math.round) };
      const key = `${style.color}/${background.join(',')}/${threshold}/${detail.text}`;
      if (seen.has(key)) continue; seen.add(key);
      if (uncertain || background[3] < 0.999) {
        unverified.push({ ...detail, reason: uncertain ? 'background image/gradient under text requires visual inspection' : 'text has no opaque background' });
        continue;
      }
      const effective = paint(foreground), a = luminance(effective), b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      samples.push({ ...detail, effective_foreground: effective.slice(0, 3).map(Math.round), ratio: Number(ratio.toFixed(2)) });
      if (ratio + 0.001 < threshold) failures.push(samples.at(-1));
    }
    return { samples, failures, unverified, rootBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor, colorScheme: getComputedStyle(document.documentElement).colorScheme };
  });
}
