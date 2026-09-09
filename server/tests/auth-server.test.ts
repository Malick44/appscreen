import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { loadConfig } from '../config.js';
import { createAuth } from '../auth.js';
import { verifyAuthServerToken } from '../auth-server.js';
import { AppError } from '../errors.js';

// Offline fixtures only; no dotenv, real identities, database, or provider keys.
const origin = 'https://identity.example.test';
const issuer = `${origin}/auth/v1`;
const userId = '880e5cc9-6919-4560-a6f0-8eb3bcfd3336';
const workspaceId = 'fd3a6c3c-18be-4b20-a7b2-9d5c72052dcf';
const publicKey = 'synthetic-public-api-key';
const serviceKey = 'synthetic-service-key-never-transmitted';
const signingKey = new TextEncoder().encode('fixture-HS256-secret-known-only-to-the-mock-auth-provider');
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', APP_BASE_URL: 'https://appscreen.example.test',
  DATABASE_URL: 'postgresql://unused/unused_auth_server_test',
  APPSCREEN_SIGNING_SECRET: 'synthetic-application-signing-secret-'.repeat(3),
  SUPABASE_URL: origin, SUPABASE_PUBLISHABLE_KEY: publicKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey, SUPABASE_AUTH_VERIFICATION: 'auth-server',
};
const config = loadConfig(env);
const user = (extra: Record<string, unknown> = {}) => ({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'trusted-current@example.test', is_anonymous: false, ...extra });
async function sign(overrides: JWTPayload = {}, key = signingKey) {
  return new SignJWT({ iss: issuer, aud: 'authenticated', sub: userId,
    exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 1,
    role: 'authenticated', email: 'stale-token-email@example.test', is_anonymous: false, ...overrides,
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key);
}
function safeError(error: unknown) {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'AUTH_INVALID');
  assert.equal(error.statusCode, 401);
  assert.equal(error.message, 'Your session expired. Sign in again.');
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /synthetic-service-key|stale-token-email|trusted-current|secret-provider-detail/);
  return true;
}
function mockFetch(t: TestContext, implementation: typeof fetch) {
  const stub = t.mock.method(globalThis, 'fetch', implementation);
  t.after(() => stub.mock.restore());
  return stub;
}
const provider: typeof fetch = async (url, options) => {
  assert.equal(String(url), `${issuer}/user`);
  assert.equal(options?.method, 'GET');
  assert.equal(options?.redirect, 'error');
  assert.equal(options?.credentials, 'omit');
  assert.ok(options.signal instanceof AbortSignal);
  const headers = new Headers(options.headers);
  assert.equal(headers.get('apikey'), publicKey);
  assert.equal(headers.get('cookie'), null);
  assert.equal([...headers.values()].some(value => value.includes(serviceKey)), false);
  try {
    await jwtVerify(headers.get('authorization')!.slice(7), signingKey, { issuer, audience: 'authenticated', algorithms: ['HS256'] });
    return Response.json(user());
  } catch { return Response.json({ error: 'secret-provider-detail' }, { status: 401 }); }
};

test('verification defaults to JWKS and rejects unknown modes or auth-server MCP OAuth', () => {
  const defaults = { ...env }; delete defaults.SUPABASE_AUTH_VERIFICATION;
  assert.equal(loadConfig(defaults).supabaseAuthVerification, 'jwks');
  assert.equal(config.supabaseAuthVerification, 'auth-server');
  for (const value of ['', 'auto', 'JWKS', 'AUTH-SERVER', 'auth-server ']) assert.throws(() => loadConfig({ ...env, SUPABASE_AUTH_VERIFICATION: value }), /SUPABASE_AUTH_VERIFICATION/);
  assert.throws(() => loadConfig({ ...env, APPSCREEN_MCP_OAUTH: 'true' }), /MCP OAuth requires JWKS/);
  assert.equal(loadConfig({ ...env, SUPABASE_AUTH_VERIFICATION: 'jwks', APPSCREEN_MCP_OAUTH: 'true' }).mcpOAuthEnabled, true);
  for (const url of ['', 'http://identity.example.test', `${origin}/`, `${origin}/path`, `${origin}?secret=hidden`, `${origin}#fragment`, 'https://user:hidden@identity.example.test']) {
    assert.throws(() => loadConfig({ ...env, SUPABASE_URL: url }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /canonical HTTPS origin/);
      assert.equal(error.message.includes('hidden'), false);
      return true;
    });
  }
});

test('HS256 is authenticated upstream using only the public key and exact bearer', async () => {
  const token = await sign({ aal: 'aal2' });
  let calls = 0;
  const result = await verifyAuthServerToken(token, config, { fetcher: async (url, options) => {
    calls++;
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    return provider(url, options);
  } });
  assert.equal(calls, 1);
  assert.equal(result.sub, userId);
  assert.equal(result.email, 'trusted-current@example.test');
  assert.equal(result.aal, 'aal2');
});

test('wrong signatures and provider rejection never authenticate a decoded token', async () => {
  const forged = await sign({}, new TextEncoder().encode('a-different-fixture-signing-key-not-trusted-by-provider'));
  await assert.rejects(verifyAuthServerToken(forged, config, { fetcher: provider }), safeError);
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(verifyAuthServerToken(await sign(), config, { fetcher: async () => Response.json({ error: 'secret-provider-detail' }, { status }) }), safeError);
  }
});

test('malformed, expired, wrong-issuer/audience, anonymous and OAuth claims fail before network', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('Network must not be used'); };
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload[] = [
    { iss: 'supabase' }, { iss: `${issuer}/` }, { iss: 'https://other.example/auth/v1' }, { iss: undefined },
    { aud: 'anon' }, { aud: ['authenticated'] }, { aud: 'https://appscreen.example.test/mcp' }, { aud: undefined },
    { sub: undefined }, { sub: '' }, { sub: 'not-a-user-id' },
    { exp: undefined }, { exp: now }, { exp: now - 60 }, { exp: 'later' as any }, { exp: now + 0.5 },
    { nbf: now + 60 }, { nbf: 'yesterday' as any }, { nbf: null as any },
    { role: 'service_role' }, { role: 'anon' }, { role: undefined },
    { is_anonymous: true }, { is_anonymous: 'false' },
    { client_id: 'oauth-client' }, { client_id: '' }, { client_id: null },
  ];
  for (const overrides of claims) await assert.rejects(verifyAuthServerToken(await sign(overrides), config, { fetcher }), safeError);
  for (const token of ['', 'malformed', 'a.b.c', (await sign()).slice(0, -30), 'x'.repeat(16_385)]) await assert.rejects(verifyAuthServerToken(token, config, { fetcher }), safeError);
  assert.equal(calls, 0);
});

test('auth-server only admits HS256, never none, asymmetric algorithms, or critical extensions', async () => {
  const token = await sign();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(user()); };
  for (const header of [{ alg: 'none' }, { alg: 'RS256' }, { alg: 'HS384' }, { alg: 'HS512' }, { alg: 'HS256', crit: ['unknown'] }, { alg: 'HS256', b64: false }]) {
    const changed = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${token.split('.').slice(1).join('.')}`;
    await assert.rejects(verifyAuthServerToken(changed, config, { fetcher }), safeError);
  }
  assert.equal(calls, 0);
});

test('trusted Auth user identity must match and remain an active non-anonymous browser user', async () => {
  const token = await sign();
  for (const value of [
    null, {}, [], { user: user() },
    user({ id: workspaceId }), user({ id: undefined }),
    user({ aud: 'anon' }), user({ role: 'service_role' }),
    user({ is_anonymous: true }), user({ is_anonymous: 'false' }),
    user({ deleted_at: new Date().toISOString() }),
    user({ banned_until: new Date(Date.now() + 60_000).toISOString() }), user({ banned_until: 'invalid' }),
    user({ email: { address: 'untrusted@example.test' } }), user({ email: 'unsafe\nemail@example.test' }),
  ]) await assert.rejects(verifyAuthServerToken(token, config, { fetcher: async () => Response.json(value) }), safeError);
  const result = await verifyAuthServerToken(token, config, { fetcher: async () => Response.json(user({ email: undefined })) });
  assert.equal(result.email, '', 'Do not fall back to a stale email claim');
});

test('rejects redirects, non-JSON, malformed JSON and oversized Auth responses without exposing them', async () => {
  const token = await sign();
  for (const response of [
    new Response('secret-provider-detail', { status: 302, headers: { Location: 'https://untrusted.example' } }),
    new Response('<html>secret-provider-detail</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('invalid secret-provider-detail', { headers: { 'Content-Type': 'application/json' } }),
    Response.json(user({ extra: 'x'.repeat(64 * 1024) })),
  ]) await assert.rejects(verifyAuthServerToken(token, config, { fetcher: async () => response }), safeError);
});

test('Auth outage and header/body stalls are bounded, fail closed, and never retry', async () => {
  const token = await sign();
  let calls = 0;
  await assert.rejects(verifyAuthServerToken(token, config, { fetcher: async () => { calls++; throw new Error('secret-provider-detail'); } }), safeError);
  assert.equal(calls, 1);
  for (const phase of ['headers', 'body']) {
    let aborted = false;
    const fetcher: typeof fetch = async (_url, options) => {
      const signal = options!.signal!;
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret-provider-detail')); }, { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('secret-provider-detail')); }, { once: true });
      } }), { headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(verifyAuthServerToken(token, config, { fetcher, timeoutMs: 20 }), safeError);
    assert.equal(aborted, true);
  }
});

test('a token that expires during upstream verification is not admitted', async t => {
  let milliseconds = Date.now();
  const now = t.mock.method(Date, 'now', () => milliseconds);
  t.after(() => now.mock.restore());
  const token = await sign({ exp: Math.floor(milliseconds / 1000) + 1 });
  await assert.rejects(verifyAuthServerToken(token, config, { fetcher: async () => {
    milliseconds += 2000;
    return Response.json(user());
  } }), safeError);
});

test('requires a fixed HTTPS origin/public key and does not use service credentials', async () => {
  const token = await sign();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(user()); };
  for (const url of ['http://identity.example.test', `${origin}/`, `${origin}/other`, `${origin}?token=secret`, 'https://user:secret@identity.example.test']) {
    await assert.rejects(verifyAuthServerToken(token, { ...config, supabaseUrl: url }, { fetcher }), safeError);
  }
  const privileged = await new SignJWT({ role: 'service_role' }).setProtectedHeader({ alg: 'HS256' }).sign(signingKey);
  for (const key of ['', 'sb_secret_fixture', privileged]) await assert.rejects(verifyAuthServerToken(token, { ...config, supabasePublishableKey: key }, { fetcher }), safeError);
  await assert.rejects(verifyAuthServerToken(token, { ...config, mcpOAuthEnabled: true }, { fetcher }), safeError);
  assert.equal(calls, 0);
  const anon = await new SignJWT({ role: 'anon' }).setProtectedHeader({ alg: 'HS256' }).sign(signingKey);
  assert.equal((await verifyAuthServerToken(token, { ...config, supabasePublishableKey: anon }, { fetcher })).sub, userId);
});

function databaseFixture() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT workspace_id')) return { rowCount: 1, rows: [{ workspace_id: workspaceId, role: 'owner', email: 'membership-email@example.test' }] };
    return { rowCount: 0, rows: [] };
  };
  return { calls, db: { query, connect: async () => ({ query, release() {} }) } as unknown as DB };
}
function request(token: string) { return { headers: { authorization: `Bearer ${token}` } } as FastifyRequest; }

test('createAuth uses opt-in upstream verification before touching workspace data', async t => {
  const stub = mockFetch(t, provider);
  const { db, calls } = databaseFixture();
  const auth = createAuth(db, config);
  await assert.rejects(auth.authenticate(request(await sign({ aud: 'wrong-audience' }))), safeError);
  assert.equal(stub.mock.callCount(), 0);
  assert.equal(calls.length, 0);
  await assert.rejects(auth.authenticate(request(await sign({}, new TextEncoder().encode('a-wrong-fixture-secret-that-provider-does-not-accept')))), safeError);
  assert.equal(stub.mock.callCount(), 1);
  assert.equal(calls.length, 0, 'Provider rejection must precede all database work');
  const result = await auth.authenticate(request(await sign()));
  assert.equal(result.userId, userId);
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.authKind, 'web');
  assert.equal(result.email, 'trusted-current@example.test');
  assert.equal(stub.mock.callCount(), 2);
  assert.ok(calls.length > 0);
});

test('existing scoped AppScreen tokens bypass browser compatibility verification unchanged', async t => {
  const stub = mockFetch(t, async () => { throw new Error('Scoped tokens never contact Supabase Auth'); });
  const tokenId = '23ff38fc-261a-4d1a-b2b9-caa93f0273b8';
  const scopes = ['projects:read', 'exports:write'];
  const { db } = databaseFixture();
  const baseQuery = db.query.bind(db);
  db.query = (async (sql: string, values?: unknown[]) => sql.startsWith('SELECT * FROM api_tokens')
    ? { rowCount: 1, rows: [{ id: tokenId, user_id: userId, workspace_id: workspaceId, scopes }] }
    : baseQuery(sql, values)) as typeof db.query;
  const context = await createAuth(db, config).authenticate(request('ask_synthetic-existing-token'));
  assert.equal(context.authKind, 'mcp');
  assert.deepEqual(context.scopes, scopes);
  assert.deepEqual(context.connection, { kind: 'token', id: tokenId });
  assert.equal(stub.mock.callCount(), 0);
});

test('default JWKS never falls back to the Auth server for rejected HS256 sessions', async t => {
  const urls: string[] = [];
  mockFetch(t, async url => { urls.push(String(url)); return Response.json({ keys: [] }); });
  const { db, calls } = databaseFixture();
  const defaults = { ...env }; delete defaults.SUPABASE_AUTH_VERIFICATION;
  await assert.rejects(createAuth(db, loadConfig(defaults)).authenticate(request(await sign())), safeError);
  assert.ok(urls.every(url => url === `${issuer}/.well-known/jwks.json`));
  assert.equal(urls.some(url => url.endsWith('/user')), false);
  assert.equal(calls.length, 0);
});

test('existing asymmetric JWKS browser sessions still authenticate without Auth-server calls', async t => {
  const { publicKey: publicJwk, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicJwk), kid: 'offline-jwks-fixture', alg: 'RS256' };
  const urls: string[] = [];
  mockFetch(t, async url => { urls.push(String(url)); return Response.json({ keys: [jwk] }); });
  const token = await new SignJWT({ email: 'jwks-email@example.test', is_anonymous: false }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience('authenticated').setSubject(userId).setExpirationTime('5m').sign(privateKey);
  const { db } = databaseFixture();
  const result = await createAuth(db, loadConfig({ ...env, SUPABASE_AUTH_VERIFICATION: 'jwks' })).authenticate(request(token));
  assert.equal(result.email, 'jwks-email@example.test');
  assert.deepEqual(urls, [`${issuer}/.well-known/jwks.json`]);
});
