import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

test('browser notices serve exact installed texts without exposing arbitrary package files', async () => {
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: 'postgresql://unused/unused_test', APPSCREEN_SIGNING_SECRET: 'isolated-notices-test-'.repeat(4) });
  const runtime = await createApp(config, { query: async () => { throw new Error('Public notices must not read private account data.'); } } as any);
  try {
    const page = await runtime.app.inject('/third-party-notices'); assert.equal(page.statusCode, 200); assert.match(page.headers['content-type']!, /^text\/html/);
    for (const [url, file] of [['/third-party/supabase-license.txt', '../../node_modules/@supabase/supabase-js/LICENSE'], ['/render/fonts/LICENSE.txt', '../../render/fonts/LICENSE.txt']]) {
      const response = await runtime.app.inject(url); assert.equal(response.statusCode, 200); assert.match(response.headers['content-type']!, /^text\/plain/);
      assert.equal(response.body, await readFile(new URL(file, import.meta.url), 'utf8'));
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    const bundle = await runtime.app.inject('/saas/vendor/supabase.js'); assert.equal(bundle.statusCode, 200);
    assert.equal(bundle.headers.link, '</third-party/supabase-license.txt>; rel="license"');
    for (const path of ['/third-party/package.json', '/third-party/supabase-license.txt/../package.json', '/node_modules/@supabase/supabase-js/package.json', '/third-party/../../.env']) assert.equal((await runtime.app.inject(path)).statusCode, 404, path);
    // Known static resources remain accessible without spending the API budget.
    for (let index = 0; index < 190; index++) assert.equal((await runtime.app.inject('/third-party/supabase-license.txt')).statusCode, 200);
  } finally { await runtime.app.close(); }
});
