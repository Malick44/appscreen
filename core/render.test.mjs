import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { createCampaign, resolveDevice, assertDocumentEditAllowed } from './campaign.mjs';

const root = resolve(import.meta.dirname, '..');
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const assets = [1, 2, 3].map(id => ({ id: `asset-${id}`, width: 660, height: 1434 }));
const reorderObjectKeys = value => Array.isArray(value) ? value.map(reorderObjectKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)).map(([key, child]) => [key, reorderObjectKeys(child)])) : value;

test('headless worker renders actual pixels deterministically and matches the shared editor composition', async t => {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('https://**', route => route.abort());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/render/index.html`);
  await page.waitForFunction(() => window.AppScreenRenderer);
  const doc = createCampaign({ assets, templateId: 'tidal-relay', screenCount: 3, profile: { id: 'test', width: 660, height: 1434 } });
  doc.scenes.forEach((scene, index) => { scene.background.noise = true; scene.text.headlines.en = `A useful benefit ${index + 1}`; scene.text.headlineSize = 45; });
  const result = await page.evaluate(async document => {
    const { toLegacyState } = await import('/core/campaign.mjs');
    const { loadImage, renderLegacyScene } = await import('/core/render.mjs');
    // This is a labeled geometry-test fixture, never a customer campaign source.
    const fixture = window.document.createElement('canvas'); fixture.width = 660; fixture.height = 1434;
    const ctx = fixture.getContext('2d'); ctx.fillStyle = '#254052'; ctx.fillRect(0, 0, 660, 1434);
    for (let index = 0; index < 12; index++) { ctx.fillStyle = index % 2 ? '#7EDADC' : '#E9EEF0'; ctx.fillRect(30, 40 + index * 110, 600, 70); }
    const url = fixture.toDataURL(), assets = Object.fromEntries(document.sources.map(source => [source.assetId, url]));
    const first = await window.AppScreenRenderer.render({ document, sceneId: document.scenes[1].id, assets });
    const second = await window.AppScreenRenderer.render({ document, sceneId: document.scenes[1].id, assets });
    const legacy = await toLegacyState(document, async id => assets[id]);
    const editorCanvas = window.document.createElement('canvas'); editorCanvas.width = document.profile.width; editorCanvas.height = document.profile.height;
    const image = await loadImage(url);
    renderLegacyScene(editorCanvas.getContext('2d'), document.profile, legacy.screenshots[1], { locale: document.locale, getImage: () => image, seed: document.seed });
    const imageBytes = window.document.querySelector('canvas').getContext('2d').getImageData(0, 0, 660, 1434).data;
    const uniquePixels = new Set(); for (let i = 0; i < imageBytes.length; i += 4 * 200) uniquePixels.add(`${imageBytes[i]},${imageBytes[i+1]},${imageBytes[i+2]}`);
    return { repeatable: first.png === second.png, parity: first.png === editorCanvas.toDataURL(), width: first.width, height: first.height, pngLength: first.png.length, distinctColors: uniquePixels.size, qa: first.qa };
  }, doc);
  assert.deepEqual(errors, []);
  assert.equal(result.width, 660); assert.equal(result.height, 1434);
  assert.equal(result.repeatable, true); assert.equal(result.parity, true);
  assert.ok(result.pngLength > 50000); assert.ok(result.distinctColors > 50);
  assert.equal(result.qa.passed, true);

  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.AppScreenCloudBridge?.ready);
  const bridgeResult = await page.evaluate(async document => {
    const originalId = window.AppScreenEditorRuntime.snapshot().id;
    const fixture = window.document.createElement('canvas'); fixture.width = 660; fixture.height = 1434;
    const ctx = fixture.getContext('2d'); ctx.fillStyle = '#326786'; ctx.fillRect(0, 0, 660, 1434);
    const url = fixture.toDataURL();
    await window.AppScreenCloudBridge.importDocument(document, { resolveAsset: async () => url });
    const exported = window.AppScreenCloudBridge.exportDocument();
    return { originalId, currentId: window.AppScreenEditorRuntime.snapshot().id, sceneCount: exported.scenes.length, width: exported.profile.width, sourceCount: exported.sources.length, sourceIds: exported.sources.map(source => source.assetId) };
  }, doc);
  assert.notEqual(bridgeResult.originalId, bridgeResult.currentId);
  assert.equal(bridgeResult.currentId, doc.id);
  assert.equal(bridgeResult.sceneCount, 3);
  assert.equal(bridgeResult.sourceCount, 3);
  assert.deepEqual(bridgeResult.sourceIds, doc.sources.map(source => source.assetId));
  assert.equal(bridgeResult.width, 660);
  assert.deepEqual(errors, []);

  // Exercise the entire runtime import/normalization/UI edit/export path, not just
  // the serializable converters: UI synchronization must not detach the last seam.
  for (const count of [3, 5]) {
    const exact = reorderObjectKeys(createCampaign({
      assets: Array.from({ length: count }, (_, index) => ({ id: `exact-asset-${index}`, width: 1179, height: 2556 })),
      templateId: 'tidal-relay', templateMode: 'exact', screenCount: count,
    }));
    await page.evaluate(async document => {
      const fixture = window.document.createElement('canvas'); fixture.width = 1179; fixture.height = 2556;
      const context = fixture.getContext('2d');
      const imageURLs = new Map(document.sources.map((source, index) => {
        context.fillStyle = `hsl(${index * 45}, 45%, 40%)`;
        context.fillRect(0, 0, fixture.width, fixture.height);
        return [source.assetId, fixture.toDataURL()];
      }));
      await window.AppScreenCloudBridge.importDocument(document, { resolveAsset: async id => imageURLs.get(id) });
    }, exact);
    await page.locator('[data-tab="text"]').click();
    await page.locator('#headline-text').fill('Turn text into\nlistening');
    const exported = await page.evaluate(() => window.AppScreenCloudBridge.exportDocument());
    assert.equal(exported.scenes[0].text.headlines.en, 'Turn text into\nlistening');
    for (const scene of exact.scenes) for (const device of scene.devices) {
      assert.deepEqual(resolveDevice(exported, scene.id, device.id), resolveDevice(exact, scene.id, device.id), `${count}-screen runtime device ${device.id}`);
    }
    assert.deepEqual(exported.locks, exact.locks);
    assert.equal(assertDocumentEditAllowed(exact, exported), exported);
  }
  assert.deepEqual(errors, []);
});
