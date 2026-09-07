import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCampaign, toLegacyState } from './campaign.mjs';

const editorSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const languageSource = readFileSync(new URL('../language-utils.js', import.meta.url), 'utf8');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `Missing editor function: ${name}`);
  return source.slice(start, end);
}
const helpers = [
  extract(editorSource, 'escapeInspectorText'),
  extract(editorSource, 'getScreenshotDeviceLabel'),
  extract(editorSource, 'updateScreenshotList'),
  extract(languageSource, 'getScreenshotImage'),
].join('\n');

function renderRows(state) {
  const rows = [];
  const context = {
    state: { selectedIndex: 0, currentLanguage: 'en', projectLanguages: ['en'], ...state, transferTarget: state.transferTarget ?? null },
    screenshotList: { innerHTML: '', appendChild: item => rows.push(item.innerHTML) },
    noScreenshot: { style: {} },
    document: {
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ dataset: {}, addEventListener() {}, querySelector: () => null }),
    },
    getAvailableLanguagesForScreenshot: () => ['en'],
    isScreenshotComplete: () => true,
    languageFlags: { en: '🇬🇧' },
    updateProjectSelector() {},
  };
  runInNewContext(`${helpers}\nupdateScreenshotList();`, context);
  return rows.map(row => row.match(/<div class="screenshot-device">([\s\S]*?)<\/div>/)?.[1]
    ?.replace(/<span class="screenshot-source-label">([^<]*)<\/span>/, '$1'));
}

async function cloudFixture() {
  const document = createCampaign({
    templateId: 'tidal-relay', templateMode: 'exact', screenCount: 5,
    assets: Array.from({ length: 5 }, (_, index) => ({ id: `asset-${index}`, name: `Screen ${index + 1}`, width: 1179, height: 2556 })),
  });
  const legacy = await toLegacyState(document, async id => `https://example.test/${id}.png`);
  // Match the image hydration performed by core/editor-bridge.mjs.
  for (const scene of legacy.screenshots) {
    for (const localized of Object.values(scene.localizedImages)) {
      localized.image = { src: localized.src, naturalWidth: 1179, naturalHeight: 2556, width: 200, height: 434 };
    }
    scene.image = scene.localizedImages.en.image;
  }
  return legacy;
}

test('real cloud-imported rows show source dimensions and keep overflow labels without changing layout', async () => {
  const state = await cloudFixture();
  assert.ok(state.screenshots.every(scene => scene.deviceType === undefined));
  const before = structuredClone(state);
  const labels = renderRows(state);
  assert.equal(labels.length, 5);
  for (const label of labels) {
    assert.match(label, /^1179 × 2556 px/);
    assert.doesNotMatch(label, /undefined|iPhone|1320 × 2868/);
  }
  assert.match(labels[1], /Continues 1/);
  assert.deepEqual(state, before, 'Rendering labels must not mutate canonical or editor state');
});

test('normal legacy uploads keep their existing iPhone and iPad labels', () => {
  const screenshots = ['iPhone', 'iPad'].map(deviceType => ({
    name: deviceType, deviceType, image: { src: '/capture.png', naturalWidth: 1179, naturalHeight: 2556 },
  }));
  assert.deepEqual(renderRows({ screenshots }), ['iPhone', 'iPad']);
});

test('missing or unknown device metadata uses dimensions or a safe neutral label', () => {
  const screenshots = [
    { name: 'Missing metadata' },
    { name: 'Unknown device', deviceType: 'unknown' },
    { name: 'Invalid label', deviceType: '<img src=x onerror=alert(1)>' },
    { name: 'Older image object', deviceType: 'undefined', image: { src: '/legacy.png', width: 640, height: 960 } },
    { name: 'No image dimensions', deviceType: null, image: { src: '/pending.png' } },
  ];
  assert.deepEqual(renderRows({ screenshots }), ['Screenshot', 'Screenshot', 'Screenshot', '640 × 960 px', 'Screenshot']);
});

test('invalid or not-yet-decoded dimensions never become misleading source labels', () => {
  const screenshots = [
    [0, 2556], [-1, 2556], [1179, Infinity], [NaN, 2556], [1179.5, 2556], ['1179', '2556'],
  ].map(([naturalWidth, naturalHeight]) => ({
    name: 'Pending screenshot', image: { src: '/pending.png', naturalWidth, naturalHeight, width: 200, height: 434 },
  }));
  assert.ok(renderRows({ screenshots }).every(label => label === 'Screenshot'));
});

test('dimensions follow the displayed localized source instead of a stale legacy image', () => {
  const screenshots = [{
    name: 'Localized screenshot',
    image: { src: '/en.png', width: 1179, height: 2556 },
    localizedImages: { fr: { image: { src: '/fr.png', naturalWidth: 1290, naturalHeight: 2796 } } },
  }];
  assert.deepEqual(renderRows({ screenshots, currentLanguage: 'fr' }), ['1290 × 2796 px']);
});

test('copy-device and copy-style actions retain their existing target instructions', () => {
  for (const transferType of ['device', 'style']) {
    const labels = renderRows({ screenshots: [{ name: 'Target' }], transferTarget: 0, transferType });
    assert.deepEqual(labels, [`Click source to copy ${transferType}`]);
  }
});
