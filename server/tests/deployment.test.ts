import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { ensurePrivateBucket, BUCKET_POLICY } from '../../deploy/ensure-storage.mjs';

const root = new URL('../../', import.meta.url);
const read = (file: string) => readFile(new URL(file, root), 'utf8');

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
