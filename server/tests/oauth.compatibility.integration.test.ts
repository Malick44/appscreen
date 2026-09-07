import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { OAuthConnections } from '../oauth.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('OAuth compatibility: explicit reconnect and version-fenced provider handoffs', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/);
  const db = createDatabase(databaseUrl!); await migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, SUPABASE_URL: 'https://isolated-auth.example.test', SUPABASE_PUBLISHABLE_KEY: 'isolated-public-test', APPSCREEN_MCP_OAUTH: 'true', APP_BASE_URL: 'http://127.0.0.1:8001', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: await mkdtemp(join(tmpdir(), 'appscreen-oauth-compatibility-')) });
  const { app, auth, services } = await createApp(config, db); await app.ready();
  t.after(async () => { await app.close(); await db.end(); });
  const userId = randomUUID(), workspaceId = await auth.ensureWorkspace(userId, 'compatibility@example.test');
  const owner = await auth.resolveContext(userId, 'compatibility@example.test', workspaceId, 'web', ['projects:read', 'projects:write', 'assets:write', 'exports:write', 'ai:run']);
  const strangerId = randomUUID(), strangerWorkspace = await auth.ensureWorkspace(strangerId, 'stranger@example.test');
  const stranger = await auth.resolveContext(strangerId, 'stranger@example.test', strangerWorkspace, 'web', ['projects:read']);
  const requests = new Map<string, any>(), deletions: string[] = [];
  let failDeletion = false;
  let deleteGate: { entered: () => void; untilReleased: Promise<void> } | undefined;
  // This fixture exercises the adapter contract, not a live provider's PKCE or Auth API.
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/auth/v1/user/oauth/grants') {
      assert.equal(init?.method, 'DELETE');
      assert.deepEqual([...url.searchParams.keys()], ['client_id']);
      deletions.push(url.searchParams.get('client_id')!);
      if (deleteGate) { const gate = deleteGate; gate.entered(); await gate.untilReleased; }
      return new Response(null, { status: failDeletion ? 503 : 204 });
    }
    const match = url.pathname.match(/^\/auth\/v1\/oauth\/authorizations\/([a-zA-Z0-9_-]+)(\/consent)?$/);
    assert.ok(match, `Unexpected provider request: ${url.pathname}`);
    const details = requests.get(match[1]); assert.ok(details);
    if (!match[2]) return Response.json(details);
    assert.equal(init?.method, 'POST');
    const action = JSON.parse(String(init?.body)).action;
    return Response.json({ redirect_url: details.redirect_uri + (action === 'approve' ? '?code=fixture-code&state=fixture-state' : '?error=access_denied&state=fixture-state') });
  };
  const oauth = new OAuthConnections(services, fetcher), token = 'not-a-real-provider-token';
  const freshRequest = (clientId = randomUUID(), extra: any = {}) => {
    const id = `request_${randomUUID()}`;
    requests.set(id, { authorization_id: id, redirect_uri: 'http://127.0.0.1:4567/callback', client: { id: clientId, name: 'Fixture agent' }, user: { id: userId }, scope: 'openid', ...extra });
    return id;
  };
  const reusedRequest = () => {
    const id = `request_${randomUUID()}`;
    requests.set(id, { redirect_url: 'http://127.0.0.1:4567/callback?code=discard-me&state=fixture-state' });
    return id;
  };
  const readGrant = async (id: string) => (await db.query('SELECT * FROM oauth_grants WHERE id=$1', [id])).rows[0];
  const approve = async (clientId = randomUUID(), scopes = ['projects:read']) => {
    const id = freshRequest(clientId), details = await oauth.details(owner, token, id);
    assert.ok('consentNonce' in details);
    await oauth.consent(owner, token, id, { consentNonce: details.consentNonce, action: 'approve', scopes, days: 30 });
    return (await db.query('SELECT * FROM oauth_grants WHERE user_id=$1 AND client_id=$2', [userId, clientId])).rows[0];
  };
  const assertCode = (code: string) => (error: any) => error.code === code;

  await t.test('valid DCR clients may omit their name or supply an empty name', async () => {
    for (const client of [{ id: randomUUID() }, { id: randomUUID(), name: '   ' }]) {
      const id = freshRequest(client.id, { client }), details = await oauth.details(owner, token, id);
      assert.ok('client' in details && details.client); assert.equal(details.client.name, 'Unnamed client');
      assert.equal((await db.query('SELECT client_name FROM oauth_authorization_requests WHERE id=$1', [id])).rows[0].client_name, 'Unnamed client');
    }
  });

  await t.test('reused provider consent preserves a live grant without leaking its callback or renewing access', async () => {
    const grant = await approve(), beforeDeletes = deletions.length, id = reusedRequest();
    const result = await oauth.details(owner, token, id);
    assert.ok('reconnectRequired' in result); assert.equal(result.reconnectRequired, true);
    assert.equal(result.reason, 'UPSTREAM_CONSENT_REUSED'); assert.equal('redirectUrl' in result, false);
    assert.equal(JSON.stringify(result).includes('discard-me'), false);
    const connection = result.connections.find(item => item.id === grant.id)!;
    assert.equal(connection.version, grant.version); assert.deepEqual(connection.scopes, grant.scopes);
    assert.equal(connection.revokedAt, null); assert.deepEqual(await readGrant(grant.id), grant);
    assert.equal(deletions.length, beforeDeletes);
    assert.equal((await db.query('SELECT id FROM oauth_authorization_requests WHERE id=$1', [id])).rowCount, 0);
    const hook = (await db.query('SELECT public.appscreen_access_token_hook($1::jsonb) AS value', [{ user_id: userId, claims: { sub: userId, aud: 'authenticated', client_id: grant.client_id } }])).rows[0].value;
    assert.equal(hook.claims.appscreen_grant_id, grant.id);
  });

  await t.test('reused consent never resurrects expired or revoked local grants', async () => {
    for (const state of ['expired', 'revoked']) {
      const grant = await approve();
      await db.query(state === 'expired' ? "UPDATE oauth_grants SET expires_at=now()-interval '1 minute' WHERE id=$1" : 'UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [grant.id]);
      const before = await readGrant(grant.id), result = await oauth.details(owner, token, reusedRequest());
      assert.ok('reconnectRequired' in result); assert.equal('redirectUrl' in result, false);
      assert.deepEqual(await readGrant(grant.id), before);
      const hook = (await db.query('SELECT public.appscreen_access_token_hook($1::jsonb) AS value', [{ user_id: userId, claims: { sub: userId, aud: 'authenticated', client_id: grant.client_id } }])).rows[0].value;
      assert.equal(hook.error.http_code, 403);
    }
  });

  await t.test('reset requires explicit confirmation, current version, and the owning browser session', async () => {
    const grant = await approve(), unrelated = await approve(), beforeDeletes = deletions.length;
    await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect', scopes: ['ai:run'] }));
    await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version }));
    await assert.rejects(oauth.prepareReconnect({ ...owner, authKind: 'mcp' }, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' }), assertCode('BROWSER_SESSION_REQUIRED'));
    await assert.rejects(oauth.prepareReconnect(stranger, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' }), assertCode('CONNECTION_NOT_FOUND'));
    await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version + 1, confirmation: 'reconnect' }), assertCode('OAUTH_CONNECTION_CHANGED'));
    assert.equal(deletions.length, beforeDeletes);
    const result = await oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' });
    assert.equal(result.reconnectReady, true); assert.equal(result.restartRequired, true); assert.equal(result.version, grant.version + 1);
    assert.deepEqual(deletions.slice(beforeDeletes), [grant.client_id]);
    const reset = await readGrant(grant.id); assert.ok(reset.revoked_at);
    assert.deepEqual(reset.scopes, grant.scopes); assert.deepEqual(reset.expires_at, grant.expires_at);
    assert.deepEqual(await readGrant(unrelated.id), unrelated);
  });

  await t.test('provider failure leaves access revoked, and retry must finish before fresh approval', async () => {
    const grant = await approve(); failDeletion = true;
    const first = await oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' });
    assert.equal(first.upstreamRevocationPending, true); assert.equal(first.reconnectReady, false); assert.equal(first.restartRequired, false);
    const pending = await readGrant(grant.id); assert.ok(pending.revoked_at);
    assert.deepEqual(pending.scopes, grant.scopes); assert.deepEqual(pending.expires_at, grant.expires_at);
    const requestId = freshRequest(grant.client_id), details = await oauth.details(owner, token, requestId);
    assert.ok('consentNonce' in details);
    const consent = { consentNonce: details.consentNonce, action: 'approve', scopes: ['projects:read', 'exports:write'], days: 2 };
    await assert.rejects(oauth.consent(owner, token, requestId, consent), assertCode('OAUTH_RECONNECT_PENDING'));
    failDeletion = false;
    const beforeDeletes = deletions.length;
    await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' }), assertCode('OAUTH_CONNECTION_CHANGED'));
    assert.equal(deletions.length, beforeDeletes);
    const retry = await oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: first.version, confirmation: 'reconnect' });
    assert.equal(retry.upstreamRevocationPending, false); assert.equal(retry.reconnectReady, true);
    // Reset alone grants nothing; a new, explicit permission decision is needed.
    assert.ok((await readGrant(grant.id)).revoked_at);
    await oauth.consent(owner, token, requestId, consent);
    const renewed = await readGrant(grant.id);
    assert.equal(renewed.revoked_at, null); assert.equal(renewed.version, retry.version + 1);
    assert.deepEqual(renewed.scopes, ['exports:write', 'projects:read']);
  });

  await t.test('a delayed native revocation cannot race a new approval or revoke its newer version', async () => {
    const grant = await approve(), requestId = freshRequest(grant.client_id);
    const details = await oauth.details(owner, token, requestId); assert.ok('consentNonce' in details);
    const consent = { consentNonce: details.consentNonce, action: 'approve', scopes: ['projects:read'], days: 1 };
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    deleteGate = { entered, untilReleased: new Promise<void>(resolve => { release = resolve; }) };
    const inFlight = oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' });
    try {
      await started;
      assert.ok((await readGrant(grant.id)).revoked_at, 'Local revocation must commit before waiting for the provider');
      await assert.rejects(oauth.consent(owner, token, requestId, consent), assertCode('OAUTH_CONNECTION_BUSY'));
      await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: grant.version, confirmation: 'reconnect' }), assertCode('OAUTH_CONNECTION_BUSY'));
      await approve(); // A different client is not blocked by this connection's handoff.
    } finally { deleteGate = undefined; release(); }
    const reset = await inFlight;
    await oauth.consent(owner, token, requestId, consent);
    const renewed = await readGrant(grant.id), beforeDeletes = deletions.length;
    assert.equal(renewed.version, reset.version + 1); assert.equal(renewed.revoked_at, null);
    await assert.rejects(oauth.prepareReconnect(owner, token, grant.id, { expectedVersion: reset.version, confirmation: 'reconnect' }), assertCode('OAUTH_CONNECTION_CHANGED'));
    assert.equal(deletions.length, beforeDeletes); assert.deepEqual(await readGrant(grant.id), renewed);
  });
});
