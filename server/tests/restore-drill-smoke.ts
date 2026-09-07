// Opt-in local PostgreSQL + private-file recovery rehearsal. Never a production
// backup/restore command: both databases are fresh and all content is synthetic.
// Requires TEST_DATABASE_URL, RESTORE_DRILL_POSTGRES_CONTAINER, and
// APPSCREEN_RESTORE_DRILL_CONFIRM=synthetic-only. Artifacts/databases are retained.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PgBoss } from 'pg-boss';
import { restoreDrillInputs, quoteDatabaseIdentifier } from '../../deploy/restore-drill-guards.mjs';
import { createDatabase, migrate, verifyMigrations, type DB } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { createStorage } from '../storage.js';
import { createWorker } from '../worker.js';
import { ALL_SCOPES, hash, type Context } from '../auth.js';
import { applyOperations } from '../../core/campaign.mjs';

type Runtime = Awaited<ReturnType<typeof createApp>>;
const sqlName = (value: string) => `"${value.replaceAll('"', '""')}"`;
async function docker(container: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, failed = false;
    const fail = (message: string) => { if (failed) return; failed = true; child.kill('SIGTERM'); reject(new Error(message)); };
    const timeout = setTimeout(() => fail('Local PostgreSQL rehearsal command exceeded its deadline.'), 60_000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) fail('Synthetic database exceeded the rehearsal size bound.'); else chunks.push(chunk); });
    // Do not copy raw process errors (which could include connection information)
    // into the customer-visible report. Exit failure remains an explicit failure.
    child.stderr.resume(); child.on('error', () => fail('Could not start the selected local PostgreSQL utility.'));
    child.stdin.on('error', () => fail('Local PostgreSQL rehearsal input did not complete.'));
    child.on('close', code => { clearTimeout(timeout); if (!failed) code === 0 ? resolve(Buffer.concat(chunks)) : fail(`Local PostgreSQL utility exited unsuccessfully (${code}).`); });
    child.stdin.end(input);
  });
}

async function fingerprint(db: DB) {
  const tables = (await db.query(`SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,
    (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a) AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1,2`)).rows;
  for (const table of tables) {
    const result = await db.query(`SELECT to_jsonb(t)::text AS record FROM ${sqlName(table.schema)}.${sqlName(table.name)} t ORDER BY to_jsonb(t)::text LIMIT 5001`);
    assert.ok(result.rows.length <= 5000, 'Synthetic fixture table exceeded rehearsal bounds.');
    table.count = result.rows.length; table.sha256 = hash(result.rows.map(row => row.record).join('\n'));
  }
  const constraints = (await db.query(`SELECT n.nspname AS schema,c.relname AS table_name,k.conname AS name,pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','app_private','appscreen_queue') ORDER BY 1,2,3`)).rows;
  const policies = (await db.query("SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','app_private','appscreen_queue') ORDER BY 1,2,3")).rows;
  const sequences = (await db.query("SELECT schemaname,sequencename,sequenceowner,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname IN ('public','app_private','appscreen_queue') ORDER BY 1,2")).rows;
  for (const sequence of sequences) sequence.state = (await db.query(`SELECT last_value,is_called FROM ${sqlName(sequence.schemaname)}.${sqlName(sequence.sequencename)}`)).rows[0];
  const columns = (await db.query("SELECT table_schema,table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_schema,udt_name,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema IN ('public','app_private','appscreen_queue') ORDER BY 1,2,4")).rows;
  const indexes = (await db.query("SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','app_private','appscreen_queue') ORDER BY 1,2,3")).rows;
  const functions = (await db.query(`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,
    (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private','appscreen_queue') AND p.prokind IN ('f','p') ORDER BY 1,2,3`)).rows;
  const schemas = (await db.query(`SELECT n.nspname AS name,pg_get_userbyid(n.nspowner) AS owner,
    (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type) FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a) AS acl
    FROM pg_namespace n WHERE n.nspname IN ('public','app_private','appscreen_queue') ORDER BY 1`)).rows;
  const triggers = (await db.query(`SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','app_private','appscreen_queue') ORDER BY 1,2,3`)).rows;
  const views = (await db.query("SELECT schemaname,viewname,viewowner,definition FROM pg_views WHERE schemaname IN ('public','app_private','appscreen_queue') ORDER BY 1,2")).rows;
  return { tables, constraints, policies, sequences, columns, indexes, functions, schemas, triggers, views };
}

async function main() {
  const runId = randomBytes(6).toString('hex'), input = restoreDrillInputs(process.env, runId);
  const output = await mkdtemp(join(tmpdir(), 'appscreen-restore-drill-')); await chmod(output, 0o700);
  const report: any = { version: 1, runId, output, syntheticOnly: true, sourceDatabase: input.sourceName, targetDatabase: input.targetName, databaseTargetCreatedFresh: false,
    providersDisabled: true, queueConsumersStarted: false, privateStorageAdapter: 'local-files, not hosted Supabase Storage', archiveEncrypted: false,
    checks: [], phase: 'preflight', completed: false, limitations: ['Local PostgreSQL logical dump/restore and private files only; not managed Supabase recovery, Auth recovery, off-site encryption or Linux container validation.', 'Synthetic data only. RPO/RTO business targets and remote payment/consent reconciliation remain unverified.', 'Local cluster roles differ from managed Supabase; provider identity and direct Data/Storage API permissions require their separate real-provider tests.'] };
  const pools: DB[] = [], runtimes: Runtime[] = [], renderers: Array<{ close(): Promise<void> }> = [];
  const temporaryTokens: Array<{ db: DB; id: string }> = [];
  const admin = createDatabase(input.adminUrl); pools.push(admin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const value = args[0], url = new URL(typeof value === 'string' ? value : value instanceof URL ? value : value.url);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'External requests are forbidden during recovery rehearsal.');
    return originalFetch(...args);
  };
  const check = (name: string, detail: unknown = true) => report.checks.push({ name, pass: true, detail });
  const configFor = (databaseUrl: string, directory: string) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: directory, APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMBEDDED_WORKER: 'false', MAX_CONCURRENT_JOBS: '4' });
  async function runtimeFor(db: DB, config: ReturnType<typeof configFor>) {
    const runtime = await createApp(config, db); runtimes.push(runtime);
    const address = await runtime.app.listen({ host: '127.0.0.1', port: 0 }); config.baseUrl = address; config.mcpResource = `${address}/mcp`;
    assert.equal(config.openaiKey, ''); assert.equal(config.stripeKey, ''); assert.equal(config.supabaseServiceKey, '');
    return runtime;
  }
  async function login(runtime: Runtime, email: string): Promise<{ token: string; ctx: Context }> {
    const response = await runtime.app.inject({ method: 'POST', url: '/api/dev/session', payload: { email } }); assert.equal(response.statusCode, 200);
    const { token } = response.json();
    const ctx = await runtime.auth.resolveContext(`dev:${hash(email)}`, email, undefined, 'development', [...ALL_SCOPES]);
    return { token, ctx };
  }
  async function exportJob(runtime: Runtime, ctx: Context, projectId: string, revisionId: string, format: 'project' | 'zip') {
    const { job } = await runtime.services.createJob(ctx, { projectId, kind: 'export', input: { revisionId, format }, idempotencyKey: `${runId}:${runtime.services.config.databaseUrl.endsWith(input.sourceName) ? 'source' : 'target'}:${format}` });
    const worker = createWorker(runtime.services, runtime.billing); renderers.push(worker.renderer);
    // Execute only this newly authorized synthetic export. Never start the queue
    // consumer or scan/replay jobs copied from a recovery point.
    await worker.run(job.id); await worker.renderer.close();
    const result = (await runtime.services.db.query('SELECT status,result FROM agent_jobs WHERE id=$1', [job.id])).rows[0];
    assert.ok(['ready', 'needs-input'].includes(result.status), 'Recovered campaign export must complete, not silently fail.');
    return { id: job.id, ...result };
  }
  async function storeArtifact(runtime: Runtime, id: string) {
    const row = (await runtime.services.db.query('SELECT * FROM assets WHERE id=$1', [id])).rows[0]; assert.ok(row);
    const bytes = await runtime.services.storage.read(row.storage_key); assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, Number(row.byte_size)); return bytes;
  }
  try {
    const identity = (await admin.query('SELECT current_database() AS database,current_user AS role,system_identifier::text AS system FROM pg_control_system()')).rows[0];
    assert.equal(identity.database, input.adminName); assert.equal(identity.role, input.user);
    const containerIdentity = (await docker(input.container, ['psql', '-X', '-U', input.user, '-d', input.adminName, '-Atc', 'SELECT system_identifier::text FROM pg_control_system()'])).toString().trim();
    assert.equal(containerIdentity, identity.system, 'Container tools and loopback database must address the same PostgreSQL installation.');
    report.postgresVersion = (await docker(input.container, ['pg_dump', '--version'])).toString().trim();
    for (const name of [input.sourceName, input.targetName]) {
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0, 'Never reuse an existing database for this rehearsal.');
      await admin.query(`CREATE DATABASE ${quoteDatabaseIdentifier(name)} TEMPLATE template0`);
    }
    report.databaseTargetCreatedFresh = true; check('New source and restore databases created without touching existing data');
    const source = createDatabase(input.sourceUrl), target = createDatabase(input.targetUrl); pools.push(source, target);
    assert.equal((await target.query("SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rowCount, 0);
    const sourceConfig = configFor(input.sourceUrl, join(output, 'source-objects')), targetConfig = configFor(input.targetUrl, join(output, 'restored-objects'));
    await mkdir(sourceConfig.localStorageDirectory, { mode: 0o700 }); await mkdir(targetConfig.localStorageDirectory, { mode: 0o700 });
    await migrate(source); const sourceRuntime = await runtimeFor(source, sourceConfig);
    report.phase = 'synthetic-fixture';
    const ownerEmail = `restore-owner-${runId}@example.test`, foreignEmail = `restore-foreign-${runId}@example.test`;
    const owner = await login(sourceRuntime, ownerEmail), foreign = await login(sourceRuntime, foreignEmail);
    const { project } = await sourceRuntime.services.createProject(owner.ctx, { name: 'SYNTHETIC recovery rehearsal', idempotencyKey: `restore-project:${runId}` });
    const { project: otherProject } = await sourceRuntime.services.createProject(foreign.ctx, { name: 'SYNTHETIC other workspace', idempotencyKey: `foreign-project:${runId}` });
    const colors = ['#164e63', '#6b21a8', '#1d4ed8', '#fffbeb', '#fbbf24']; const assetIds: string[] = [];
    for (let index = 0; index < colors.length; index++) {
      // Labeled calibration cards are test pixels, not fabricated app screenshots.
      const label = `<svg width="1320" height="2868"><rect width="1320" height="2868" fill="${colors[index]}"/><path d="M0 1434H1320M660 0V2868" stroke="#ffffff" stroke-width="8"/><text x="660" y="250" text-anchor="middle" fill="#ffffff" font-size="60">SYNTHETIC RESTORE ${index + 1}</text></svg>`;
      const bytes = await sharp(Buffer.from(label)).png().toBuffer();
      const result = await sourceRuntime.services.uploadAsset(owner.ctx, project.id, `synthetic-${index + 1}.png`, bytes); assetIds.push(result.asset.id);
    }
    const draft = await sourceRuntime.services.createDraft(owner.ctx, { projectId: project.id, assetIds: assetIds.slice(0, 2), templateId: 'tidal-relay', templateMode: 'inspiration', screenCount: 3, locale: 'de', idempotencyKey: `restore-draft:${runId}`, apply: true });
    let document = structuredClone(draft.revision.document);
    document.sources[0].localizedAssets.de = assetIds[2];
    document.scenes[0].background = { ...document.scenes[0].background, type: 'image', assetId: assetIds[3] };
    document.scenes[0].elements = [{ id: 'restore-badge', type: 'graphic', assetId: assetIds[4], x: 8, y: 8, width: 10, height: 10, opacity: 100, rotation: 0, layer: 'above-screenshot' }];
    document = applyOperations(document, document.scenes.map((scene: any, index: number) => ({ op: 'update_text', sceneId: scene.id, patch: { headlines: { en: `Recovery check ${index + 1}`, de: `Wiederherstellung ${index + 1}` } } })));
    const saved = await sourceRuntime.services.saveRevision(owner.ctx, project.id, { document, expectedRevisionId: draft.revision.id, apply: true, idempotencyKey: `restore-localized:${runId}`, label: 'Synthetic localized recovery fixture' });
    const sourceProject = await exportJob(sourceRuntime, owner.ctx, project.id, saved.revision.id, 'project');
    const sourceExport = await exportJob(sourceRuntime, owner.ctx, project.id, saved.revision.id, 'zip');
    const sourcePNG = await Promise.all(sourceExport.result.previews.map((preview: any) => storeArtifact(sourceRuntime, preview.assetId)));
    const projectBytes = await storeArtifact(sourceRuntime, sourceProject.result.artifacts.find((item: any) => item.kind === 'project').assetId);
    const projectArchive = await JSZip.loadAsync(projectBytes), projectBackup = JSON.parse(await projectArchive.file('project.json')!.async('string'));
    assert.equal(projectBackup.assets.length, 5);
    assert.deepEqual(projectBackup.assets.map((asset: any) => asset.id).sort(), [...assetIds].sort());
    for (const entry of projectBackup.assets) {
      const file = projectArchive.file(entry.file); assert.ok(file, 'Every portable backup asset must have actual archived bytes.');
      const archived = await file.async('nodebuffer'), original = await sourceRuntime.services.asset(owner.ctx, entry.id);
      assert.equal(archived.length, Number(original.byteSize)); assert.equal(hash(archived), original.sha256);
    }
    check('Original portable backup includes verified localized, background and decorative image bytes', 5);
    // Safe dormant work represents the recovery policy problem; it is never run.
    const dormant: string[] = [];
    for (const status of ['queued', 'running']) {
      const id = randomUUID(); dormant.push(id);
      await source.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,idempotency_key,request_hash,attempts,heartbeat_at) VALUES($1,$2,$3,$4,'design',$5,'planning',$6,$7,$7,1,now()-interval '1 hour')", [id, owner.ctx.workspaceId, project.id, owner.ctx.userId, status, { revisionId: saved.revision.id, syntheticOnly: true }, `dormant:${id}`]);
      await source.query("INSERT INTO credit_reservations(job_id,workspace_id,amount,status) VALUES($1,$2,5,'reserved')", [id, owner.ctx.workspaceId]);
      await source.query("INSERT INTO agent_job_steps(job_id,stage,data) VALUES($1,'storyboard',$2)", [id, { fixture: true, note: 'Do not replay recovery-point jobs.' }]);
    }
    const queue = new PgBoss({ connectionString: input.sourceUrl, schema: 'appscreen_queue' });
    try { await queue.start(); await queue.createQueue('appscreen-jobs'); await queue.send('appscreen-jobs', { jobId: dormant[0] }); } finally { await queue.stop(); }
    const revoked = await sourceRuntime.auth.issueToken(owner.ctx, 'Synthetic revoked before backup', ['projects:read']);
    await source.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [revoked.id]);
    const activeToken = await sourceRuntime.auth.issueToken(owner.ctx, 'Synthetic read-only before backup', ['projects:read']);
    temporaryTokens.push({ db: source, id: activeToken.id });
    await sourceRuntime.app.close();
    report.phase = 'quiescent-backup';
    assert.equal((await source.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'")).rowCount, 0);
    const before = await fingerprint(source); report.backupAt = (await source.query('SELECT now() AS time')).rows[0].time;
    const inventory = (await source.query('SELECT id AS "assetId",storage_key AS "storageKey",mime_type AS "mimeType",byte_size::text AS "byteSize",sha256 FROM assets ORDER BY id')).rows;
    const archiveStorage = createStorage({ ...sourceConfig, localStorageDirectory: join(output, 'backup-objects') });
    await mkdir(join(output, 'backup-objects'), { mode: 0o700 });
    for (const item of inventory) { const bytes = await sourceRuntime.services.storage.read(item.storageKey); assert.equal(hash(bytes), item.sha256); assert.equal(bytes.length, Number(item.byteSize)); await archiveStorage.put(item.storageKey, bytes, item.mimeType); }
    const dump = await docker(input.container, ['pg_dump', '-U', input.user, '-d', input.sourceName, '--format=custom']);
    await writeFile(join(output, 'synthetic-database.dump'), dump, { mode: 0o600, flag: 'wx' });
    assert.deepEqual(await fingerprint(source), before, 'The recovery point must stay quiescent across database and object copies.');
    const manifest = { backupAt: report.backupAt, databaseSha256: hash(dump), databaseBytes: dump.length, objects: inventory, database: before };
    await writeFile(join(output, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    check('Quiescent database and private objects captured with checksums', { tables: before.tables.length, objects: inventory.length });
    report.phase = 'restore'; const started = performance.now();
    // Recovery consumes only the persisted archive/manifest/object copy. The
    // source application is closed; source state is used solely for comparison.
    const recoveryPoint = JSON.parse(await readFile(join(output, 'backup-manifest.json'), 'utf8'));
    const recoveryDump = await readFile(join(output, 'synthetic-database.dump'));
    assert.equal(recoveryDump.length, recoveryPoint.databaseBytes); assert.equal(hash(recoveryDump), recoveryPoint.databaseSha256);
    assert.deepEqual(recoveryPoint, JSON.parse(JSON.stringify(manifest)), 'Persisted recovery manifest must match the recorded recovery point.');
    await docker(input.container, ['pg_restore', '-U', input.user, '-d', input.targetName, '--exit-on-error', '--single-transaction'], recoveryDump);
    temporaryTokens.push({ db: target, id: activeToken.id });
    // No --clean, DROP, source overwrite, or automatically trusted external dump.
    const restoredStorage = createStorage(targetConfig);
    for (const item of recoveryPoint.objects) { const bytes = await archiveStorage.read(item.storageKey); assert.equal(bytes.length, Number(item.byteSize)); assert.equal(hash(bytes), item.sha256); await restoredStorage.put(item.storageKey, bytes, item.mimeType); }
    await verifyMigrations(target); assert.deepEqual(await fingerprint(target), recoveryPoint.database);
    for (const item of recoveryPoint.objects) { const bytes = await restoredStorage.read(item.storageKey); assert.equal(bytes.length, Number(item.byteSize)); assert.equal(hash(bytes), item.sha256); }
    report.restoreMs = Math.round(performance.now() - started); report.objects = { count: inventory.length, bytes: inventory.reduce((sum: number, item: any) => sum + Number(item.byteSize), 0) }; report.databaseDumpBytes = dump.length;
    check('Database rows, migrations, columns, indexes, constraints, RLS, effective grants, functions, triggers, views and sequence state match the backup');
    check('Every original and derived object restored under its original key with exact byte count and SHA-256', report.objects);
    const pendingBefore = (await target.query('SELECT id,status,attempts,input,heartbeat_at FROM agent_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [dormant])).rows;
    assert.equal(pendingBefore.length, 2); assert.equal((await target.query("SELECT 1 FROM credit_reservations WHERE status='reserved' AND job_id=ANY($1::uuid[])", [dormant])).rowCount, 2);
    assert.equal((await target.query("SELECT 1 FROM agent_jobs j JOIN credit_reservations r ON r.job_id=j.id WHERE j.status IN ('ready','needs-input') AND r.status='reserved'")).rowCount, 0);
    check('Queued/running work and checkpoints remain dormant; completed work has no unresolved reservation');
    report.phase = 'recovered-application';
    const targetRuntime = await runtimeFor(target, targetConfig), restoredOwner = await login(targetRuntime, ownerEmail), restoredForeign = await login(targetRuntime, foreignEmail);
    assert.equal(restoredOwner.ctx.workspaceId, owner.ctx.workspaceId); assert.equal(restoredForeign.ctx.workspaceId, foreign.ctx.workspaceId);
    const headers = { authorization: `Bearer ${restoredOwner.token}` };
    const ownRead = await targetRuntime.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers }); assert.equal(ownRead.statusCode, 200);
    assert.deepEqual(ownRead.json().revision.document, saved.revision.document);
    for (const [token, projectId] of [[restoredForeign.token, project.id], [restoredOwner.token, otherProject.id]]) {
      assert.equal((await targetRuntime.app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: { authorization: `Bearer ${token}` } })).statusCode, 404);
    }
    assert.equal((await targetRuntime.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${revoked.token}` } })).statusCode, 401);
    assert.equal((await targetRuntime.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: `Bearer ${activeToken.token}` } })).statusCode, 200);
    assert.equal((await targetRuntime.app.inject({ method: 'POST', url: '/api/projects', headers: { authorization: `Bearer ${activeToken.token}` }, payload: { name: 'forbidden' } })).statusCode, 403);
    check('Real HTTP sign-in recovers both workspaces; cross-workspace access and revoked/read-only token mutations fail');
    const stale = await targetRuntime.app.inject({ method: 'POST', url: `/api/projects/${project.id}/revisions`, headers, payload: { document: saved.revision.document, expectedRevisionId: draft.revision.id, apply: true, idempotencyKey: `stale:${runId}` } });
    assert.equal(stale.statusCode, 409); check('Stale restored-editor saves reject newer revisions instead of overwriting');
    const recovered = await exportJob(targetRuntime, restoredOwner.ctx, project.id, saved.revision.id, 'zip');
    for (let index = 0; index < recovered.result.previews.length; index++) {
      const bytes = await storeArtifact(targetRuntime, recovered.result.previews[index].assetId), meta = await sharp(bytes).metadata();
      assert.equal(meta.width, 1320); assert.equal(meta.height, 2868); assert.equal(meta.hasAlpha, false); assert.deepEqual(bytes, sourcePNG[index]);
      await writeFile(join(output, `restored-${index + 1}.png`), bytes, { mode: 0o600 });
    }
    const recoveredZip = await storeArtifact(targetRuntime, recovered.result.artifacts.find((item: any) => item.kind === 'zip').assetId), zip = await JSZip.loadAsync(recoveredZip);
    const exportManifest = JSON.parse(await zip.file('manifest.json')!.async('string')); assert.equal(exportManifest.screens.length, 3); assert.deepEqual(exportManifest.sourceAssetIds.sort(), [...assetIds].sort());
    for (let index = 0; index < exportManifest.screens.length; index++) assert.deepEqual(await zip.file(exportManifest.screens[index].file)!.async('nodebuffer'), sourcePNG[index]);
    const originalZip = await storeArtifact(sourceRuntime, sourceExport.result.artifacts.find((item: any) => item.kind === 'zip').assetId); assert.deepEqual(recoveredZip, originalZip);
    await writeFile(join(output, 'restored-campaign.zip'), recoveredZip, { mode: 0o600 });
    await writeFile(join(output, 'restored-contact-sheet.png'), await storeArtifact(targetRuntime, recovered.result.contactSheet.assetId), { mode: 0o600 });
    check('Restored localized, decorated overflow campaign exports three opaque 1320×2868 PNGs and an identical ordered ZIP');
    assert.deepEqual((await target.query('SELECT id,status,attempts,input,heartbeat_at FROM agent_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [dormant])).rows, pendingBefore);
    assert.equal((await target.query('SELECT count(*)::integer AS count FROM usage_events')).rows[0].count, 0); check('Recovery validation does not replay dormant AI/queue jobs or consume provider usage');
    // Revoke the rehearsal's temporary active token in both independent copies.
    for (const db of [source, target]) await db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [activeToken.id]);
    report.pendingJobs = pendingBefore.map((item: any) => ({ id: item.id, status: item.status, attempts: item.attempts }));
    report.export = { count: 3, width: 1320, height: 2868, alpha: false, byteIdentical: true, qa: recovered.result.qa };
    report.phase = 'complete'; report.completed = true;
  } catch (error: any) {
    report.failure = { code: String(error?.code || error?.name || 'REHEARSAL_FAILED'), message: String(error?.message || 'The rehearsal failed.').split('\n')[0].replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]').slice(0, 500) };
    throw error;
  } finally {
    await Promise.allSettled(renderers.map(renderer => renderer.close()));
    await Promise.allSettled(runtimes.map(runtime => runtime.app.close()));
    const tokenCleanup = await Promise.allSettled(temporaryTokens.map(({ db, id }) => db.query('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [id])));
    report.temporaryTokenRevocation = { attempted: temporaryTokens.length, succeeded: tokenCleanup.filter(result => result.status === 'fulfilled').length };
    if (tokenCleanup.some(result => result.status === 'rejected')) { report.completed = false; process.exitCode = 1; }
    await Promise.allSettled(pools.map(pool => pool.end())); globalThis.fetch = originalFetch;
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ completed: report.completed, phase: report.phase, output, checks: report.checks.length, sourceDatabase: input.sourceName, targetDatabase: input.targetName, restoreMs: report.restoreMs, objects: report.objects }));
  }
}
main().catch(() => { console.error('Synthetic restore rehearsal failed; inspect its phase and local artifacts. No existing database was a restore target.'); process.exitCode = 1; });
