import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { matchesGlob, posix } from 'node:path';
import { ensurePrivateBucket, BUCKET_POLICY } from '../../deploy/ensure-storage.mjs';

const root = new URL('../../', import.meta.url);
const read = (file: string) => readFile(new URL(file, root), 'utf8');

function htmlRuntimeAssets(html: string, documentPath: string) {
  const assets = new Set<string>();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = new Map([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1].toLowerCase(), match[3]]));
    const script = /^<script\b/i.test(tag);
    if (!script && !attributes.get('rel')?.toLowerCase().split(/\s+/).includes('stylesheet')) continue;
    const reference = attributes.get(script ? 'src' : 'href');
    if (!reference) continue;
    const url = new URL(reference, `https://appscreen.invalid/${documentPath}`);
    if (url.origin === 'https://appscreen.invalid') assets.add(decodeURIComponent(url.pathname.slice(1)));
  }
  return [...assets];
}

// A focused lint for this repository's literal COPY paths and root-anchored
// allowlist, not a substitute for building/running the image on the target host.
function assertRuntimeAssetsPackaged(docker: string, ignore: string, assets: string[]) {
  const copies = [...docker.replace(/\\\r?\n/g, ' ').matchAll(/^COPY\s+(.+)$/gm)].flatMap(match => {
    const words = match[1].trim().split(/\s+/);
    assert.ok(words.every(word => !word.startsWith('--') && !/["'\[\]*?]/.test(word)), 'Update the packaging lint before introducing non-literal COPY syntax.');
    const destination = words.pop()!;
    return words.map(source => ({ source: posix.normalize(source), directory: source.endsWith('/'), destination: posix.normalize(destination).replace(/\/$/, '') }));
  });
  const rules = ignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const included = (path: string) => {
    let allowed = true;
    for (const rule of rules) {
      const allow = rule.startsWith('!');
      const pattern = (allow ? rule.slice(1) : rule).replace(/^\/+|\/+$/g, '');
      if (matchesGlob(path, pattern)) allowed = allow;
    }
    return allowed;
  };
  for (const asset of assets) {
    const copy = copies.find(item => {
      const target = item.directory ? item.destination : posix.join(item.destination, posix.basename(item.source));
      return item.directory ? asset.startsWith(`${target}/`) : asset === target;
    });
    assert.ok(copy, `SaaS image does not COPY runtime asset ${asset} to its expected path.`);
    const source = copy.directory ? posix.join(copy.source, posix.relative(copy.destination, asset)) : copy.source;
    const parts = source.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const path = parts.slice(0, length).join('/');
      assert.ok(included(path), `SaaS build context excludes runtime asset ${asset} at ${path}.`);
    }
  }
}

async function runtimePackagingInputs() {
  const [docker, ignore, editor, shell] = await Promise.all([read('Dockerfile.saas'), read('Dockerfile.saas.dockerignore'), read('index.html'), read('saas/index.html')]);
  const assets = [...new Set(['index.html', 'saas/index.html', ...htmlRuntimeAssets(editor, 'index.html'), ...htmlRuntimeAssets(shell, 'saas/index.html')])];
  return { docker, ignore, assets };
}

test('SaaS image uses an immutable Node base, reviewed lockfile browser and a non-root sandbox gate', async () => {
  const [docker, lock, start, browser] = await Promise.all([read('Dockerfile.saas'), read('package-lock.json'), read('deploy/start.mjs'), read('deploy/verify-browser.mjs')]);
  assert.match(docker, /FROM node:22\.22\.3-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.equal(JSON.parse(lock).packages['node_modules/playwright'].version, '1.59.1');
  assert.match(docker, /npm ci --include=dev/);
  assert.match(docker, /\.\/node_modules\/\.bin\/playwright install --with-deps chromium/);
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
  assert.doesNotMatch(docker, /^(ARG|ENV).*?(SECRET|API_KEY|DATABASE_URL|TOKEN)/m);
  assert.match(start, /await verifyConfiguredStorage\(\)/);
  assert.match(start, /await assertBrowserSandbox\(\)/);
  assert.match(browser, /chromiumSandbox: true/);
  assert.match(browser, /process\.getuid/);
  assert.doesNotMatch(browser, /chromiumSandbox: false|--no-sandbox|ignoreDefaultArgs/);
});

test('SaaS build context explicitly excludes local secrets and user data while every COPY input exists', async () => {
  const docker = await read('Dockerfile.saas'), ignore = await read('Dockerfile.saas.dockerignore');
  const rules = ignore.split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(rules[0], '**');
  for (const required of ['!package.json', '!package-lock.json', '!supabase/migrations/**', '**/.env*', '**/node_modules/**', '**/tests/**']) assert.ok(rules.includes(required), required);
  for (const denied of ['!.env', '!.env.saas', '!.appscreen-data/**', '!db/**', '!.git/**']) assert.ok(!rules.includes(denied), denied);
  assert.doesNotMatch(docker, /^COPY\s+\.\s/m);
  for (const line of docker.split('\n').filter(line => line.startsWith('COPY '))) {
    for (const source of line.trim().split(/\s+/).slice(1, -1)) await access(new URL(source, root));
  }
});

test('SaaS image packages every local editor and customer-shell script/stylesheet at its served path', async () => {
  const { docker, ignore, assets } = await runtimePackagingInputs();
  for (const required of ['font-library.js', 'app.js', 'styles.css', 'core/editor-bridge.mjs', 'saas/app.js', 'saas/styles.css']) assert.ok(assets.includes(required), required);
  assertRuntimeAssetsPackaged(docker, ignore, assets);
  for (const asset of assets) await access(new URL(asset, root));
});

test('runtime asset extraction ignores remote resources and keeps relative/absolute local URLs without cache queries', () => {
  assert.deepEqual(htmlRuntimeAssets(`<script src="/font-library.js?v=2"></script><script src='app.js#v3'></script><link href="styles.css?v=1" rel="stylesheet"><link rel="preconnect" href="https://fonts.googleapis.com"><script src="https://cdn.example.com/lib.js"></script><script src="//cdn.example.com/lib.js"></script><script>inline()</script>`, 'saas/index.html'), ['font-library.js', 'saas/app.js', 'saas/styles.css']);
});

test('runtime packaging regression catches missing font COPY, context exclusions, and omitted/misplaced SaaS directory copies', async () => {
  const { docker, ignore, assets } = await runtimePackagingInputs();
  assertRuntimeAssetsPackaged(docker, ignore, assets);
  assert.throws(() => assertRuntimeAssetsPackaged(docker.replace(/\bfont-library\.js\s+/g, ''), ignore, assets), /does not COPY runtime asset font-library\.js/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker, ignore.replace(/^!font-library\.js\r?\n/gm, ''), assets), /excludes runtime asset font-library\.js/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker, `${ignore}\nfont-library.js\n`, assets), /excludes runtime asset font-library\.js/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker, `${ignore}\nsaas/app.js\n`, assets), /excludes runtime asset saas\/app\.js/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker, ignore.replace(/^!saas\/\*\*\r?\n/gm, ''), assets), /excludes runtime asset saas\/index\.html/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker.replace(/^COPY saas\/ .*\r?\n/gm, ''), ignore, assets), /does not COPY runtime asset saas\/index\.html/);
  assert.throws(() => assertRuntimeAssetsPackaged(docker.replace(/^COPY saas\/ \.\/saas\//m, 'COPY saas/ ./wrong-location/'), ignore, assets), /does not COPY runtime asset saas\/index\.html/);
});

test('Render blueprint has distinct web/worker processes, HTTP health only on web, and safe feature defaults', async () => {
  const blueprint = await read('deploy/render.yaml');
  assert.match(blueprint, /type: web/); assert.match(blueprint, /type: worker/);
  assert.match(blueprint, /deploy\/start\.mjs web/); assert.match(blueprint, /deploy\/start\.mjs worker/);
  assert.equal((blueprint.match(/healthCheckPath:/g) || []).length, 1);
  assert.match(blueprint, /healthCheckPath: \/health/);
  assert.match(blueprint, /preDeployCommand: npm run db:migrate/);
  for (const setting of ['APPSCREEN_DEV_AUTH', 'APPSCREEN_EMBEDDED_WORKER', 'APPSCREEN_ENABLE_AI', 'APPSCREEN_MCP_OAUTH', 'APPSCREEN_EMAIL_ENABLED']) assert.match(blueprint, new RegExp(`key: ${setting}\\s+value: 'false'`));
  assert.doesNotMatch(blueprint.split('\n').filter(line => !line.trim().startsWith('#')).join('\n'), /generateValue|postgresql:\/\/|sk_live_|sk-proj-/);
});

test('storage inspection refuses public or unrestricted buckets and never mutates an existing bucket', async () => {
  const client = (data: any) => ({ getBucket: async () => ({ data, error: null }), createBucket: async () => { throw new Error('unexpected write'); } });
  await assert.rejects(ensurePrivateBucket(client({ public: true }), 'appscreen-private'), /private/);
  await assert.rejects(ensurePrivateBucket(client({ public: false }), 'appscreen-private'), /exactly PNG/);
  await assert.rejects(ensurePrivateBucket(client({ public: false, allowed_mime_types: BUCKET_POLICY.allowedMimeTypes, file_size_limit: 1024 }), 'appscreen-private'), /below/);
  const result = await ensurePrivateBucket(client({ public: false, allowed_mime_types: BUCKET_POLICY.allowedMimeTypes, file_size_limit: BUCKET_POLICY.fileSizeLimit }), 'appscreen-private');
  assert.deepEqual(result, { name: 'appscreen-private', created: false, private: true });
});

test('creating a missing private bucket requires explicit operator flag; permission errors are not mistaken for absence', async () => {
  const writes: any[] = [];
  const missing = { getBucket: async () => ({ error: { status: 404 } }), createBucket: async (...args: any[]) => { writes.push(args); return { error: null }; } };
  await assert.rejects(ensurePrivateBucket(missing, 'appscreen-private'), /--create/);
  assert.equal(writes.length, 0);
  assert.equal((await ensurePrivateBucket(missing, 'appscreen-private', { create: true })).created, true);
  assert.deepEqual(writes, [['appscreen-private', BUCKET_POLICY]]);
  await assert.rejects(ensurePrivateBucket({ ...missing, getBucket: async () => ({ error: { status: 403 } }) }, 'appscreen-private', { create: true }));
  assert.equal(writes.length, 1);
});
