import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { importProjectBackup } from '../project-import.js';
import { deterministicZip } from '../worker.js';
import { createCampaign } from '../../core/campaign.mjs';
import { collectCampaignAssetIds } from '../render-service.js';
import { hash } from '../auth.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('portable campaign import is private, atomic, replay-safe and preserves exact layouts', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  assert.equal(new URL(databaseUrl!).pathname, '/appscreen_test', 'Only the dedicated appscreen_test database may be used.');
  assert.equal(process.env.DATABASE_URL, databaseUrl, 'Both database variables must select the isolated test database.');
  const db = createDatabase(databaseUrl!), directory = await mkdtemp(join(tmpdir(), 'appscreen-import-test-'));
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!, APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APP_BASE_URL: 'http://localhost', APPSCREEN_STORAGE_PATH: directory, APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMAIL_ENABLED: 'false', MAX_PROJECTS: '30' });
  await migrate(db); const application = await createApp(config, db); const { app, services, auth } = application; await app.ready();
  t.after(async () => { await app.close(); await db.end(); });
  const run = randomUUID();
  const owner = await auth.developmentSession(`import-${run}@appscreen.test`), stranger = await auth.developmentSession(`stranger-${run}@appscreen.test`);
  const context = await auth.authenticate({ headers: { authorization: `Bearer ${owner.token}` } } as any);
  const foreignContext = await auth.authenticate({ headers: { authorization: `Bearer ${stranger.token}` } } as any);
  const originalProject = (await services.createProject(context, { name: 'Never overwrite this campaign' })).project;
  const pngs = await Promise.all(['#144358', '#358973', '#d6a569', '#682341', '#447198'].map(background => sharp({ create: { width: 64, height: 128, channels: 4, background } }).png().toBuffer()));
  const sourceAssets: any[] = [];
  for (let index = 0; index < pngs.length; index++) sourceAssets.push((await services.uploadAsset(context, originalProject.id, `Source ${index + 1}.png`, pngs[index])).asset);
  const draft = await services.createDraft(context, { projectId: originalProject.id, assetIds: sourceAssets.map(asset => asset.id), templateId: 'tidal-relay', templateMode: 'exact', screenCount: 5, apply: true });
  const source = structuredClone(draft.revision.document); source.locks = { colors: true }; source.scenes[0].locks = { text: true }; source.scenes[0].text.headlines.en = 'Preserve this exact copy';
  // Exercise all canonical reference locations, including localized and nested
  // media that older top-level-only validators would miss.
  source.sources[0].localizedAssets = { fr: sourceAssets[1].id, de: { assetId: sourceAssets[2].id, width: 64, height: 128 } };
  source.scenes[0].background.assetId = sourceAssets[3].id;
  source.scenes[1].elements.push({ id: 'decorative-test-layer', type: 'image', assetId: sourceAssets[4].id });
  source.scenes[2].popouts.push({ id: 'nested-test-media', media: { assetId: sourceAssets[1].id }, sourceAssetId: sourceAssets[2].id });
  const manifest = { format: 'appscreen-campaign', version: 1, document: source, assets: sourceAssets.map(asset => ({ id: asset.id, name: asset.name, file: `assets/${asset.id}.png`, mimeType: 'image/png' })) };
  const archive = await deterministicZip([{ name: 'project.json', bytes: JSON.stringify(manifest) }, ...manifest.assets.map((asset, index) => ({ name: asset.file, bytes: pngs[index] }))]);
  const form = (bytes: Buffer, key: string, name?: string, extraFields: Array<[string, string]> = []) => {
    const boundary = `appscreen-${randomUUID()}`;
    const fields: Array<[string, string]> = [['idempotencyKey', key], ['expectedWorkspaceId', context.workspaceId], ['expectedUserId', context.userId], ...(name === undefined ? [] : [['name', name] as [string, string]]), ...extraFields];
    return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
      // File first proves fields are read after streaming the uploaded file too.
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="editable-project.zip"\r\nContent-Type: application/zip\r\n\r\n`), bytes,
      ...fields.map(([key, value]) => Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`)), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]) };
  };
  let requestCount = 0;
  const upload = (bytes: Buffer, key: string, token = owner.token, name?: string, extraHeaders = {}) => { const body = form(bytes, key, name); return app.inject({ method: 'POST', url: '/api/projects/import', remoteAddress: `127.0.0.${++requestCount + 1}`, ...body, headers: { ...body.headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders } }); };
  const counts = async () => (await db.query('SELECT (SELECT count(*)::int FROM projects WHERE workspace_id=$1) projects,(SELECT count(*)::int FROM assets WHERE workspace_id=$1) assets,(SELECT count(*)::int FROM campaign_revisions WHERE workspace_id=$1) revisions', [context.workspaceId])).rows[0];
  let imported: any;
  const firstKey = `import-${randomUUID()}`;

  await t.test('authentication, origin and both write scopes are required before parsing', async () => {
    assert.equal((await upload(archive, randomUUID(), '')).statusCode, 401);
    assert.equal((await upload(archive, randomUUID(), owner.token, undefined, { origin: 'https://foreign.invalid' })).statusCode, 403);
    for (const scopes of [['projects:read'], ['projects:read', 'projects:write'], ['projects:read', 'assets:write']]) {
      const connection = await auth.issueToken(context, 'Limited import', scopes, 1);
      assert.equal((await upload(archive, randomUUID(), connection.token)).statusCode, 403);
    }
    const before = await counts(); assert.deepEqual(before, { projects: 1, assets: 5, revisions: 1 });
  });
  await t.test('the HTTP upload creates a separate campaign and preserves byte-exact originals and connected geometry', async () => {
    const response = await upload(archive, firstKey); assert.equal(response.statusCode, 200, response.body); imported = response.json();
    assert.notEqual(imported.project.id, originalProject.id); assert.equal(imported.project.workspaceId, context.workspaceId);
    assert.equal(imported.project.name, 'Never overwrite this campaign · Imported copy');
    assert.equal(imported.project.activeRevisionId, imported.revision.id); assert.equal(imported.revision.parentRevisionId, null);
    const document = imported.revision.document;
    assert.equal(document.id, imported.project.id); assert.equal(document.revision, 0); assert.equal(document.revisionId, imported.revision.id);
    assert.notEqual(imported.revision.id, draft.revision.id); assert.deepEqual(document.deviceGroups, source.deviceGroups);
    assert.deepEqual(document.appearanceGroups, source.appearanceGroups); assert.deepEqual(document.locks, source.locks);
    assert.deepEqual(document.scenes.map((scene: any) => scene.devices), source.scenes.map((scene: any) => scene.devices));
    assert.deepEqual(document.sources.map((item: any) => item.id), source.sources.map((item: any) => item.id));
    assert.deepEqual(document.scenes.map((scene: any) => scene.text), source.scenes.map((scene: any) => scene.text));
    assert.deepEqual(document.template, source.template);
    const remapped = new Map(source.sources.map((item: any, index: number) => [item.assetId, document.sources[index].assetId]));
    assert.equal(document.sources[0].localizedAssets.fr, remapped.get(sourceAssets[1].id));
    assert.equal(document.sources[0].localizedAssets.de, remapped.get(sourceAssets[2].id));
    assert.equal(document.scenes[0].background.assetId, remapped.get(sourceAssets[3].id));
    assert.equal(document.scenes[1].elements.at(-1).assetId, remapped.get(sourceAssets[4].id));
    assert.equal(document.scenes[2].popouts[0].media.assetId, remapped.get(sourceAssets[1].id));
    assert.equal(document.scenes[2].popouts[0].sourceAssetId, remapped.get(sourceAssets[2].id));
    for (let index = 0; index < sourceAssets.length; index++) {
      const id = document.sources[index].assetId; assert.ok(!sourceAssets.some(asset => asset.id === id));
      const asset = await services.asset(context, id); assert.equal(asset.projectId, imported.project.id); assert.equal(asset.mimeType, 'image/png'); assert.equal(asset.width, 64); assert.equal(asset.height, 128);
      assert.deepEqual(await services.storage.read(asset.storageKey), pngs[index]); assert.equal(asset.sha256, hash(pngs[index]));
    }
    assert.deepEqual(collectCampaignAssetIds(document), [...remapped.values()].sort());
    const original = await services.getProject(context, { projectId: originalProject.id });
    assert.equal(original.project.activeRevisionId, draft.revision.id); assert.deepEqual(original.revision.document, draft.revision.document);
    assert.deepEqual(await counts(), { projects: 2, assets: 10, revisions: 2 });
    const jobs = await db.query('SELECT count(*)::int count FROM agent_jobs WHERE workspace_id=$1', [context.workspaceId]); assert.equal(jobs.rows[0].count, 0);
    assert.equal((await services.credits(context.workspaceId)).available, 100);
  });
  await t.test('same-key retries are immutable even after the imported campaign changes', async () => {
    const updated = structuredClone(imported.revision.document); updated.scenes[1].text.headlines.en = 'Later edit';
    await services.saveRevision(context, imported.project.id, { document: updated, expectedRevisionId: imported.revision.id, apply: true });
    const before = await counts(); const replay = await upload(archive, firstKey); assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), imported); assert.deepEqual(await counts(), before);
    assert.equal((await services.getProject(context, { projectId: imported.project.id })).revision.document.scenes[1].text.headlines.en, 'Later edit');
    const conflict = await upload(archive, firstKey, owner.token, 'Different name'); assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const changed = structuredClone(manifest); changed.document.name = 'Different file';
    const changedArchive = await deterministicZip([{ name: 'project.json', bytes: JSON.stringify(changed) }, ...manifest.assets.map((asset, index) => ({ name: asset.file, bytes: pngs[index] }))]);
    await assert.rejects(importProjectBackup(services, context, { bytes: changedArchive, idempotencyKey: firstKey }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  });
  await t.test('concurrent retries create exactly one campaign and no duplicate original blobs', async () => {
    const key = randomUUID(), before = await counts();
    const results = await Promise.all(Array.from({ length: 4 }, () => importProjectBackup(services, context, { bytes: archive, idempotencyKey: key, name: 'Concurrent copy' })));
    assert.equal(new Set(results.map(result => result.project.id)).size, 1);
    for (const result of results) assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(results[0])));
    const after = await counts(); assert.equal(after.projects, before.projects + 1); assert.equal(after.assets, before.assets + 5); assert.equal(after.revisions, before.revisions + 1);
  });
  await t.test('a backup can be imported by its holder but never reuses other workspace assets', async () => {
    const copy = await importProjectBackup(services, foreignContext, { bytes: archive, idempotencyKey: randomUUID() });
    assert.equal(copy.project.workspaceId, foreignContext.workspaceId); assert.notEqual(copy.project.id, originalProject.id);
    for (const item of copy.revision.document.sources) assert.equal((await services.asset(foreignContext, item.assetId)).projectId, copy.project.id);
    await assert.rejects(services.getProject(foreignContext, { projectId: imported.project.id }), (error: any) => error.statusCode === 404);
    await assert.rejects(services.getProject(context, { projectId: copy.project.id }), (error: any) => error.statusCode === 404);
  });
  await t.test('project and storage admission failures are atomic', async () => {
    const before = await counts(), previousProjects = config.maxProjects, previousStorage = config.maxStorageBytes;
    try {
      config.maxProjects = before.projects;
      await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: randomUUID() }), (error: any) => error.code === 'PROJECT_LIMIT');
      config.maxProjects = previousProjects; config.maxStorageBytes = 1;
      await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: randomUUID() }), (error: any) => error.code === 'STORAGE_LIMIT');
      assert.deepEqual(await counts(), before);
    } finally { config.maxProjects = previousProjects; config.maxStorageBytes = previousStorage; }
  });
  await t.test('concurrent different imports cannot exceed the project admission limit', async () => {
    const before = await counts(), previous = config.maxProjects; config.maxProjects = before.projects + 1;
    try {
      const results = await Promise.allSettled([randomUUID(), randomUUID()].map(key => importProjectBackup(services, context, { bytes: archive, idempotencyKey: key })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'PROJECT_LIMIT');
      const after = await counts(); assert.equal(after.projects, before.projects + 1); assert.equal(after.assets, before.assets + 5);
    } finally { config.maxProjects = previous; }
  });
  await t.test('storage failure cleans only the pending import and same-key retry resumes safely', async () => {
    const before = await counts(), key = randomUUID(), put = services.storage.put.bind(services.storage), removed: string[] = [];
    const remove = services.storage.remove.bind(services.storage); let writes = 0;
    services.storage.put = async (...args) => { if (++writes === 2) throw new Error('Injected storage failure'); await put(...args); };
    services.storage.remove = async path => { removed.push(path); await remove(path); };
    try { await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: key }), (error: any) => error.code === 'IMPORT_STORAGE_FAILED'); }
    finally { services.storage.put = put; services.storage.remove = remove; }
    assert.deepEqual(await counts(), before); assert.equal(removed.length, 1);
    for (const asset of sourceAssets) assert.deepEqual(await services.storage.read((await services.asset(context, asset.id)).storageKey), pngs[sourceAssets.indexOf(asset)]);
    const pending = (await db.query("SELECT result FROM write_receipts WHERE workspace_id=$1 AND user_id=$2 AND action='import-project' AND request_key=$3", [context.workspaceId, context.userId, key])).rows[0].result;
    assert.equal(pending.state, 'pending');
    const recovered = await importProjectBackup(services, context, { bytes: archive, idempotencyKey: key }); assert.equal(recovered.project.id, pending.projectId);
  });
  await t.test('ambiguous successful storage responses adopt byte-matching objects', async () => {
    const put = services.storage.put.bind(services.storage); let attempts = 0;
    services.storage.put = async (...args) => { await put(...args); attempts++; throw new Error('Upload response lost'); };
    try { const copy = await importProjectBackup(services, context, { bytes: archive, idempotencyKey: randomUUID() }); assert.ok(copy.project.activeRevisionId); assert.equal(attempts, 5); }
    finally { services.storage.put = put; }
  });
  await t.test('known pre-commit database failure removes only matching pending bytes and no campaign appears', async () => {
    const before = await counts(), key = randomUUID(), written: string[] = [], put = services.storage.put.bind(services.storage);
    services.storage.put = async (...args) => { written.push(args[0]); return put(...args); };
    services.db = new Proxy(db, { get(target, property) { if (property === 'connect') return async () => { const client = await db.connect(); return new Proxy(client, { get(target, property) { if (property === 'query') return (...args: any[]) => String(args[0]).startsWith('INSERT INTO campaign_revisions') ? Promise.reject(new Error('Injected revision failure')) : (client.query as any)(...args); const value = (target as any)[property]; return typeof value === 'function' ? value.bind(target) : value; } }); }; const value = (target as any)[property]; return typeof value === 'function' ? value.bind(target) : value; } });
    try { await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: key }), /Injected revision failure/); }
    finally { services.db = db; services.storage.put = put; }
    assert.deepEqual(await counts(), before); assert.equal(written.length, 5);
    for (const path of written) await assert.rejects(services.storage.read(path));
    const copy = await importProjectBackup(services, context, { bytes: archive, idempotencyKey: key }); assert.ok(copy.project.id);
  });
  await t.test('uncertain COMMIT response never deletes possibly committed source bytes', async () => {
    const key = randomUUID(), before = await counts(); let commits = 0;
    services.db = new Proxy(db, { get(target, property) { if (property === 'connect') return async () => { const client = await db.connect(); return new Proxy(client, { get(target, property) { if (property === 'query') return async (...args: any[]) => { const result = await (client.query as any)(...args); if (args[0] === 'COMMIT' && ++commits === 2) throw new Error('Commit response lost'); return result; }; const value = (target as any)[property]; return typeof value === 'function' ? value.bind(target) : value; } }); }; const value = (target as any)[property]; return typeof value === 'function' ? value.bind(target) : value; } });
    try { await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: key }), /Commit response lost/); }
    finally { services.db = db; }
    const replay = await importProjectBackup(services, context, { bytes: archive, idempotencyKey: key });
    assert.equal((await counts()).projects, before.projects + 1);
    for (const asset of replay.revision.document.sources) assert.ok((await services.storage.read((await services.asset(context, asset.assetId)).storageKey)).length > 0);
  });
  await t.test('membership revoked during slow storage writes prevents final admission and cleans pending bytes', async () => {
    const before = await counts(), put = services.storage.put.bind(services.storage), paths: string[] = [];
    let unblock!: () => void, started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; }), resume = new Promise<void>(resolve => { unblock = resolve; });
    services.storage.put = async (...args) => { await put(...args); paths.push(args[0]); if (paths.length === 1) { started(); await resume; } };
    const importing = importProjectBackup(services, context, { bytes: archive, idempotencyKey: randomUUID() });
    const rejected = assert.rejects(importing, (error: any) => error.code === 'WORKSPACE_FORBIDDEN');
    try {
      await writing;
      await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
      unblock(); await rejected;
      assert.deepEqual(await counts(), before);
      for (const path of paths) await assert.rejects(services.storage.read(path));
    } finally { unblock(); services.storage.put = put; await db.query("UPDATE workspace_members SET status='active' WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]); }
  });
  await t.test('expected account fields bind initial import and completed replay to the selected account', async () => {
    for (const [workspaceId, userId] of [[foreignContext.workspaceId, context.userId], [context.workspaceId, foreignContext.userId]]) {
      const body = form(archive, firstKey); body.payload = Buffer.from(body.payload.toString('binary').replace(context.workspaceId, workspaceId).replace(context.userId, userId), 'binary');
      const response = await app.inject({ method: 'POST', url: '/api/projects/import', ...body, headers: { ...body.headers, authorization: `Bearer ${owner.token}` } });
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'IMPORT_ACCOUNT_CHANGED');
    }
  });
  await t.test('only two HTTP imports buffer/parse concurrently and error paths release the capacity slot', async () => {
    const put = services.storage.put.bind(services.storage); let unblock!: () => void, started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; }), resume = new Promise<void>(resolve => { unblock = resolve; }); let paused = false;
    services.storage.put = async (...args) => { if (!paused) { paused = true; started(); await resume; } return put(...args); };
    const first = upload(archive, randomUUID()); let second: ReturnType<typeof upload> | undefined;
    try {
      await writing; second = upload(archive, randomUUID());
      // Wait until request two has acquired the capacity gate and reached its
      // workspace-row lock. No timers or production state are needed.
      const baseMembership = services.assertMembership.bind(services); let thirdChecked!: () => void;
      const thirdReady = new Promise<void>(resolve => { thirdChecked = resolve; }); let checked = 0;
      services.assertMembership = async (...args) => { await baseMembership(...args); if (++checked >= 2) thirdChecked(); };
      await thirdReady; services.assertMembership = baseMembership;
      const denied = await upload(archive, randomUUID()); assert.equal(denied.statusCode, 503, denied.body); assert.equal(denied.json().error.code, 'IMPORT_BUSY');
      unblock(); assert.equal((await first).statusCode, 200); assert.equal((await second).statusCode, 200);
      const invalid = await upload(Buffer.from('bad ZIP'), randomUUID()); assert.equal(invalid.statusCode, 400);
      const final = await upload(archive, randomUUID()); assert.equal(final.statusCode, 200, final.body);
    } finally { unblock(); services.storage.put = put; await first; if (second) await second; }
  });
  await t.test('request validation and revoked membership never create a partial campaign', async () => {
    const before = await counts();
    assert.equal((await upload(archive, 'short')).statusCode, 400);
    assert.equal((await upload(archive, randomUUID(), owner.token, ' '.repeat(4))).statusCode, 400);
    assert.equal((await upload(archive, randomUUID(), owner.token, 'x'.repeat(121))).statusCode, 400);
    const duplicate = form(archive, randomUUID(), undefined, [['idempotencyKey', randomUUID()]]);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', ...duplicate, headers: { ...duplicate.headers, authorization: `Bearer ${owner.token}` } })).statusCode, 400);
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
    try { await assert.rejects(importProjectBackup(services, context, { bytes: archive, idempotencyKey: firstKey }), (error: any) => error.code === 'WORKSPACE_FORBIDDEN'); }
    finally { await db.query("UPDATE workspace_members SET status='active' WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]); }
    assert.deepEqual(await counts(), before);
  });
});
