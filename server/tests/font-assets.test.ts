import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

test('font catalog, independent font assets and their licenses are public with browser-safe MIME types', async () => {
  const config = loadConfig({
    NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: 'postgresql://unused/unused_test',
    APPSCREEN_SIGNING_SECRET: 'isolated-font-assets-test-'.repeat(4),
  });
  const runtime = await createApp(config, {
    query: async () => { throw new Error('Public fonts must not read private account data.'); },
  } as any);
  try {
    const catalog = await runtime.app.inject('/font-library.js');
    assert.equal(catalog.statusCode, 200);
    assert.match(catalog.headers['content-type']!, /^text\/javascript/);
    assert.equal(catalog.body, await readFile(new URL('../../font-library.js', import.meta.url), 'utf8'));
    assert.equal(catalog.headers['x-content-type-options'], 'nosniff');

    const assets = [
      { css: 'bagnard.css', binary: 'BagnardRegular.otf', license: 'Bagnard-OFL.txt', mime: 'font/otf' },
      { css: 'trickster.css', binary: 'TricksterRegular.ttf', license: 'Trickster-OFL.txt', mime: 'font/ttf' },
      { css: 'cotham.css', binary: 'CothamSansRegular.otf', license: 'Cotham-OFL.txt', mime: 'font/otf' },
      { css: 'avara.css', binary: 'AvaraBold.ttf', license: 'Avara-OFL.txt', mime: 'font/ttf' },
    ];
    for (const asset of assets) {
      const cssPath = `/render/fonts/fancy/${asset.css}`;
      const css = await runtime.app.inject(cssPath);
      assert.equal(css.statusCode, 200, cssPath);
      assert.match(css.headers['content-type']!, /^text\/css/);
      assert.match(css.body, /@font-face/);
      assert.ok(css.body.includes(asset.binary), `${cssPath} must reference its bundled font`);
      assert.equal(css.body, await readFile(new URL(`../../render/fonts/fancy/${asset.css}`, import.meta.url), 'utf8'));

      const binaryPath = `/render/fonts/fancy/${asset.binary}`;
      const binary = await runtime.app.inject(binaryPath);
      assert.equal(binary.statusCode, 200, binaryPath);
      assert.equal(binary.headers['content-type'], asset.mime);
      assert.ok(binary.rawPayload.length > 1000, `${binaryPath} must contain font bytes`);
      assert.deepEqual(binary.rawPayload, await readFile(new URL(`../../render/fonts/fancy/${asset.binary}`, import.meta.url)));
      assert.equal(binary.headers['x-content-type-options'], 'nosniff');

      const licensePath = `/render/fonts/fancy/${asset.license}`;
      const license = await runtime.app.inject(licensePath);
      assert.equal(license.statusCode, 200, licensePath);
      assert.match(license.headers['content-type']!, /^text\/plain/);
      assert.ok(license.rawPayload.length > 100, `${licensePath} must contain a license, not an empty placeholder`);
      assert.equal(license.body, await readFile(new URL(`../../render/fonts/fancy/${asset.license}`, import.meta.url), 'utf8'));
      assert.equal(license.headers['x-content-type-options'], 'nosniff');
    }
  } finally {
    await runtime.app.close();
  }
});
