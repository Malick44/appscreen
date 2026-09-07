import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';

const editorSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const languageSource = readFileSync(new URL('../language-utils.js', import.meta.url), 'utf8');
const magicSource = readFileSync(new URL('../magical-titles.js', import.meta.url), 'utf8');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start + 1) + 2;
  assert.ok(start >= 0 && end > start, `Missing editor function: ${name}`);
  return source.slice(start, end);
}
const helpers = [
  ...['escapeInspectorText', 'getScreenshotDeviceLabel', 'updateScreenshotList', 'updateProjectSelector',
    'updateElementsList', 'updateGradientStopsUI', 'updateTextGradientStopsUI', 'updateLanguageMenu',
    'updateLanguagesList', 'openTranslateModal', 'showAppAlert', 'showAppConfirm', 'showTemplateToast']
    .map(name => extract(editorSource, name)),
  extract(languageSource, 'updateScreenshotTranslationsList'),
].join('\n');

// A fresh, isolated browser tests real HTML parsing, not just encoded substrings.
// No application session, database, original screenshot, or provider is used.
test('imported campaign strings remain inert text throughout the legacy editor', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const payload = `"'><img src="https://appscreen-import.invalid/attack" onerror="window.__importExecuted=1"><script>window.__importExecuted=1</script> & Café <3`;
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=';
  await page.setContent(`<div id="project-menu"></div><div id="project-trigger-name"></div><div id="project-trigger-meta"></div>
    <div id="screenshot-list"></div><div id="no-screenshot"></div><div id="elements-list"></div><div id="elements-empty"></div>
    <div id="gradient-stops"></div><div id="headline-gradient-stops"></div><div id="language-menu-items"></div><div id="languages-list"></div>
    <div id="translate-target-type"></div><select id="translate-source-lang"></select><div id="translate-targets"></div><div id="translate-modal"></div>
    <div id="screenshot-translations-list"></div>`);
  await page.addScriptTag({ content: helpers });
  await page.evaluate(({ payload, image }) => {
    Object.assign(window, {
      state: { screenshots: [{ id: 'scene', name: payload, image: { src: image, width: 1, height: 1 } }], selectedIndex: 0,
        projectLanguages: ['en'], currentLanguage: 'en', transferTarget: null },
      projects: [{ id: 'project', name: payload }], currentProjectId: 'project', selectedElementId: null,
      screenshotList: document.getElementById('screenshot-list'), noScreenshot: document.getElementById('no-screenshot'),
      getScreenshotImage: shot => shot.image, getAvailableLanguagesForScreenshot: () => ['en'], isScreenshotComplete: () => true,
      languageFlags: { en: '🇬🇧' }, languageNames: { en: 'English' }, getElementText: el => el.text,
      updateTranslateSourcePreview() {}, undoLastTemplate() {}, templateToastTimer: null,
    });
    updateScreenshotList();
  }, { payload, image });

  await t.test('project and screenshot names keep all plain-text characters and cannot inject tags or attributes', async () => {
    assert.equal(await page.locator('.project-option-name').textContent(), payload);
    assert.equal(await page.locator('.screenshot-name').textContent(), payload);
    assert.equal(await page.locator('.screenshot-thumb').getAttribute('alt'), payload);
    assert.equal(await page.locator('.screenshot-thumb').getAttribute('src'), image);
    assert.equal(await page.locator('#project-menu img, .screenshot-name img, [onerror]').count(), 0);
  });

  await t.test('element names, text, emoji, layer labels and image attributes stay inert', async () => {
    const hostileImage = `${image}" onerror="window.__importExecuted=1`;
    await page.evaluate(({ payload, hostileImage }) => {
      window.getElements = () => [
        { id: 'text', type: 'text', text: payload, layer: payload },
        { id: 'emoji', type: 'emoji', emoji: payload, name: payload, layer: 'above-text' },
        { id: 'graphic', type: 'graphic', name: payload, image: { src: hostileImage }, layer: 'behind-screenshot' },
        { id: 'icon', type: 'icon', name: payload, image: { src: hostileImage }, layer: 'above-screenshot' },
      ];
      updateElementsList();
    }, { payload, hostileImage });
    assert.deepEqual(await page.locator('.element-item-name').allTextContents(), [payload, `${payload} ${payload}`, payload, payload]);
    assert.equal(await page.locator('.element-item-layer').first().textContent(), payload);
    assert.equal(await page.locator('.emoji-thumb').textContent(), payload);
    assert.equal(await page.locator('.element-item-thumb img').count(), 2);
    assert.equal(await page.locator('.element-item-thumb img').first().getAttribute('src'), hostileImage);
    assert.equal(await page.locator('#elements-list [onerror], .element-item-name img').count(), 0);
  });

  await t.test('gradient control values cannot escape their quoted attributes', async () => {
    await page.evaluate(payload => {
      window.getBackground = () => ({ gradient: { stops: [{ color: payload, position: payload }] } });
      window.getTextSettings = () => ({ headlineGradientStops: [{ color: payload, position: payload }] });
      updateGradientStopsUI(); updateTextGradientStopsUI('headline');
    }, payload);
    for (const selector of ['#gradient-stops', '#headline-gradient-stops']) {
      assert.equal(await page.locator(`${selector} input`).count(), 2);
      assert.equal(await page.locator(`${selector} input`).first().getAttribute('value'), payload);
      assert.equal(await page.locator(`${selector} img, ${selector} [onerror]`).count(), 0);
    }
    const cssPayload = 'red),url(https://appscreen-import.invalid/css),linear-gradient(red';
    await page.evaluate(value => {
      window.getBackground = () => ({ gradient: { stops: [{ color: value, position: 50 }] } });
      window.getTextSettings = () => ({ headlineGradientStops: [{ color: value, position: 50 }] });
      updateGradientStopsUI(); updateTextGradientStopsUI('headline');
    }, cssPayload);
    assert.equal(await page.locator('#gradient-stops input[type=color]').getAttribute('value'), cssPayload);
    assert.equal(await page.locator('#gradient-stops [style], #headline-gradient-stops [style]').count(), 0);
  });

  await t.test('language labels and headline textarea values cannot become markup', async () => {
    const headline = `</textarea>${payload}\nListening for everyone & you <3`;
    await page.evaluate(({ payload, headline }) => {
      state.projectLanguages = [payload]; state.currentLanguage = payload;
      window.getTextSettings = () => ({ headlineLanguages: [payload], headlines: { [payload]: headline } });
      updateLanguageMenu(); updateLanguagesList(); openTranslateModal('headline');
      window.currentTranslationsIndex = 0;
      updateScreenshotTranslationsList();
    }, { payload, headline });
    assert.equal(await page.locator('#languages-list .name').textContent(), payload.toUpperCase());
    assert.equal(await page.locator('#translate-targets textarea').count(), 1);
    assert.equal(await page.locator('#translate-targets textarea').inputValue(), headline);
    assert.equal(await page.locator('#translate-targets textarea').getAttribute('placeholder'), `Enter ${payload} translation...`);
    assert.equal(await page.locator('#translate-source-lang option').getAttribute('value'), payload);
    assert.equal(await page.locator('#screenshot-translations-list .name').textContent(), payload.toUpperCase());
    assert.equal(await page.locator('#screenshot-translations-list button').getAttribute('title'), `Upload ${payload.toUpperCase()} screenshot`);
    assert.equal(await page.locator('#translate-targets img, #languages-list img, #screenshot-translations-list img').count(), 0);
  });

  await t.test('toast and confirmation feedback show imported text literally', async () => {
    await page.evaluate(payload => { showTemplateToast(payload); void showAppAlert(payload); void showAppConfirm(payload, payload, payload); }, payload);
    assert.equal(await page.locator('#template-toast span').textContent(), payload);
    assert.deepEqual(await page.locator('.modal-message').allTextContents(), [payload, payload]);
    assert.equal(await page.locator('.modal-overlay').last().locator('.modal-btn-confirm').textContent(), payload);
    assert.equal(await page.locator('.modal-overlay').last().locator('.modal-btn-cancel').textContent(), payload);
    assert.equal(await page.locator('.modal-overlay img, #template-toast img').count(), 0);
  });

  assert.equal(await page.evaluate(() => window.__importExecuted), undefined);
  assert.deepEqual(requests, [], 'Imported markup must not trigger any external requests');
});

test('remaining image and locale dialog attributes share the same escaping boundary', () => {
  const duplicateDialog = extract(languageSource, 'showDuplicateDialog');
  assert.match(duplicateDialog, /escapeInspectorText\(existingLangImg\.src\)/);
  assert.match(duplicateDialog, /escapeInspectorText\(params\.newSrc\)/);
  assert.match(magicSource, /value="\$\{escapeInspectorText\(lang\)\}">\$\{escapeInspectorText\(langName\)\}/);
});

test('imported output profile IDs cannot resolve inherited object properties as dimensions', () => {
  const start = editorSource.indexOf('let resolveEditorReady;');
  const end = editorSource.indexOf('// Initialize the app', start);
  assert.ok(start > 0 && end > start);
  const state = {}, window = {};
  const context = {
    state, window, deviceDimensions: { 'iphone-6.9': { width: 1320, height: 2868 } }, projects: [],
    saveProjectsMeta() {}, updateProjectSelector() {}, syncUIWithState() {}, updateScreenshotList() {}, updateElementsList() {}, updateCanvas() {},
  };
  runInNewContext(editorSource.slice(start, end), context);
  for (const id of ['__proto__', 'constructor', 'toString', 'unknown']) {
    window.AppScreenEditorRuntime.replace({ id: 'import', outputDevice: id, customWidth: 320, customHeight: 640, screenshots: [] });
    assert.equal(state.outputDevice, 'custom');
    assert.equal(state.customWidth, 320); assert.equal(state.customHeight, 640);
  }
  window.AppScreenEditorRuntime.replace({ id: 'import', outputDevice: 'iphone-6.9', screenshots: [] });
  assert.equal(state.outputDevice, 'iphone-6.9');
});

test('cloud imports and cached reloads never auto-fetch fonts or icons from metadata', async () => {
  const source = ['isCloudDocumentContext', 'updateSingleFontPickerPreview', 'updateElementFontPickerPreview', 'reconstructElementImages']
    .map(name => extract(editorSource, name)).join('\n');
  const fonts = [], icons = [], images = [], controls = new Map();
  const context = {
    state: { cloudDocument: { id: 'cloud' } }, window: { location: { pathname: '/editor', search: '?project=cloud' } }, URLSearchParams,
    googleFonts: { system: [] }, getTextSettings: () => ({ headlineFont: "'Untrusted imported font', sans-serif" }),
    loadGoogleFont: name => fonts.push(name), getLucideImage: name => { icons.push(name); return Promise.resolve({}); },
    document: { getElementById: id => { if (!controls.has(id)) controls.set(id, { style: {} }); return controls.get(id); } },
    Image: class { constructor() { images.push(this); } }, updateCanvas() {}, console,
  };
  runInNewContext(source, context);
  const runAutomaticRestore = () => {
    context.updateSingleFontPickerPreview('font', 'preview', 'headlineFont');
    context.updateElementFontPickerPreview({ font: "'Untrusted imported font', sans-serif" });
    return context.reconstructElementImages([
      { type: 'icon', assetId: 'verified-original', src: '/api/media/verified-original?token=local-fixture', iconName: '../../../untrusted' },
      { type: 'icon', assetId: 'pending-original', iconName: '../../../untrusted' },
    ]);
  };
  for (const cachedReload of [false, true]) {
    context.state.cloudDocument = cachedReload ? null : { id: 'cloud' };
    const restored = runAutomaticRestore();
    assert.equal(restored[0].image.src, '/api/media/verified-original?token=local-fixture');
    assert.equal(restored[1].image, undefined);
  }
  assert.deepEqual(fonts, []); assert.deepEqual(icons, []);
  assert.equal(controls.get('preview').textContent, 'Untrusted imported font');
  assert.equal(controls.get('preview').style.fontFamily, "'Untrusted imported font', sans-serif");
  // The legacy editor retains its existing automatic provider behavior; explicit
  // font-picker calls still call loadGoogleFont directly in either context.
  context.window.location = { pathname: '/editor', search: '' };
  context.updateSingleFontPickerPreview('font', 'preview', 'headlineFont');
  context.reconstructElementImages([{ type: 'icon', iconName: 'activity' }]);
  assert.deepEqual(fonts, ['Untrusted imported font']); assert.deepEqual(icons, ['activity']);
});
