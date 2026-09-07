import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { type Context } from '../auth.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('OAuth review: previously issued capabilities follow connection revocation', { skip: !databaseUrl, timeout: 30_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/);
  const db = createDatabase(databaseUrl!); await migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, SUPABASE_URL: 'https://isolated-auth.example.test', SUPABASE_PUBLISHABLE_KEY: 'isolated-public-test', APPSCREEN_MCP_OAUTH: 'true', APP_BASE_URL: 'http://127.0.0.1:8001', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: await mkdtemp(join(tmpdir(), 'appscreen-oauth-review-')) });
  const { app, auth, services } = await createApp(config, db); await app.ready();
  t.after(async () => { await app.close(); await db.end(); });
  const userId = randomUUID(), workspaceId = await auth.ensureWorkspace(userId, 'review@example.test');
  const owner = await auth.resolveContext(userId, 'review@example.test', workspaceId, 'web', ['projects:read', 'projects:write', 'assets:write']);
  const { project } = await services.createProject(owner, { name: 'OAuth capability review' });
  const bytes = await sharp({ create: { width: 32, height: 64, channels: 3, background: '#224466' } }).png().toBuffer();

  async function grant(): Promise<Context> {
    const id = randomUUID();
    await db.query("INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,client_name,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'Isolated review',$5,$6,now()+interval '1 hour')", [id, workspaceId, userId, randomUUID(), ['projects:read', 'assets:write'], config.mcpResource]);
    return { ...owner, authKind: 'mcp', scopes: ['projects:read', 'assets:write'], connection: { kind: 'oauth', id, version: 1 } };
  }
  const revoke = (ctx: Context) => db.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [ctx.connection!.id]);

  await t.test('revocation invalidates a context retained by an open event stream', async () => {
    const ctx = await grant(); await services.assertMembership(ctx);
    await revoke(ctx);
    await assert.rejects(services.assertMembership(ctx), (error: any) => ['OAUTH_GRANT_REVOKED', 'TOKEN_INVALID', 'CONNECTION_REVOKED', 'WORKSPACE_FORBIDDEN'].includes(error.code));
  });

  await t.test('a revoked OAuth connection cannot finish its pre-issued upload ticket', async () => {
    const ctx = await grant();
    const ticket = await services.requestAssetUpload(ctx, { projectId: project.id, name: 'revoked-upload.png', mimeType: 'image/png', byteLength: bytes.length, idempotencyKey: randomUUID() });
    await revoke(ctx);
    const url = new URL(ticket.uploadUrl);
    const result = await app.inject({ method: 'POST', url: url.pathname + url.search, headers: { 'content-type': 'image/png' }, payload: bytes });
    assert.ok([401, 403].includes(result.statusCode), `Revoked upload must be refused; received ${result.statusCode}`);
    assert.equal((await db.query('SELECT id FROM assets WHERE id=$1', [ticket.assetId])).rowCount, 0);
  });

  await t.test('a changed grant version also invalidates retained context and old upload tickets', async () => {
    const ctx = await grant();
    const ticket = await services.requestAssetUpload(ctx, { projectId: project.id, name: 'old-version.png', mimeType: 'image/png', byteLength: bytes.length, idempotencyKey: randomUUID() });
    await db.query('UPDATE oauth_grants SET version=version+1,scopes=$1 WHERE id=$2', [['projects:read'], ctx.connection!.id]);
    await assert.rejects(services.assertMembership(ctx));
    const url = new URL(ticket.uploadUrl);
    const result = await app.inject({ method: 'POST', url: url.pathname + url.search, headers: { 'content-type': 'image/png' }, payload: bytes });
    assert.ok([401, 403].includes(result.statusCode), `Old-version upload must be refused; received ${result.statusCode}`);
  });
});
