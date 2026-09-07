import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
let server, browser, page;
const errors = [], external = [];
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/render/index.html`);
  await page.waitForFunction(() => window.AppScreenRenderer);
  await page.evaluate(async () => {
    const campaign = await import('/core/campaign.mjs');
    const render = await import('/core/render.mjs');
    const qa = await import('/core/layout-qa.mjs');
    const draw = await import('/core/canvas-primitives.mjs');
    await render.ensureRenderResources({ scenes: [] });
    window.qaFixture = async (options = {}) => {
      const dims = options.dims || { width: 640, height: 960 };
      const canvas = document.createElement('canvas'); canvas.width = dims.width; canvas.height = dims.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const image = document.createElement('canvas'); image.width = 400; image.height = options.square ? 400 : 800;
      image.getContext('2d').fillRect(0, 0, image.width, image.height);
      const text = { ...structuredClone(campaign.DEFAULT_TEXT), headlineSize: 40, headlines: { en: 'Beautiful screens' }, ...options.text };
      const device = { ...structuredClone(campaign.DEFAULT_DEVICE), positionMode: 'canvas', centerX: .5, centerY: .5, scale: 50, ...options.device };
      const bounds = qa.measureTextBounds(context, dims, text);
      if (options.edgeContact) {
        const b = bounds[0], geometry = draw.getScreenshotGeometry(dims, image, device);
        device.centerX = (b.right - 3 + geometry.imgWidth / 2) / dims.width;
        device.centerY = (b.top + b.bottom) / 2 / dims.height;
        device.cornerRadius = 0;
      }
      // Independent full-canvas raster oracle: actual opaque source pixels,
      // not the QA proxy or its broad-phase/tile selection.
      draw.drawTextToContext(context, dims, text);
      const ink = context.getImageData(0, 0, dims.width, dims.height).data;
      context.clearRect(0, 0, dims.width, dims.height);
      context.save(); context.globalAlpha = (device.opacity ?? 100) / 100;
      if (!device.hidden) draw.drawScreenshotToContext(context, dims, image, { ...device, shadow: { enabled: false } });
      context.restore();
      const body = context.getImageData(0, 0, dims.width, dims.height).data;
      let contact = 0;
      for (let i = 3; i < ink.length; i += 4) if (ink[i] >= 16 && body[i] >= 16) contact += ink[i] * body[i] / (255 * 255);
      const inspector = qa.createTextDeviceInspector(dims, text, bounds);
      let overlap;
      try { overlap = inspector.overlaps(image, device); } finally { inspector.dispose(); }
      const b = qa.getDeviceBounds(dims, image, device);
      const oldWouldWarn = bounds.some(t => Math.max(0, Math.min(b.right, t.right) - Math.max(b.left, t.left)) * Math.max(0, Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top)) > (t.right - t.left) * (t.bottom - t.top) * .35);
      return { overlap, oracle: contact >= 2, contact, oldWouldWarn };
    };
  });
});
after(async () => {
  await browser?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('small real ink contact no longer requires 35% of a whole text line', async () => {
  const result = await page.evaluate(() => window.qaFixture({ edgeContact: true }));
  assert.equal(result.oldWouldWarn, false);
  assert.equal(result.oracle, true); assert.equal(result.overlap, true);
});

test('empty rounded corners and rotated bounding-box wedges are not device contact', async () => {
  for (const options of [
    { square: true, text: { headlines: { en: 'I' }, headlineSize: 30, blockX: 27, offsetY: 33.5 }, device: { cornerRadius: 200 } },
    { text: { headlines: { en: 'I' }, headlineSize: 30, blockX: 21.09375, offsetY: 30.2 }, device: { scale: 40, rotation: 45 } },
  ]) {
    const result = await page.evaluate(options => window.qaFixture(options), options);
    assert.equal(result.oldWouldWarn, true);
    assert.equal(result.oracle, false); assert.equal(result.overlap, false);
  }
});

test('spaces between letters do not count as text; underline in the same gap does', async () => {
  const options = { text: { headlines: { en: 'I          I' }, headlineSize: 80, offsetY: 35 }, device: { scale: 10, centerY: .4, cornerRadius: 0 } };
  const gap = await page.evaluate(options => window.qaFixture(options), options);
  assert.equal(gap.oracle, false); assert.equal(gap.overlap, false);
  const underline = await page.evaluate(options => window.qaFixture({ ...options, text: { ...options.text, headlineUnderline: true } }), options);
  assert.equal(underline.oracle, true); assert.equal(underline.overlap, true);
});

test('visible border contact counts; transparent borders, hidden devices and shadows do not', async () => {
  const options = { text: { headlines: { en: 'I' }, headlineSize: 30, blockX: 30.3125, offsetY: 42 }, device: { cornerRadius: 0, frame: { enabled: true, width: 20, opacity: 100, color: '#000000' }, shadow: { enabled: true, opacity: 100, color: '#000000', blur: 50, x: -50, y: 0 } } };
  const framed = await page.evaluate(options => window.qaFixture(options), options);
  assert.equal(framed.oracle, true); assert.equal(framed.overlap, true);
  for (const patch of [{ frame: { ...options.device.frame, opacity: 0 } }, { hidden: true }, { opacity: 0 }]) {
    const result = await page.evaluate(options => window.qaFixture(options), { ...options, device: { ...options.device, ...patch } });
    assert.equal(result.oracle, false); assert.equal(result.overlap, false);
  }
});

test('tiled checks match real raster with crop, shear, rotation, opacity and localized multiline text', async () => {
  const variants = [
    { device: { crop: { x: 10, y: 5, width: 45, height: 85 }, rotation: -32, perspective: 45, opacity: 60 } },
    { device: { positionMode: 'legacy', x: 60, y: 42, scale: 70, rotation: 12 } },
    { device: { scale: 95, centerX: 1.02, rotation: -38, perspective: -12 } },
    { text: { position: 'bottom', offsetY: 25, headlineItalic: true, headlineStrikethrough: true, headlines: { en: 'Make\nit yours' } } },
    { text: { headlines: { en: 'Away', fr: 'Votre\ncréation' }, currentHeadlineLang: 'fr', currentLayoutLang: 'fr', perLanguageLayout: true, languageSettings: { fr: { position: 'top', offsetY: 36, headlineSize: 54, lineHeight: 120 } } } },
    { text: { headlineEnabled: false, subheadlineEnabled: true, subheadlines: { en: 'More\npossibilities' }, offsetY: 38, subheadlineSize: 46, subheadlineItalic: true, subheadlineUnderline: true, subheadlineGradient: true, subheadlineOpacity: 35 } },
    { text: { headlines: { en: 'Aligned\nwith care' }, align: 'right', blockWidth: 45, blockX: 38, headlineGradient: true, headlineGradientStops: [{ color: '#123456', position: 0 }, { color: '#654321', position: 100 }] } },
  ];
  for (const variant of variants) {
    const options = { ...variant, text: { offsetY: 40, ...variant.text } };
    const result = await page.evaluate(options => window.qaFixture(options), options);
    assert.equal(result.overlap, result.oracle, JSON.stringify(options));
    assert.equal(result.oracle, true, JSON.stringify(options));
  }
});

test('Tidal incoming-device caption regression warns without changing pixels, locks or export eligibility', async () => {
  const result = await page.evaluate(async () => {
    const { createCampaign } = await import('/core/campaign.mjs');
    const { renderScene, inspectScene } = await import('/core/render.mjs');
    const doc = createCampaign({ assets: [1, 2, 3].map(id => ({ id: `asset-${id}`, width: 1320, height: 2868 })), templateId: 'tidal-relay', templateMode: 'exact', screenCount: 3 });
    const scene = doc.scenes[1]; scene.text.headlines.en = 'Synthetic 02'; scene.text.headlineSize = 88;
    const source = document.createElement('canvas'); source.width = 1320; source.height = 2868; source.getContext('2d').fillRect(0, 0, 1320, 2868);
    const canvas = document.createElement('canvas');
    const beforeDoc = JSON.stringify(doc);
    const rendered = await renderScene(canvas, doc, scene.id, { resolveAsset: () => source });
    const beforePixels = canvas.toDataURL(), context = canvas.getContext('2d'); context.font = 'italic 17px serif'; context.fillStyle = '#124356';
    const qa = inspectScene(context, doc, scene.id, new Map(doc.sources.map(s => [s.id, source])));
    const unchanged = beforePixels === canvas.toDataURL() && beforeDoc === JSON.stringify(doc) && context.font === 'italic 17px serif' && context.fillStyle === '#124356';
    scene.text.headlines.en = 'Focus'; scene.text.headlineSize = 80;
    const refined = inspectScene(context, doc, scene.id, new Map(doc.sources.map(s => [s.id, source])));
    return { qa, renderedQA: rendered.qa, refined, unchanged, incoming: scene.devices[0].id };
  });
  assert.equal(result.unchanged, true);
  assert.equal(result.qa.passed, true);
  const overlap = result.qa.issues.filter(i => i.code === 'TEXT_DEVICE_OVERLAP');
  assert.ok(overlap.some(i => i.deviceId === result.incoming && i.severity === 'warning'));
  assert.deepEqual(result.qa, result.renderedQA);
  assert.equal(result.refined.issues.some(i => i.code === 'TEXT_DEVICE_OVERLAP'), false);
});

test('clipping follows actual multiline/localized text and decorations, not empty block margins', async () => {
  const result = await page.evaluate(async () => {
    const { createCampaign } = await import('/core/campaign.mjs');
    const { inspectScene } = await import('/core/render.mjs');
    const doc = createCampaign({ assets: [{ id: 'fixture', width: 400, height: 800 }], screenCount: 1, profile: { id: 'test', width: 640, height: 960 } });
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 960;
    const scene = doc.scenes[0], text = scene.text;
    Object.assign(text, { headlines: { en: 'Safe' }, headlineSize: 30, position: 'top', offsetY: 10, blockX: 15, blockWidth: 84 });
    const check = locale => inspectScene(canvas.getContext('2d'), doc, scene.id, new Map(), locale || 'en');
    const margins = check();
    text.headlines.en = 'One\nTwo\nThree\nFour';
    const multiline = check();
    Object.assign(text, { headlines: { en: 'Safe', fr: 'Coupe' }, blockX: 50, perLanguageLayout: true, languageSettings: { fr: { offsetY: 99, headlineSize: 60 } } });
    const localized = check('fr');
    Object.assign(text, { headlineEnabled: false, subheadlineEnabled: true, subheadlineOpacity: 0, subheadlines: { en: 'Invisible' }, offsetY: 99 });
    const transparent = check();
    Object.assign(text, { headlineEnabled: true, subheadlineEnabled: false, position: 'bottom', offsetY: 0, headlineUnderline: true });
    const decoration = check();
    doc.deviceGroups.forEach(d => { d.geometry.opacity = 0; });
    const invisibleDevice = check();
    return { margins, multiline, localized, transparent, decoration, invisibleDevice };
  });
  assert.equal(result.margins.passed, true);
  assert.ok(result.multiline.issues.some(i => i.code === 'LONG_HEADLINE'));
  assert.ok(result.localized.issues.some(i => i.code === 'TEXT_CLIPPED'));
  assert.equal(result.transparent.issues.some(i => i.code.startsWith('TEXT_')), false);
  assert.ok(result.decoration.issues.some(i => i.code === 'TEXT_CLIPPED'));
  assert.ok(result.invisibleDevice.issues.some(i => i.code === 'NO_VISIBLE_DEVICE'));
});

test('maximum-profile inspection uses only two small disposable masks and no source pixel reads', async () => {
  const result = await page.evaluate(async () => {
    const { DEFAULT_TEXT, DEFAULT_DEVICE } = await import('/core/campaign.mjs');
    const { createTextDeviceInspector, measureTextBounds } = await import('/core/layout-qa.mjs');
    const dims = { width: 4000, height: 5500 }, text = { ...DEFAULT_TEXT, headlines: { en: 'A meaningful headline' }, headlineSize: 200, offsetY: 40 };
    const context = document.createElement('canvas').getContext('2d');
    const bounds = measureTextBounds(context, dims, text);
    const sizes = [], canvases = [], createElement = document.createElement;
    document.createElement = function (...args) {
      const canvas = createElement.apply(this, args);
      if (args[0] === 'canvas') {
        canvases.push(canvas); const getContext = canvas.getContext;
        canvas.getContext = function (...args) { sizes.push([this.width, this.height]); return getContext.apply(this, args); };
      }
      return canvas;
    };
    const inspector = createTextDeviceInspector(dims, text, bounds);
    let overlap;
    const start = performance.now();
    try {
      // Dimensions only: no drawable image object, URL, decode or source read.
      overlap = inspector.overlaps({ width: 1320, height: 2868 }, { ...DEFAULT_DEVICE, positionMode: 'canvas', centerX: .5, centerY: .5, scale: 80 });
    } finally { inspector.dispose(); document.createElement = createElement; }
    return { overlap, sizes, canvasCount: canvases.length, disposed: canvases.every(c => c.width === 0 && c.height === 0), elapsedMs: performance.now() - start };
  });
  assert.equal(result.overlap, true); assert.equal(result.canvasCount, 2);
  assert.ok(result.sizes.every(([w, h]) => w <= 256 && h <= 256));
  assert.equal(result.disposed, true);
  assert.ok(result.elapsedMs < 5000, `bounded fixture took ${result.elapsedMs}ms`);
});
