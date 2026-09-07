import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createApp } from '../app.js';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('database-backed SaaS service and API security integration', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  const url = new URL(databaseUrl!);
  assert.match(url.pathname, /(?:^|[_/-])test(?:[_/-]|$)/, 'TEST_DATABASE_URL must name a dedicated test database; production/local customer data are not used');
  const db = createDatabase(databaseUrl!);
  const storage = await mkdtemp(join(tmpdir(), 'appscreen-service-test-'));
  // Credentials below exist only in this isolated process. No real AI, billing or cloud storage is configured.
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!, APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APP_BASE_URL: 'http://localhost', APPSCREEN_STORAGE_PATH: storage, APPSCREEN_ENABLE_AI: 'false', TRIAL_CREDITS: '25' });
  let application: Awaited<ReturnType<typeof createApp>>;
  t.after(async () => { await application?.app.close(); await db.end(); });
  await migrate(db);
  application = await createApp(config, db);
  const { app, auth, services } = application;
  await app.ready();
  const run = randomUUID();
  const request = (method: 'GET'|'POST'|'DELETE', path: string, token?: string, payload?: any, extraHeaders: Record<string,string> = {}) => app.inject({ method, url: path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, ...(payload === undefined ? {} : { payload }) });
  const checked = async (method: 'GET'|'POST'|'DELETE', path: string, token?: string, payload?: any) => { const response = await request(method, path, token, payload); assert.equal(response.statusCode, 200, `${method} ${path}: ${response.body}`); return response.json(); };
  const login = async (label: string) => { const email = `${label}-${run}@integration.appscreen.test`; const { token } = await checked('POST', '/api/dev/session', undefined, { email }); const session = await checked('GET', '/api/session', token); return { token, email, session }; };
  const owner = await login('owner'), stranger = await login('stranger');
  const project = (await checked('POST', '/api/projects', owner.token, { name: 'Private campaign under test' })).project;
  const strangerProject = (await checked('POST', '/api/projects', stranger.token, { name: 'Other tenant campaign' })).project;
  const png = await sharp({ create: { width: 660, height: 1434, channels: 4, background: '#527486' } }).png().toBuffer();
  const multipart = (filename: string, bytes: Buffer) => { const boundary = `appscreen-${randomUUID()}`; return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, bytes: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) }; };
  const upload = async (token: string, projectId: string, filename = 'real-capture.png') => { const form = multipart(filename, png); const response = await request('POST', `/api/projects/${projectId}/assets`, token, form.bytes, form.headers); assert.equal(response.statusCode, 200, response.body); return response.json().asset; };
  const asset = await upload(owner.token, project.id), foreignAsset = await upload(stranger.token, strangerProject.id);
  let activeRevision: any;

  await t.test('development sessions create isolated workspaces and issue trial credits once', async () => {
    assert.notEqual(owner.session.workspace.id, stranger.session.workspace.id);
    assert.equal(owner.session.credits.available, 25);
    const again = await checked('POST', '/api/dev/session', undefined, { email: owner.email.toUpperCase() });
    const session = await checked('GET', '/api/session', again.token);
    assert.equal(session.workspace.id, owner.session.workspace.id);
    assert.equal(session.credits.available, 25);
    const grants = await db.query("SELECT count(*)::integer AS count FROM credit_ledger WHERE workspace_id=$1 AND reason='trial'", [session.workspace.id]);
    assert.equal(grants.rows[0].count, 1);
    assert.equal((await request('GET', '/api/projects')).statusCode, 401);
    assert.equal((await request('GET', '/api/projects', 'invalid-session')).statusCode, 401);
  });

  await t.test('cross-workspace reads, writes, uploads and workspace-header spoofing are denied', async () => {
    const own = await checked('GET', '/api/projects', owner.token);
    assert.deepEqual(own.projects.map((item:any) => item.id), [project.id]);
    assert.equal((await request('GET', `/api/projects/${project.id}`, stranger.token)).statusCode, 404);
    assert.equal((await request('GET', `/api/projects/${project.id}`, owner.token, undefined, { 'x-workspace-id': stranger.session.workspace.id })).statusCode, 403);
    const form = multipart('malicious.png', png);
    assert.equal((await request('POST', `/api/projects/${project.id}/assets`, stranger.token, form.bytes, form.headers)).statusCode, 404);
    assert.equal((await request('POST', `/api/projects/${project.id}/upload-ticket`, stranger.token, { filename: 'capture.png' })).statusCode, 404);
  });

  await t.test('uploads validate decoded bytes and private URLs do not expose storage paths', async () => {
    assert.equal(asset.width, 660); assert.equal(asset.height, 1434);
    assert.equal(asset.storageKey, undefined);
    assert.ok(asset.url.includes('/api/media/'));
    const mediaUrl = new URL(asset.url);
    const media = await request('GET', mediaUrl.pathname + mediaUrl.search);
    assert.equal(media.statusCode, 200); assert.equal(media.headers['content-type'], 'image/png');
    assert.deepEqual(media.rawPayload, png);
    assert.match(String(media.headers['cache-control']), /private/);
    const tampered = await request('GET', `/api/media/${foreignAsset.id}${mediaUrl.search}`);
    assert.equal(tampered.statusCode, 403);
    const invalid = multipart('fake.png', Buffer.from('not a real screenshot'));
    const response = await request('POST', `/api/projects/${project.id}/assets`, owner.token, invalid.bytes, invalid.headers);
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'INVALID_IMAGE');
    const count = await db.query('SELECT count(*)::integer AS count FROM assets WHERE project_id=$1', [project.id]);
    assert.equal(count.rows[0].count, 1);
  });

  await t.test('manual drafts accept the MCP string profile and preserve uploaded source identity', async () => {
    const result = await checked('POST', `/api/projects/${project.id}/drafts`, owner.token, { assetIds: [asset.id], profile: 'iphone-6.9', templateId: 'tidal-relay', templateMode: 'exact', screenCount: 3, apply: true });
    activeRevision = result.revision;
    assert.equal(result.project.activeRevisionId, activeRevision.id);
    assert.equal(activeRevision.document.id, project.id);
    assert.deepEqual(activeRevision.document.profile, { id: 'iphone-6.9', width: 1320, height: 2868 });
    assert.equal(activeRevision.document.scenes.length, 3);
    assert.equal(activeRevision.document.sources[0].assetId, asset.id);
    assert.equal(activeRevision.document.deviceGroups.length, 3);
    assert.equal(activeRevision.document.template.mode, 'exact');
    const bad = await request('POST', `/api/projects/${project.id}/drafts`, owner.token, { assetIds: [foreignAsset.id], templateId: 'tidal-relay', profile: 'iphone-6.9' });
    assert.equal(bad.statusCode, 403); assert.equal(bad.json().error.code, 'ASSET_FORBIDDEN');
  });

  await t.test('full-document saves enforce exact geometry and reject foreign assets', async () => {
    const moved = structuredClone(activeRevision.document); moved.deviceGroups[0].geometry.rotation += 10;
    const blocked = await request('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: moved, expectedRevisionId: activeRevision.id, apply: true });
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().error.code, 'LOCKED');
    const stolen = structuredClone(activeRevision.document); stolen.sources[0].assetId = foreignAsset.id;
    const rejected = await request('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: stolen, expectedRevisionId: activeRevision.id, apply: true });
    assert.equal(rejected.statusCode, 403); assert.equal(rejected.json().error.code, 'ASSET_FORBIDDEN');
    const rawUrl = structuredClone(activeRevision.document); rawUrl.scenes[0].background.imageSrc = 'https://example.invalid/private.png';
    assert.equal((await request('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: rawUrl, expectedRevisionId: activeRevision.id, apply: true })).statusCode, 400);
    const unchanged = await checked('GET', `/api/projects/${project.id}`, owner.token);
    assert.equal(unchanged.project.activeRevisionId, activeRevision.id);
  });

  await t.test('draft application uses optimistic concurrency and does not overwrite newer copy', async () => {
    const base = activeRevision;
    const draftDocument = structuredClone(base.document); draftDocument.scenes[0].text.headlines.en = 'Draft headline';
    const draft = (await checked('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: draftDocument, expectedRevisionId: base.id, apply: false })).revision;
    const manualDocument = structuredClone(base.document); manualDocument.scenes[0].text.headlines.en = 'Latest manual headline';
    activeRevision = (await checked('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: manualDocument, expectedRevisionId: base.id, apply: true })).revision;
    const stale = await request('POST', `/api/projects/${project.id}/revisions/${draft.id}/apply`, owner.token, { expectedRevisionId: base.id });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'REVISION_CONFLICT');
    const staleSave = await request('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: draftDocument, expectedRevisionId: base.id, apply: true });
    assert.equal(staleSave.statusCode, 409);
    const result = await checked('GET', `/api/projects/${project.id}`, owner.token);
    assert.equal(result.revision.document.scenes[0].text.headlines.en, 'Latest manual headline');
    assert.equal(result.project.activeRevisionId, activeRevision.id);
  });

  await t.test('API tokens restrict writes, cannot mint other tokens, and revocation is immediate', async () => {
    const connection = await checked('POST', '/api/connections', owner.token, { name: 'Read-only test agent', scopes: ['projects:read'], days: 1 });
    assert.match(connection.token, /^ask_/);
    const stored = await db.query('SELECT token_hash FROM api_tokens WHERE id=$1', [connection.id]);
    assert.notEqual(stored.rows[0].token_hash, connection.token);
    assert.equal((await request('GET', `/api/projects/${project.id}`, connection.token)).statusCode, 200);
    assert.equal((await request('POST', '/api/projects', connection.token, { name: 'Unauthorized write' })).statusCode, 403);
    assert.equal((await request('POST', '/api/connections', connection.token, { name: 'Escalation', scopes: ['projects:write'], days: 1 })).statusCode, 403);
    const list = await checked('GET', '/api/connections', owner.token);
    assert.equal(list.connections.find((item:any) => item.id === connection.id).token, undefined);
    await checked('DELETE', `/api/connections/${connection.id}`, owner.token);
    assert.equal((await request('GET', `/api/projects/${project.id}`, connection.token)).statusCode, 401);
  });

  await t.test('simultaneous saves of one base revision admit exactly one writer', async () => {
    const expectedRevisionId = activeRevision.id;
    const documents = ['Concurrent A', 'Concurrent B'].map(headline => { const document = structuredClone(activeRevision.document); document.scenes[0].text.headlines.en = headline; return document; });
    const responses = await Promise.all(documents.map(document => request('POST', `/api/projects/${project.id}/revisions`, owner.token, { document, expectedRevisionId, apply: true })));
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
    activeRevision = responses.find(response => response.statusCode === 200)!.json().revision;
    const current = await checked('GET', `/api/projects/${project.id}`, owner.token);
    assert.equal(current.project.activeRevisionId, activeRevision.id);
    assert.equal(current.revision.document.scenes[0].text.headlines.en, activeRevision.document.scenes[0].text.headlines.en);
  });

  await t.test('property locks remain authoritative for full-document MCP writes', async () => {
    const locked = structuredClone(activeRevision.document); locked.scenes[0].locks.text = true;
    activeRevision = (await checked('POST', `/api/projects/${project.id}/revisions`, owner.token, { document: locked, expectedRevisionId: activeRevision.id, apply: true })).revision;
    const connection = await checked('POST', '/api/connections', owner.token, { name: 'Lock enforcement agent', scopes: ['projects:read', 'projects:write'], days: 1 });
    const changed = structuredClone(activeRevision.document); changed.scenes[0].text.headlines.en = 'Agent tried changing locked text';
    const edit = await request('POST', `/api/projects/${project.id}/revisions`, connection.token, { document: changed, expectedRevisionId: activeRevision.id, apply: false });
    assert.equal(edit.statusCode, 409); assert.equal(edit.json().error.code, 'LOCKED');
    changed.scenes[0].locks.text = false;
    const bypass = await request('POST', `/api/projects/${project.id}/revisions`, connection.token, { document: changed, expectedRevisionId: activeRevision.id, apply: false });
    assert.equal(bypass.statusCode, 409); assert.equal(bypass.json().error.code, 'LOCKED');
    assert.equal((await checked('GET', `/api/projects/${project.id}`, owner.token)).project.activeRevisionId, activeRevision.id);
  });

  await t.test('MCP transport exercises a real scoped create-draft call without hosted AI', async () => {
    const connection = await checked('POST', '/api/connections', owner.token, { name: 'Direct design test agent', scopes: ['projects:read', 'projects:write', 'assets:write'], days: 1 });
    const response = await request('POST', '/mcp', connection.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'appscreen_create_draft', arguments: { projectId: project.id, assetIds: [asset.id], templateId: 'tidal-relay', templateMode: 'exact', profile: 'iphone-6.9', screenCount: 3, idempotencyKey: `mcp-draft-${run}` } } }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
    assert.equal(response.statusCode, 200, response.body);
    const rpc = response.json(); assert.equal(rpc.result?.isError, undefined, response.body);
    const result = rpc.result.structuredContent || JSON.parse(rpc.result.content[0].text);
    assert.equal(result.revision.document.profile.width, 1320);
    assert.equal(result.project.activeRevisionId, activeRevision.id, 'direct MCP compose must leave the active revision unchanged');
    const exportDenied = await request('POST', `/api/projects/${project.id}/export-jobs`, connection.token, { revisionId: activeRevision.id, idempotencyKey: `denied-export-${run}` });
    assert.equal(exportDenied.statusCode, 403);
    const jobs = await db.query('SELECT count(*)::integer AS count FROM agent_jobs WHERE workspace_id=$1', [owner.session.workspace.id]);
    assert.equal(jobs.rows[0].count, 0, 'direct template/edit calls must not create paid jobs');
  });

  await t.test('upload tickets validate bytes and safely replay only the same completed bytes', async () => {
    const connection = await checked('POST', '/api/connections', owner.token, { name: 'Screenshot uploader', scopes: ['projects:read', 'assets:write'], days: 1 });
    const ticket = await checked('POST', `/api/projects/${project.id}/upload-ticket`, connection.token, { filename: 'uploaded-phone.png', mimeType: 'image/png' });
    const target = new URL(ticket.uploadUrl), path = target.pathname + target.search;
    const invalid = await request('POST', path, undefined, Buffer.from('bad bytes'), { 'content-type': 'image/png' });
    assert.equal(invalid.statusCode, 400);
    const good = await request('POST', path, undefined, png, { 'content-type': 'image/png' });
    assert.equal(good.statusCode, 200, good.body); assert.equal(good.json().asset.id, ticket.assetId);
    const replay = await request('POST', path, undefined, png, { 'content-type': 'image/png' });
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().asset.id, ticket.assetId);
    const different = await sharp({ create: { width: 660, height: 1434, channels: 4, background: '#aabbcc' } }).png().toBuffer();
    const rejected = await request('POST', path, undefined, different, { 'content-type': 'image/png' });
    assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, 'UPLOAD_MISMATCH');
    const rows = await db.query('SELECT count(*)::integer AS count FROM assets WHERE id=$1', [ticket.assetId]);
    assert.equal(rows.rows[0].count, 1);
    const context = await auth.resolveContext(owner.session.user.id, owner.email, owner.session.workspace.id, 'mcp', ['projects:read', 'assets:write']);
    const completed = await services.completeAssetUpload(context, { projectId: project.id, assetId: ticket.assetId });
    assert.equal(completed.asset.id, ticket.assetId);
  });

  await t.test('declared upload checksums and byte lengths are enforced before storage writes', async () => {
    const ticketArgs = { filename: 'size-and-checksum.png', mimeType: 'image/png', byteLength: png.length, checksum: createHash('sha256').update(png).digest('hex'), idempotencyKey: `upload-declaration-${run}` };
    const ticket = await checked('POST', `/api/projects/${project.id}/upload-ticket`, owner.token, ticketArgs);
    const duplicate = await checked('POST', `/api/projects/${project.id}/upload-ticket`, owner.token, { ...ticketArgs });
    assert.equal(duplicate.uploadId, ticket.uploadId); assert.equal(duplicate.uploadUrl, ticket.uploadUrl);
    const conflict = await request('POST', `/api/projects/${project.id}/upload-ticket`, owner.token, { ...ticketArgs, filename: 'changed-file.png' });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const destination = new URL(ticket.uploadUrl), path = destination.pathname + destination.search;
    const wrongSize = await request('POST', path, undefined, png.subarray(0, png.length - 1), { 'content-type': 'image/png' });
    assert.equal(wrongSize.statusCode, 400); assert.equal(wrongSize.json().error.code, 'UPLOAD_MISMATCH');
    const corrupted = Buffer.from(png); corrupted[corrupted.length - 1] ^= 1;
    const wrongChecksum = await request('POST', path, undefined, corrupted, { 'content-type': 'image/png' });
    assert.equal(wrongChecksum.statusCode, 400); assert.equal(wrongChecksum.json().error.code, 'UPLOAD_MISMATCH');
    assert.equal((await request('POST', path, undefined, png, { 'content-type': 'image/png' })).statusCode, 200);
  });

  await t.test('MCP project, draft, operations and apply writes replay safely and reject changed payloads', async () => {
    const connection = await checked('POST', '/api/connections', owner.token, { name: 'Idempotent designer', scopes: ['projects:read', 'projects:write', 'assets:write'], days: 1 });
    const call = async (name:string, args:any) => {
      const response = await request('POST', '/mcp', connection.token, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().result;
      assert.ok(result, response.body);
      return { isError: result.isError, data: result.structuredContent || JSON.parse(result.content[0].text) };
    };
    const projectArgs = { name: 'Replay-safe project', idempotencyKey: `repeat-project-${run}` };
    const projects = await Promise.all([call('appscreen_create_project', projectArgs), call('appscreen_create_project', { ...projectArgs })]);
    assert.equal(projects[0].isError, undefined); assert.equal(projects[0].data.project.id, projects[1].data.project.id);
    const changedProject = await call('appscreen_create_project', { ...projectArgs, name: 'Different request' });
    assert.equal(changedProject.isError, true); assert.equal(changedProject.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const args = { projectId: project.id, assetIds: [asset.id], templateId: 'tidal-relay', templateMode: 'exact', profile: 'iphone-6.9', screenCount: 3, idempotencyKey: `repeat-draft-${run}` };
    const drafts = await Promise.all([call('appscreen_create_draft', args), call('appscreen_create_draft', { ...args })]);
    assert.equal(drafts[0].isError, undefined); assert.equal(drafts[0].data.revision.id, drafts[1].data.revision.id);
    const changedDraft = await call('appscreen_create_draft', { ...args, screenCount: 2 });
    assert.equal(changedDraft.isError, true); assert.equal(changedDraft.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const draft = drafts[0].data.revision;
    const operationArgs = { projectId: project.id, expectedRevisionId: draft.id, operations: [{ op: 'update_text', sceneId: draft.document.scenes[0].id, patch: { headlines: { en: 'One durable edit' } } }], idempotencyKey: `repeat-operation-${run}` };
    const first = await call('appscreen_apply_operations', operationArgs), second = await call('appscreen_apply_operations', structuredClone(operationArgs));
    assert.equal(first.isError, undefined); assert.equal(first.data.revision.id, second.data.revision.id);
    const changedOperation = structuredClone(operationArgs); changedOperation.operations[0].patch.headlines.en = 'Changed request';
    const conflict = await call('appscreen_apply_operations', changedOperation);
    assert.equal(conflict.isError, true); assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const applyArgs = { projectId: project.id, revisionId: first.data.revision.id, expectedRevisionId: activeRevision.id, idempotencyKey: `repeat-apply-${run}` };
    const applied = await call('appscreen_apply_revision', applyArgs), again = await call('appscreen_apply_revision', { ...applyArgs });
    assert.equal(applied.isError, undefined); assert.equal(again.isError, undefined);
    assert.equal(applied.data.project.activeRevisionId, first.data.revision.id); assert.equal(again.data.project.activeRevisionId, first.data.revision.id);
    activeRevision = first.data.revision;
    const changedApply = await call('appscreen_apply_revision', { ...applyArgs, revisionId: draft.id });
    assert.equal(changedApply.isError, true); assert.equal(changedApply.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const receiptRows = await db.query('SELECT count(*)::integer AS count FROM write_receipts WHERE workspace_id=$1 AND request_key=ANY($2::text[])', [owner.session.workspace.id, [projectArgs.idempotencyKey, args.idempotencyKey, operationArgs.idempotencyKey, applyArgs.idempotencyKey]]);
    assert.equal(receiptRows.rows[0].count, 4);
  });

  await t.test('revoking workspace membership invalidates sessions, agent tokens and issued media links', async () => {
    const revoked = await login('revoked');
    const p = (await checked('POST', '/api/projects', revoked.token, { name: 'Revoked access test' })).project;
    const a = await upload(revoked.token, p.id);
    const connection = await checked('POST', '/api/connections', revoked.token, { name: 'Will be revoked', scopes: ['projects:read'], days: 1 });
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [revoked.session.workspace.id, revoked.session.user.id]);
    assert.equal((await request('GET', `/api/projects/${p.id}`, revoked.token)).statusCode, 403);
    assert.equal((await request('GET', `/api/projects/${p.id}`, connection.token)).statusCode, 403);
    const media = new URL(a.url);
    assert.equal((await request('GET', media.pathname + media.search)).statusCode, 403);
  });

  await t.test('account backup route streams complete private ZIP bytes and denies scoped agents', async () => {
    // Another parallel fixture deliberately occupies both installation-wide
    // export slots. Honor its expected throttle without weakening admission.
    let response=await request('GET','/api/account/export',owner.token);
    const deadline=Date.now()+5000;
    while(response.statusCode===429&&response.json().error?.code==='ACCOUNT_EXPORT_BUSY'&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,100));
      response=await request('GET','/api/account/export',owner.token);
    }
    assert.equal(response.statusCode,200,response.body.slice(0,100));assert.match(String(response.headers['content-type']),/application\/zip/);assert.match(String(response.headers['content-disposition']),/appscreen-workspace-.*\.zip/);assert.match(String(response.headers['cache-control']),/private, no-store/);
    const archive=await JSZip.loadAsync(response.rawPayload,{checkCRC32:true});
    const manifest=JSON.parse(await archive.file('manifest.json')!.async('string'));
    const integrity=JSON.parse(await archive.file('integrity.json')!.async('string'));
    assert.equal(manifest.scope.workspaceId,owner.session.workspace.id);assert.equal(integrity.complete,true);
    const assets=(await archive.file('data/assets.ndjson')!.async('string')).trim().split('\n').map(line=>JSON.parse(line));
    const original=assets.find((a:any)=>a.id===asset.id);assert.deepEqual(await archive.file(original.path)!.async('nodebuffer'),png);assert.equal(assets.some((a:any)=>a.id===foreignAsset.id),false);
    const projects=await archive.file('data/projects.ndjson')!.async('string');assert.ok(projects.includes(project.id));assert.equal(projects.includes(strangerProject.id),false);
    const token=await checked('POST','/api/connections',owner.token,{name:'Not an account owner session',scopes:['projects:read','exports:write'],days:1});
    assert.equal((await request('GET','/api/account/export',token.token)).statusCode,403);
  });

  await t.test('static serving denies secrets, source internals, tests, dumps and traversal', async () => {
    for (const path of ['/.env', '/.env.saas.example', '/.git/config', '/.appscreen-data/development-signing-key', '/server/config.ts', '/server/services.ts', '/supabase/migrations/202609040001_saas.sql', '/db/projects.json', '/package.json', '/core/campaign.test.mjs', '/saas/tests/preview-server.mjs', '/saas/tests/real-api-smoke.mjs', '/saas/tests/source-fixture.svg', '/saas/../server/config.ts', '/saas/%2e%2e/server/config.ts', '/img/%2e%2e/.env']) {
      const response = await request('GET', path);
      assert.equal(response.statusCode, 404, `${path}: ${response.statusCode}`);
      assert.equal(response.body.includes(config.signingSecret), false);
      assert.equal(response.body.includes('DATABASE_URL='), false);
    }
    assert.equal((await request('GET', '/core/campaign.mjs')).statusCode, 200);
    for(const path of ['/recover','/reset-password','/auth/callback','/oauth/consent','/app/operator'])assert.equal((await request('GET',path)).statusCode,200,`SPA entry point ${path}`);
    const configResponse = await checked('GET', '/api/config');
    assert.equal(configResponse.aiEnabled, false); assert.equal(configResponse.billingEnabled, false);
    assert.equal(JSON.stringify(configResponse).includes(config.signingSecret), false);
  });
});
