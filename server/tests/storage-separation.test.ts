import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { createApp } from '../app.js';
import type { DB } from '../db.js';
import { verifiedEmailResolver } from '../email.js';
import { verifyAuthServerToken } from '../auth-server.js';
import { resolveStorageConfig } from '../../deploy/storage-config.mjs';
import { BUCKET_POLICY, verifyConfiguredStorage } from '../../deploy/ensure-storage.mjs';

// Entirely synthetic configuration and intercepted HTTP; never load dotenv or a DB.
const authOrigin = 'https://appscreen-auth.example.test';
const storageOrigin = 'https://shared-storage.example.test';
const publicKey = 'synthetic-appscreen-public-key';
const authKey = 'synthetic-appscreen-auth-admin-key';
const storageKey = 'synthetic-shared-storage-admin-key';
const userId = '4c3602f8-27b2-4a43-a44f-9c89c3f5e76d';
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', APP_BASE_URL: 'https://appscreen.example.test',
  DATABASE_URL: 'postgresql://unused/unused_storage_separation_test',
  APPSCREEN_SIGNING_SECRET: 'synthetic-appscreen-signing-secret-'.repeat(3),
  SUPABASE_URL: authOrigin, SUPABASE_PUBLISHABLE_KEY: publicKey,
  SUPABASE_SERVICE_ROLE_KEY: authKey, SUPABASE_AUTH_VERIFICATION: 'auth-server',
  SUPABASE_STORAGE_URL: storageOrigin, SUPABASE_STORAGE_SERVICE_ROLE_KEY: storageKey,
  SUPABASE_STORAGE_BUCKET: 'appscreen-private',
};
const bucket = { id: 'appscreen-private', name: 'appscreen-private', public: false,
  allowed_mime_types: BUCKET_POLICY.allowedMimeTypes, file_size_limit: BUCKET_POLICY.fileSizeLimit };
function mockFetch(t: TestContext, handler: typeof fetch = async () => { throw new Error('Unexpected external request.'); }) {
  const mock = t.mock.method(globalThis, 'fetch', handler);
  t.after(() => mock.mock.restore());
  return mock;
}
function legacyEnvironment() {
  const env = { ...environment };
  delete env.SUPABASE_STORAGE_URL;
  delete env.SUPABASE_STORAGE_SERVICE_ROLE_KEY;
  return env;
}
function assertPrivateError(error: unknown) {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(`${error.message}\n${error.stack}`, /synthetic-appscreen-auth-admin-key|synthetic-shared-storage-admin-key|private-marker/);
  return true;
}

test('split storage uses one explicit credential pair; legacy and empty overrides retain the original pair', () => {
  assert.deepEqual(resolveStorageConfig(environment), { url: storageOrigin, key: storageKey });
  assert.deepEqual(resolveStorageConfig(legacyEnvironment()), { url: authOrigin, key: authKey });
  assert.deepEqual(resolveStorageConfig({ ...legacyEnvironment(), SUPABASE_STORAGE_URL: '', SUPABASE_STORAGE_SERVICE_ROLE_KEY: '' }), { url: authOrigin, key: authKey });
  const config = loadConfig(environment);
  assert.equal(config.supabaseUrl, authOrigin);
  assert.equal(config.supabaseServiceKey, authKey);
  assert.equal(config.supabaseStorageUrl, storageOrigin);
  assert.equal(config.supabaseStorageServiceKey, storageKey);
});

test('partial overrides fail before network in configuration, runtime and startup without falling back to Auth keys', async t => {
  const requests = mockFetch(t);
  for (const changes of [
    { SUPABASE_STORAGE_URL: undefined }, { SUPABASE_STORAGE_SERVICE_ROLE_KEY: undefined },
    { SUPABASE_STORAGE_URL: '' }, { SUPABASE_STORAGE_SERVICE_ROLE_KEY: '' },
    { SUPABASE_STORAGE_SERVICE_ROLE_KEY: ' ' },
  ]) {
    const env = { ...environment, ...changes };
    assert.throws(() => loadConfig(env), assertPrivateError);
    await assert.rejects(verifyConfiguredStorage({ env }), assertPrivateError);
    assert.throws(() => createStorage({ ...loadConfig(environment),
      supabaseStorageUrl: env.SUPABASE_STORAGE_URL || '', supabaseStorageServiceKey: env.SUPABASE_STORAGE_SERVICE_ROLE_KEY || '',
    }), assertPrivateError);
  }
  assert.equal(requests.mock.callCount(), 0);
});

test('explicit storage origins must be canonical HTTPS even outside production and errors contain no input values', async t => {
  const requests = mockFetch(t);
  for (const url of [
    'not-a-url', 'http://shared-storage.example.test', `${storageOrigin}/`, `${storageOrigin}/storage/v1`,
    `${storageOrigin}?private-marker`, `${storageOrigin}#private-marker`, 'https://user:private-marker@shared-storage.example.test',
    'https://SHARED-STORAGE.example.test', 'https://shared-storage.example.test:443', ` ${storageOrigin}`,
  ]) {
    for (const NODE_ENV of ['test', 'production']) {
      const env = { ...environment, NODE_ENV, SUPABASE_STORAGE_URL: url };
      assert.throws(() => loadConfig(env), error => {
        assertPrivateError(error);
        assert.match((error as Error).message, /canonical HTTPS origin/);
        return true;
      });
      await assert.rejects(verifyConfiguredStorage({ env }), assertPrivateError);
    }
  }
  assert.equal(requests.mock.callCount(), 0);
});

test('runtime upload/read/remove and startup private-bucket verification use only the Storage origin and key', async t => {
  const calls: Array<{ path: string; method: string }> = [];
  mockFetch(t, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, storageOrigin);
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('apikey'), storageKey);
    assert.equal(headers.get('authorization'), `Bearer ${storageKey}`);
    assert.ok(![...headers.values()].some(value => value.includes(authKey) || value.includes(publicKey)));
    calls.push({ path: url.pathname, method: options?.method || 'GET' });
    if (url.pathname === '/storage/v1/bucket/appscreen-private') return Response.json(bucket);
    if (options?.method === 'GET') return new Response('synthetic-image', { headers: { 'Content-Type': 'image/png' } });
    return Response.json(options?.method === 'DELETE' ? [] : { Key: 'appscreen-private/fixture.png' });
  });
  const storage = createStorage(loadConfig(environment));
  await storage.put('fixture.png', Buffer.from('synthetic-image'), 'image/png');
  assert.equal((await storage.read('fixture.png')).toString(), 'synthetic-image');
  await storage.remove('fixture.png');
  assert.deepEqual(await verifyConfiguredStorage({ env: environment }), { name: 'appscreen-private', created: false, private: true });
  assert.deepEqual(calls, [
    { path: '/storage/v1/object/appscreen-private/fixture.png', method: 'POST' },
    { path: '/storage/v1/object/appscreen-private/fixture.png', method: 'GET' },
    { path: '/storage/v1/object/appscreen-private', method: 'DELETE' },
    { path: '/storage/v1/bucket/appscreen-private', method: 'GET' },
  ]);
});

test('Auth verification and Auth admin identity operations never receive the shared Storage key', async t => {
  const now = Math.floor(Date.now() / 1000), confirmed = new Date(Date.now() - 60_000).toISOString();
  const config = loadConfig(environment);
  const token = await new SignJWT({ iss: `${authOrigin}/auth/v1`, aud: 'authenticated', sub: userId,
    role: 'authenticated', is_anonymous: false, exp: now + 600,
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new TextEncoder().encode('synthetic-token-verification-signing-key'));
  const calls: string[] = [];
  mockFetch(t, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, authOrigin);
    const headers = new Headers(options?.headers);
    assert.ok(![...headers.values()].some(value => value.includes(storageKey)));
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('apikey'), publicKey);
      assert.equal(headers.get('authorization'), `Bearer ${token}`);
    } else {
      assert.equal(url.pathname, `/auth/v1/admin/users/${userId}`);
      assert.equal(headers.get('authorization'), `Bearer ${authKey}`);
    }
    calls.push(url.pathname);
    return Response.json({ id: userId, aud: 'authenticated', role: 'authenticated', is_anonymous: false,
      email: 'fixture@example.test', email_confirmed_at: confirmed, created_at: confirmed, app_metadata: {}, user_metadata: {},
    });
  });
  assert.equal((await verifyAuthServerToken(token, config)).sub, userId);
  assert.equal(await verifiedEmailResolver(config)(userId), 'fixture@example.test');
  assert.deepEqual(calls, ['/auth/v1/user', `/auth/v1/admin/users/${userId}`]);
});

test('production split Storage does not require an Auth admin key while disabled email remains unable to borrow one', async t => {
  const requests = mockFetch(t);
  const env = { ...environment, SUPABASE_SERVICE_ROLE_KEY: '' };
  const config = loadConfig(env);
  assert.equal(config.supabaseServiceKey, '');
  assert.equal(config.emailEnabled, false);
  assert.equal(resolveStorageConfig(env).key, storageKey);
  assert.throws(() => loadConfig({ ...env, APPSCREEN_EMAIL_ENABLED: 'true',
    APPSCREEN_EMAIL_FROM: 'notifications@example.test', RESEND_API_KEY: 'synthetic-resend-key',
    RESEND_WEBHOOK_SECRET: 'synthetic-resend-webhook-secret',
  }), /Email delivery requires/);
  assert.equal(await verifiedEmailResolver(config)(userId), null);
  assert.equal(requests.mock.callCount(), 0);
});

test('private-bucket verification rejects a public shared bucket without changing its policy', async t => {
  const requests = mockFetch(t, async (_input, options) => {
    assert.equal(options?.method, 'GET');
    return Response.json({ ...bucket, public: true });
  });
  await assert.rejects(verifyConfiguredStorage({ env: environment, create: true }), /must be private/);
  assert.equal(requests.mock.callCount(), 1);
});

test('legacy runtime and verifier keep using the original Supabase endpoint and administrator key', async t => {
  const requests = mockFetch(t, async (input, options) => {
    assert.equal(new URL(String(input)).origin, authOrigin);
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${authKey}`);
    return String(input).includes('/bucket/') ? Response.json(bucket) : new Response('legacy-file');
  });
  const env = legacyEnvironment();
  assert.equal((await createStorage(loadConfig(env)).read('legacy.png')).toString(), 'legacy-file');
  await verifyConfiguredStorage({ env });
  assert.equal(requests.mock.callCount(), 2);
  const local = { ...env, NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_AUTH_VERIFICATION: 'jwks' };
  assert.deepEqual(resolveStorageConfig(local), { url: local.SUPABASE_URL, key: authKey });
});

test('legacy HTTPS gateway paths and URL formatting remain compatible with runtime and startup storage', async t => {
  let expectedPrefix = '';
  const requests = mockFetch(t, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, authOrigin);
    assert.ok(url.pathname.startsWith(`${expectedPrefix}/storage/v1/`));
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('apikey'), authKey);
    return url.pathname.includes('/bucket/') ? Response.json(bucket) : new Response('legacy-file');
  });
  const urls = [`${authOrigin}/`, 'https://APPSCREEN-AUTH.example.test:443', `${authOrigin}/gateway`, `${authOrigin}/gateway/`];
  for (const url of urls) {
    // auth-server mode has always required an exact origin; JWKS can use a proxy path.
    const env = { ...legacyEnvironment(), SUPABASE_URL: url, SUPABASE_AUTH_VERIFICATION: 'jwks' };
    expectedPrefix = new URL(url).pathname.replace(/\/$/, '');
    assert.deepEqual(resolveStorageConfig(env), { url, key: authKey });
    assert.equal((await createStorage(loadConfig(env)).read('legacy.png')).toString(), 'legacy-file');
    await verifyConfiguredStorage({ env });
  }
  assert.equal(requests.mock.callCount(), urls.length * 2);
});

test('legacy production storage rejects unsafe endpoints before networking', async t => {
  const requests = mockFetch(t);
  for (const url of ['not-a-url', 'http://localhost:54321', `${authOrigin}?private-marker`, `${authOrigin}#private-marker`,
    'https://user:private-marker@appscreen-auth.example.test', ` ${authOrigin}`]) {
    const env = { ...legacyEnvironment(), SUPABASE_URL: url, SUPABASE_AUTH_VERIFICATION: 'jwks' };
    assert.throws(() => loadConfig(env), assertPrivateError);
    await assert.rejects(verifyConfiguredStorage({ env }), assertPrivateError);
  }
  assert.equal(requests.mock.callCount(), 0);
});

test('storage request failures stay private in both runtime access and startup verification', async t => {
  const requests = mockFetch(t, async (_input, options) => {
    assert.equal(options?.redirect, 'error');
    throw new TypeError(`private-marker ${storageKey}`);
  });
  const storage = createStorage(loadConfig(environment));
  await assert.rejects(storage.put('fixture.png', Buffer.from('synthetic-image'), 'image/png'), assertPrivateError);
  await assert.rejects(storage.read('fixture.png'), assertPrivateError);
  await assert.rejects(storage.remove('fixture.png'), assertPrivateError);
  await assert.rejects(verifyConfiguredStorage({ env: environment }), assertPrivateError);
  assert.equal(requests.mock.callCount(), 4);
});

test('development without Storage credentials still writes local files, while production cannot fall back to them', async t => {
  const requests = mockFetch(t);
  const directory = await mkdtemp(join(tmpdir(), 'appscreen-storage-separation-'));
  t.after(() => rmdir(directory));
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true',
    DATABASE_URL: environment.DATABASE_URL, APPSCREEN_SIGNING_SECRET: environment.APPSCREEN_SIGNING_SECRET,
    APPSCREEN_STORAGE_PATH: directory,
  });
  const storage = createStorage(config);
  await storage.put('fixture.png', Buffer.from('local-file'), 'image/png');
  assert.equal((await storage.read('fixture.png')).toString(), 'local-file');
  await storage.remove('fixture.png');
  await storage.remove('fixture.png');
  await assert.rejects(storage.read('../outside.png'), /Invalid file reference/);
  assert.throws(() => createStorage({ ...config, production: true }), /complete Supabase URL/);
  assert.throws(() => loadConfig({ ...legacyEnvironment(), SUPABASE_SERVICE_ROLE_KEY: '' }), /complete Supabase URL/);
  assert.equal(requests.mock.callCount(), 0);
});

test('public configuration exposes only the independent Auth public settings, never either admin key or Storage config', async t => {
  const requests = mockFetch(t);
  const db = { query: async () => { throw new Error('No database access allowed.'); } } as unknown as DB;
  const { app } = await createApp(loadConfig(environment), db);
  t.after(() => app.close());
  const response = await app.inject('/api/config');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().auth, { provider: 'supabase', url: authOrigin, publishableKey: publicKey });
  for (const secret of [authKey, storageKey, storageOrigin, environment.APPSCREEN_SIGNING_SECRET!]) {
    assert.equal(response.body.includes(secret), false);
  }
  for (const path of ['/deploy/storage-config.mjs', '/server/config.ts', '/server/storage.ts']) {
    assert.equal((await app.inject(path)).statusCode, 404);
  }
  assert.equal(requests.mock.callCount(), 0);
});
