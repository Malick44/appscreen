import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';

const editorSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const librarySource = readFileSync(new URL('../font-library.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function extract(name) {
  let start = editorSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing editor function: ${name}`);
  if (editorSource.slice(start - 6, start) === 'async ') start -= 6;
  const end = editorSource.indexOf('\n}', start + 1) + 2;
  assert.ok(end > start, `Missing function end: ${name}`);
  return editorSource.slice(start, end);
}
const plain = value => JSON.parse(JSON.stringify(value));

function exportContext({ cloud = false, result = true } = {}) {
  const requests = [];
  const context = {
    state: { currentLanguage: 'de' },
    googleFonts: { system: [{ name: 'Georgia', value: 'Georgia, serif' }] },
    isCloudDocumentContext: () => cloud,
    AppScreenFontLibrary: { loadFont(name, options) { requests.push({ name, options: plain(options) }); return Promise.resolve(result); } },
  };
  runInNewContext(`${extract('getElementText')}\n${extract('prepareScreenshotFonts')}`, context);
  return { context, requests };
}

test('export awaits enabled headline, subheadline and localized text element faces with their actual weights and content', async () => {
  const { context, requests } = exportContext();
  let release;
  // Use one shared pending promise so every requested face must settle.
  const pending = new Promise(resolve => { release = resolve; });
  context.AppScreenFontLibrary.loadFont = (name, options) => { requests.push({ name, options: plain(options) }); return pending; };
  let finished = false;
  const work = context.prepareScreenshotFonts({
    text: {
      headlineFont: '"Instrument Serif", serif', headlineWeight: 600, headlineItalic: true,
      currentHeadlineLang: 'fr', headlines: { fr: 'Découvrez le détail', en: 'Wrong language' },
      subheadlineEnabled: true, subheadlineFont: "'BagnardRegular', serif", subheadlineWeight: '400',
      currentSubheadlineLang: 'ja', subheadlines: { ja: '細部まで美しく', en: 'Wrong language' },
    },
    elements: [{ type: 'text', font: '"Syne", sans-serif', fontWeight: '800', italic: true,
      texts: { de: 'Größe & Gefühl', en: 'Wrong language' }, text: 'Wrong fallback' }],
  }).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, 'PNG preparation must not resolve while required faces are loading');
  assert.deepEqual(requests, [
    { name: 'Instrument Serif', options: { weights: [600], italic: true, sample: 'Découvrez le détail' } },
    { name: 'BagnardRegular', options: { weights: ['400'], italic: false, sample: '細部まで美しく' } },
    { name: 'Syne', options: { weights: ['800'], italic: true, sample: 'Größe & Gefühl' } },
  ]);
  release(true);
  await work;
  assert.equal(finished, true);
});

test('export font preparation matches rendered language defaults, not the UI language or unused legacy copy', async () => {
  const { context, requests } = exportContext();
  await context.prepareScreenshotFonts({ text: {
    headlineFont: '"Syne", sans-serif', headlines: { en: 'Rendered English', de: 'Not selected' },
    subheadlineEnabled: true, subheadlineFont: '"Caveat", cursive', subheadline: 'Legacy copy is not rendered',
  } });
  assert.deepEqual(requests, [{ name: 'Syne', options: { weights: [400], italic: false, sample: 'Rendered English' } }]);
});

test('export skips cloud documents, system and generic fonts, disabled or empty text, and non-text elements', async () => {
  const cloud = exportContext({ cloud: true });
  await cloud.context.prepareScreenshotFonts({ text: { headlineFont: '"Syne", sans-serif', headlines: { en: 'Cloud copy' } } });
  assert.deepEqual(cloud.requests, []);
  const { context, requests } = exportContext();
  await context.prepareScreenshotFonts({
    text: { headlineEnabled: false, headlineFont: '"Syne", sans-serif', headlines: { en: 'Disabled' },
      subheadlineFont: '"Caveat", cursive', subheadlines: { en: 'Not enabled' } },
    elements: [
      { type: 'text', font: 'Georgia, serif', text: 'System face' },
      { type: 'text', font: '"Georgia", serif', text: 'Quoted system face' },
      { type: 'text', font: 'Georgia', text: 'Bare system face' },
      ...['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '-apple-system', 'AppScreen Sans']
        .map(font => ({ type: 'text', font, text: 'Generic face' })),
      { type: 'text', font: '"Syne", sans-serif', text: '' },
      { type: 'text', font: '"Syne", sans-serif', text: 'Transparent', opacity: 0 },
      { type: 'shape', font: '"Syne", sans-serif', text: 'Not a text element' },
    ],
  });
  assert.deepEqual(requests, []);
});

test('export awaits legacy text with an unsupported visibility flag because the renderer still draws it', async () => {
  const { context, requests } = exportContext();
  await context.prepareScreenshotFonts({ elements: [
    { type: 'text', font: '"Syne", sans-serif', text: 'Still rendered', visible: false, opacity: 100 },
  ] });
  assert.deepEqual(requests, [{ name: 'Syne', options: { weights: [400], italic: false, sample: 'Still rendered' } }]);
});

test('export rejects failed faces instead of silently saving fallback typography', async () => {
  const { context } = exportContext({ result: false });
  const screenshot = { text: { headlineFont: '"Instrument Serif", serif', headlines: { en: 'Export me' } } };
  await assert.rejects(context.prepareScreenshotFonts(screenshot), /Instrument Serif could not load.*retry the export/);
  context.AppScreenFontLibrary.loadFont = () => Promise.reject(new Error('Provider unavailable'));
  await assert.rejects(context.prepareScreenshotFonts(screenshot), /Provider unavailable/);
  assert.match(extract('prepareScreenshotForExport'), /await prepareScreenshotFonts\(screenshot\)/);
});

test('font picker preview restores single and double quoted provider aliases without metadata fetches in cloud', async () => {
  const controls = new Map();
  const requests = [];
  const context = {
    googleFonts: { system: [], loaded: new Set() },
    AppScreenFontLibrary: { getFont: name => ({ name: name === 'BagnardRegular' ? 'Bagnard' : name }) },
    document: { getElementById: id => { if (!controls.has(id)) controls.set(id, { style: {} }); return controls.get(id); } },
    isCloudDocumentContext: () => false, loadGoogleFont: name => { requests.push(name); return Promise.resolve(true); },
    getTextSettings: () => ({ headlineFont: '"BagnardRegular", serif' }), updateCanvas() {},
  };
  runInNewContext(`${extract('updateSingleFontPickerPreview')}\n${extract('updateElementFontPickerPreview')}`, context);
  context.updateSingleFontPickerPreview('hidden', 'preview', 'headlineFont');
  context.updateElementFontPickerPreview({ font: "'Instrument Serif', serif" });
  await Promise.resolve();
  assert.equal(controls.get('preview').textContent, 'Bagnard');
  assert.equal(controls.get('element-font-picker-preview').textContent, 'Instrument Serif');
  assert.deepEqual(requests, ['Bagnard', 'Instrument Serif']);
  context.isCloudDocumentContext = () => true;
  context.updateSingleFontPickerPreview('hidden', 'preview', 'headlineFont');
  context.updateElementFontPickerPreview({ font: '"BagnardRegular", serif' });
  assert.equal(controls.get('element-font-picker-preview').textContent, 'Bagnard');
  assert.deepEqual(requests, ['Bagnard', 'Instrument Serif']);
});

test('all three real font pickers default to Fancy and catalog options support provider search, selection and retry', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const externalRequests = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort(); });
  // Parse the real picker markup without running the application or fetching assets.
  const pickers = [...indexSource.matchAll(/<div class="font-picker" id="([^"]+)"/g)].map(match => {
    const end = indexSource.indexOf('<input type="hidden"', match.index);
    return indexSource.slice(match.index, end);
  });
  await page.setContent(`${pickers.join('\n')}<input id="headline-font"><input id="subheadline-font"><input id="element-font">`);
  assert.equal(await page.locator('.font-picker').count(), 3);
  assert.equal(await page.locator('.font-picker .font-category.active[data-category="fancy"]').count(), 3);
  assert.ok(indexSource.indexOf('src="font-library.js') < indexSource.indexOf('src="app.js'));
  await page.addScriptTag({ content: librarySource });
  await page.evaluate(() => {
    window.requests = [];
    window.loadSuccess = true;
    window.AppScreenFontLibrary = { ...AppScreenFontLibrary,
      loadFont: async (name, options) => { requests.push({ name, options }); return loadSuccess; } };
    Object.assign(window, {
      fontPickerState: { headline: { category: 'fancy', search: '' } },
      googleFonts: { system: [{ name: 'Georgia', value: 'Georgia, serif' }], loaded: new Set(), loading: new Map(),
        popular: ['Satoshi', 'General Sans', 'Playfair Display'] },
      textSettings: { headlineFont: 'Georgia, serif', headlineWeight: 700, subheadlineWeight: 400 },
      getTextSettings: () => textSettings,
      currentScreenshotId: 'qa-font-picker-only', getCurrentScreenshot: () => ({ id: currentScreenshotId }), selectedElementId: null,
      setTextValue: (key, value) => { textSettings[key] = value; },
      updateCount: 0, updateCanvas: () => { window.updateCount++; },
      fetchAllGoogleFonts: async () => ['Syne', 'Georgia', 'Instrument Serif', 'Poppins'],
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
      pickerIds: { list: 'font-picker-list', dropdown: 'font-picker-dropdown', hidden: 'headline-font', trigger: 'font-picker-trigger',
        preview: 'font-picker-preview', stateKey: 'headlineFont' },
    });
  });
  await page.addScriptTag({ content: `${extract('loadGoogleFont')}\n${extract('renderFontList')}` });
  await page.evaluate(() => renderFontList('headline', pickerIds));

  await t.test('Fancy contains Google and independent faces without provider requests at startup', async () => {
    assert.ok(await page.locator('.font-option[data-font-category="google"]').count() > 0);
    assert.ok(await page.locator('.font-option[data-font-category="fontlibrary"]').count() > 0);
    assert.equal(await page.locator('.font-option[data-font-name="Bagnard"]').getAttribute('data-font-value'), '"BagnardRegular", serif');
    assert.deepEqual(await page.evaluate(() => requests), []);
    assert.deepEqual(externalRequests, []);
  });

  await t.test('name, descriptive style and provider search find the intended faces', async () => {
    for (const [search, expectedName] of [['bagnard', 'Bagnard'], ['calligraphic', 'Great Vibes'], ['fontlibrary', 'Trickster']]) {
      await page.evaluate(search => { fontPickerState.headline.search = search; return renderFontList('headline', pickerIds); }, search);
      assert.equal(await page.locator(`.font-option[data-font-name="${expectedName}"]`).count(), 1);
    }
    await page.evaluate(() => { fontPickerState.headline.search = 'not a real font'; return renderFontList('headline', pickerIds); });
    assert.equal(await page.locator('.font-picker-empty').textContent(), 'No fonts found');
  });

  await t.test('All deduplicates curated Google entries and Popular retains actual provider descriptors', async () => {
    await page.evaluate(() => { fontPickerState.headline.category = 'all'; fontPickerState.headline.search = ''; return renderFontList('headline', pickerIds); });
    assert.equal(await page.locator('.font-option[data-font-name="Syne"]').count(), 1);
    await page.evaluate(() => { fontPickerState.headline.category = 'popular'; return renderFontList('headline', pickerIds); });
    assert.equal(await page.locator('.font-option[data-font-name="Satoshi"]').getAttribute('data-font-category'), 'fontshare');
    assert.equal(await page.locator('.font-option[data-font-name="General Sans"]').getAttribute('data-font-category'), 'fontshare');
  });

  await t.test('failed download leaves document unchanged, exposes retry, and success selects a loaded face', async () => {
    await page.evaluate(() => {
      fontPickerState.headline.category = 'fancy'; fontPickerState.headline.search = 'bagnard';
      document.getElementById(pickerIds.dropdown).classList.add('open');
      loadSuccess = false;
      return renderFontList('headline', pickerIds);
    });
    await page.locator('.font-option[data-font-name="Bagnard"]').click();
    assert.match(await page.locator('.font-picker-error').textContent(), /Bagnard could not load.*Your font is unchanged/);
    assert.equal(await page.locator('.font-option-category').textContent(), 'Retry');
    assert.equal(await page.evaluate(() => textSettings.headlineFont), 'Georgia, serif');
    assert.equal(await page.evaluate(() => updateCount), 0);
    await page.evaluate(() => { loadSuccess = true; });
    await page.locator('.font-option[data-font-name="Bagnard"]').click();
    assert.equal(await page.evaluate(() => textSettings.headlineFont), '"BagnardRegular", serif');
    assert.equal(await page.locator('#font-picker-preview').textContent(), 'Bagnard');
    assert.equal(await page.locator('.font-option[aria-pressed="true"]').count(), 1);
    assert.equal(await page.evaluate(() => updateCount), 1);
    assert.equal(await page.locator('#font-picker-dropdown.open').count(), 0);
    const lastRequest = await page.evaluate(() => requests.at(-1));
    assert.deepEqual(lastRequest, { name: 'Bagnard', options: { weights: [400, 700, 400] } });
  });

  await t.test('late loads cannot overwrite a newer choice or a different screenshot', async () => {
    await page.evaluate(async () => {
      window.pendingFonts = new Map();
      AppScreenFontLibrary.loadFont = name => new Promise(resolve => { pendingFonts.set(name, resolve); });
      fontPickerState.headline.search = '';
      document.getElementById(pickerIds.dropdown).classList.add('open');
      await renderFontList('headline', pickerIds);
      document.querySelector('.font-option[data-font-name="Syne"]').click();
      document.querySelector('.font-option[data-font-name="Instrument Serif"]').click();
      pendingFonts.get('Syne')(true);
    });
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.evaluate(() => textSettings.headlineFont), '"BagnardRegular", serif');
    await page.evaluate(() => { pendingFonts.get('Instrument Serif')(true); });
    await page.waitForFunction(() => textSettings.headlineFont === '"Instrument Serif", serif');
    assert.equal(await page.evaluate(() => updateCount), 2);

    await page.evaluate(async () => {
      document.getElementById(pickerIds.dropdown).classList.add('open');
      await renderFontList('headline', pickerIds);
      document.querySelector('.font-option[data-font-name="Syne"]').click();
      currentScreenshotId = 'different-qa-screenshot';
      pendingFonts.get('Syne')(true);
    });
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.evaluate(() => textSettings.headlineFont), '"Instrument Serif", serif');
    assert.equal(await page.evaluate(() => updateCount), 2);
  });
  assert.deepEqual(externalRequests, [], 'The picker fixture must not contact providers or alter a real user project');
  assert.deepEqual(pageErrors, []);
});
