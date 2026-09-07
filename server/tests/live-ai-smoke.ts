// Opt-in only. Defaults to offline preparation. This file is not in *.test.ts.
// No dotenv loader, queue consumer, customer screenshots, or provider call exists
// in --prepare. --live requires one-use prepared evidence and an explicitly
// pinned aggregate ledger; new fixtures cannot reset the total test allowance.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import JSZip from 'jszip';
import sharp from 'sharp';
import { validateCampaign } from '../../core/campaign.mjs';
import { ALL_SCOPES, type Context } from '../auth.js';
import { loadConfig } from '../config.js';
import { createDatabase, row, transaction, verifyMigrations } from '../db.js';
import { AppServices } from '../services.js';
import { createStorage } from '../storage.js';
import { collectCampaignAssetIds, createRenderer, isAllowedRenderRequest } from '../render-service.js';
import { createWorker } from '../worker.js';
import { createAgentEngine } from '../agent/engine.mjs';
import { createOpenAIProvider } from '../agent/provider.mjs';
import { createSpendGuard } from '../agent/spend-guard.mjs';
import { openLiveAIBudgetLedger } from '../../deploy/live-ai-budget-ledger.mjs';
import { FIXTURE_BRIEF, FIXTURE_PROFILE, syntheticLiveAISources, fixedManualDocument, assertFixedManualDocument, connectedFixtureGeometry } from './live-ai-fixtures.mjs';
import {
  LIVE_AI_FIXTURE_VERSION, LIVE_AI_LIMITS, LIVE_AI_RATE_CARD, LIVE_AI_RATE_SOURCES,
  assertLiveAITestDatabase, parseLiveAIArguments, assertPreparedDirectory, readBoundedFile, readPreparedChild,
  assertLiveAIApproval, createLiveAIReportWriter, extractApprovedOpenAIKey, createApprovedOpenAIFetch,
  sha256, canonicalJSON, requireCheck, rehearsalError, liveAIBudgetBinding,
} from '../../deploy/live-ai-smoke-guards.mjs';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const profile = FIXTURE_PROFILE;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const writeJSON = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const documentHash = (document: any) => sha256(canonicalJSON(document));
async function verifyPng(bytes: Buffer, width: number, height: number) {
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  assert.equal(meta.format, 'png'); assert.equal(meta.width, width); assert.equal(meta.height, height); assert.equal(meta.hasAlpha, false);
  const { data, info } = await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3); assert.equal(data.length, width * height * 3);
}
function sourceEvidence(sources: any[], assetIds: string[]) {
  return sources.map((source, index) => ({ index: index + 1, assetId: assetIds[index], name: source.name, bytes: source.bytes.length, sha256: sha256(source.bytes), width: source.width, height: source.height }));
}
async function main() {
  const args = parseLiveAIArguments(process.argv.slice(2));
  const databaseUrl = process.env.TEST_DATABASE_URL || '';
  const database = assertLiveAITestDatabase(databaseUrl);
  const output = args.mode === 'prepare'
    ? await mkdtemp(join(await realpath(tmpdir()), 'appscreen-live-ai-'))
    : await assertPreparedDirectory(args.directory!, tmpdir());
  const nativeFetch = globalThis.fetch;
  let deniedFetches = 0, providerRequests = 0;
  // Renderer traffic is separately restricted by the unchanged production
  // Chromium route allowlist and the ephemeral file-only server below.
  globalThis.fetch = async () => { deniedFetches++; throw rehearsalError('EXTERNAL_FETCH_DISABLED'); };
  const report: any = {
    version: 1, mode: args.mode, output, startedAt: new Date().toISOString(), status: 'preparing', completed: false,
    fixtureVersion: LIVE_AI_FIXTURE_VERSION, limits: LIVE_AI_LIMITS, rateCard: LIVE_AI_RATE_CARD,
    rateSources: LIVE_AI_RATE_SOURCES, database: database.database, aiProviderInvoiceCostUsd: null,
    security: { dotenvLoaded: false, customerSources: false, billingEnabled: false, serviceEmailEnabled: false, oauthEnabled: false, queueConsumerStarted: false, liveAuthorizationAssumed: false },
    checks: [], artifacts: [], visualReview: { status: 'pending-review' },
    limitations: ['One synthetic evaluation is not a representative ten-campaign quality benchmark, production approval or provider billing reconciliation.', 'A usage-derived cost is not an invoice. Aggregate reservations include the prior attempt and are never released, including ambiguous calls.', 'This prepared fixture is one-use. Controlled fresh attempts require the same explicitly pinned aggregate ledger; SDK retries remain disabled.'],
  };
  const check = (label: string, value: boolean) => { report.checks.push({ label, pass: value }); requireCheck(value, 'EVALUATION_CHECK_FAILED'); };
  const reportWriter = createLiveAIReportWriter(output, args.mode);
  const persist = () => reportWriter.persist(report);
  const db = createDatabase(databaseUrl);
  let server: Server | undefined, renderer: ReturnType<typeof createRenderer> | undefined;
  let guard: ReturnType<typeof createSpendGuard> | undefined;
  let budgetLedger: Awaited<ReturnType<typeof openLiveAIBudgetLedger>> | undefined;
  let prepared: any, ctx: Context | undefined, services: AppServices | undefined, jobId: string | undefined;
  try {
    await verifyMigrations(db);
    if (args.mode === 'live') {
      prepared = JSON.parse((await readBoundedFile(join(output, 'prepared.json'), 2 * 1024 * 1024)).toString('utf8'));
      assertLiveAIApproval(prepared, {
        APPSCREEN_LIVE_AI_CONFIRM: process.env.APPSCREEN_LIVE_AI_CONFIRM,
        APPSCREEN_LIVE_AI_RUN_ID: process.env.APPSCREEN_LIVE_AI_RUN_ID,
        APPSCREEN_LIVE_AI_RATE_REVIEWED: process.env.APPSCREEN_LIVE_AI_RATE_REVIEWED,
        APPSCREEN_LIVE_AI_KEY_FILE: process.env.APPSCREEN_LIVE_AI_KEY_FILE,
      }, { databaseFingerprint: database.fingerprint, expectedKeyFile: join(repository, '.env') });
      for (const id of [prepared.workspaceId, prepared.projectId, prepared.revisionId, prepared.runId]) requireCheck(uuid.test(id || ''), 'PREPARATION_INVALID');
    }
    const runId = prepared?.runId || randomUUID(), workspaceId = prepared?.workspaceId || randomUUID();
    report.runId = runId; report.workspaceId = workspaceId;
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: join(output, 'private-storage'), APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMBEDDED_WORKER: 'false' });
    check('Only local private storage and disabled provider defaults are configured', !config.allowLiveAI && !config.openaiKey && !config.enableBilling && !config.emailEnabled && !config.supabaseServiceKey && !config.mcpOAuthEnabled);
    const mime: Record<string, string> = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', config.baseUrl);
      if (!['GET', 'HEAD'].includes(request.method || '') || !isAllowedRenderRequest(url.href, config.baseUrl)) { response.writeHead(404).end(); return; }
      try { const bytes = await readFile(resolve(repository, '.' + url.pathname)); response.writeHead(200, { 'Content-Type': mime[extname(url.pathname)] || 'application/octet-stream' }).end(request.method === 'HEAD' ? undefined : bytes); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    config.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const originalStorage = createStorage(config), fixedSources = new Map<string, Buffer>();
    services = new AppServices(db, config, { ...originalStorage, async read(key: string) {
      requireCheck(key.startsWith(workspaceId + '/'), 'OUTSIDE_SYNTHETIC_WORKSPACE');
      const expected = fixedSources.get(key);
      requireCheck(!!expected || (!!jobId && key.startsWith(`${workspaceId}/exports/${jobId}/`)), 'NONFIXTURE_ASSET_READ_DENIED');
      const bytes = await readPreparedChild(output, join('private-storage', key), expected ? 20 * 1024 * 1024 : 100 * 1024 * 1024);
      if (expected) requireCheck(sha256(bytes) === sha256(expected), 'SYNTHETIC_SOURCE_CHANGED_DURING_RUN');
      return expected ? Buffer.from(expected) : bytes;
    } });
    ctx = { userId: `live-evaluation:${runId}`, workspaceId, email: 'synthetic-evaluation@example.test', role: 'owner', authKind: 'development', scopes: [...ALL_SCOPES] };
    const sources = await syntheticLiveAISources();
    check('Five fixed synthetic screenshots are distinct and fully decoded', sources.length === 5 && new Set(sources.map(source => sha256(source.bytes))).size === 5);
    for (const source of sources) await verifyPng(source.bytes, source.width, source.height);
    let revision: any, projectId: string;
    if (args.mode === 'prepare') {
      await transaction(db, async client => {
        await client.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [workspaceId, `SYNTHETIC live AI evaluation ${runId}`]);
        await client.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, ctx!.userId]);
        await client.query("INSERT INTO subscriptions(workspace_id,plan_id,status) VALUES($1,'pro','active')", [workspaceId]);
        await client.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,10,'synthetic-evaluation',$3)", [randomUUID(), workspaceId, `live-evaluation:${runId}`]);
      });
      const { project } = await services.createProject(ctx, { name: `SYNTHETIC FocusBoard evaluation ${runId.slice(0, 8)}`, idempotencyKey: `evaluation-project:${runId}` });
      projectId = project.id;
      const assetIds: string[] = [];
      await mkdir(join(output, 'sources'));
      for (const source of sources) {
        const { asset } = await services.uploadAsset(ctx, projectId, source.name, source.bytes);
        fixedSources.set(`${workspaceId}/sources/${asset.id}.png`, source.bytes);
        assetIds.push(asset.id); await writeFile(join(output, 'sources', source.name), source.bytes, { mode: 0o600 });
      }
      const draft = await services.createDraft(ctx, { projectId, assetIds, brief: FIXTURE_BRIEF, templateId: 'tidal-relay', templateMode: 'exact', screenCount: 5, profile, locale: 'en', apply: true });
      const document = fixedManualDocument({ runId, projectId, assetIds });
      revision = (await services.saveRevision(ctx, projectId, { document, expectedRevisionId: draft.revision.id, apply: true, label: 'SYNTHETIC manual preparation — not AI generated' })).revision;
      prepared = { kind: 'appscreen-live-ai-prepared', version: 1, status: 'prepared-no-live-authorization', fixtureVersion: LIVE_AI_FIXTURE_VERSION, runId, workspaceId, projectId, revisionId: revision.id, documentSha256: documentHash(revision.document), sources: sourceEvidence(sources, assetIds), databaseFingerprint: database.fingerprint, rateCard: LIVE_AI_RATE_CARD, limits: LIVE_AI_LIMITS, preparedAt: new Date().toISOString() };
    } else {
      projectId = prepared.projectId;
      const workspace = await db.query('SELECT name FROM workspaces WHERE id=$1', [workspaceId]);
      requireCheck(workspace.rows[0]?.name === `SYNTHETIC live AI evaluation ${runId}`, 'SYNTHETIC_WORKSPACE_CHANGED');
      const project = await services.project(ctx, projectId);
      requireCheck(project.name === `SYNTHETIC FocusBoard evaluation ${runId.slice(0, 8)}` && project.activeRevisionId === prepared.revisionId, 'PREPARED_PROJECT_CHANGED');
      revision = await services.getRevision(ctx, projectId, prepared.revisionId);
      requireCheck(documentHash(revision.document) === prepared.documentSha256, 'PREPARED_DOCUMENT_CHANGED');
      requireCheck(canonicalJSON(prepared.sources) === canonicalJSON(sourceEvidence(sources, revision.document.sources.map((source: any) => source.assetId))), 'PREPARED_SYNTHETIC_SOURCES_CHANGED');
      const records = await db.query('SELECT id,storage_key,sha256,name FROM assets WHERE workspace_id=$1 AND project_id=$2 AND kind=\'source\' ORDER BY id', [workspaceId, projectId]);
      requireCheck(records.rowCount === 5, 'UNEXPECTED_SOURCE_ASSETS');
      for (const [index, source] of sources.entries()) {
        const expected = prepared.sources[index], record = records.rows.find(asset => asset.id === expected.assetId);
        requireCheck(record && record.name === source.name && record.sha256 === sha256(source.bytes), 'SYNTHETIC_ASSET_CHANGED');
        requireCheck(record.storage_key === `${workspaceId}/sources/${record.id}.png`, 'SYNTHETIC_STORAGE_KEY_CHANGED');
        fixedSources.set(record.storage_key, source.bytes);
        requireCheck(sha256(await services.storage.read(record.storage_key)) === sha256(source.bytes), 'SYNTHETIC_ASSET_BYTES_CHANGED');
        requireCheck(sha256(await readPreparedChild(output, join('sources', source.name), 20 * 1024 * 1024)) === sha256(source.bytes), 'SYNTHETIC_FIXTURE_FILE_CHANGED');
      }
      requireCheck((await db.query('SELECT count(*)::int AS count FROM agent_jobs WHERE workspace_id=$1', [workspaceId])).rows[0].count === 0, 'PREPARED_WORKSPACE_ALREADY_USED');
    }
    report.projectId = projectId; report.baseRevisionId = revision.id; report.sources = prepared.sources;
    assertFixedManualDocument(revision.document, { runId, projectId, assetIds: prepared.sources.map((source: any) => source.assetId) });
    assert.deepEqual(collectCampaignAssetIds(revision.document), prepared.sources.map((source: any) => source.assetId).sort());
    check('Prepared campaign independently matches the fixed synthetic factory and four handoffs', validateCampaign(revision.document).valid && revision.document.template.id === 'tidal-relay' && revision.document.template.mode === 'exact' && connectedFixtureGeometry(revision.document).handoffs.length === 4);
    renderer = createRenderer(services);
    const rendered = await renderer.render(revision.document);
    for (const scene of rendered.scenes) await verifyPng(scene.png, profile.width, profile.height);
    if (args.mode === 'prepare') {
      await mkdir(join(output, 'manual-preview'));
      for (const [index, scene] of rendered.scenes.entries()) await writeFile(join(output, 'manual-preview', `${String(index + 1).padStart(2, '0')}-en.png`), scene.png, { mode: 0o600 });
      await writeFile(join(output, 'manual-preview', 'contact-sheet.png'), rendered.contactSheet, { mode: 0o600 });
      await writeJSON(join(output, 'manual-document.json'), revision.document);
      await writeJSON(join(output, 'prepared.json'), prepared);
      report.status = 'prepared-offline'; report.completed = true; report.manualQa = rendered.issues;
      report.visualReview = { status: 'pending-review', contactSheet: join(output, 'manual-preview', 'contact-sheet.png'), originals: join(output, 'sources') };
      report.security.keyFileRead = false; report.providerRequests = 0;
      console.log(JSON.stringify({ status: report.status, runId, output, liveAuthorized: false, providerRequests: 0, keyFileRead: false }));
      return;
    }
    // All immutable preparation, database and renderer checks precede the
    // aggregate lock and atomic one-use claim. No credential is read until both
    // succeed; every paid generation additionally requires a durable hold.
    const budgetBinding = liveAIBudgetBinding(process.env);
    budgetLedger = await openLiveAIBudgetLedger({ ...budgetBinding, temporaryRoot: tmpdir(), runId,
      approvalSha256: sha256(canonicalJSON({ prepared, budgetBinding, totalBudgetMicroUsd: LIVE_AI_LIMITS.budgetMicroUsd, syntheticOnly: true })) });
    report.aggregateBudget = budgetLedger.snapshot();
    requireCheck(report.aggregateBudget.budgetMicroUsd === LIVE_AI_LIMITS.budgetMicroUsd, 'AGGREGATE_BUDGET_LIMIT_CHANGED');
    await reportWriter.claim(prepared);
    const keyBytes = await readBoundedFile(join(repository, '.env'), 1024 * 1024);
    const key = extractApprovedOpenAIKey(keyBytes); keyBytes.fill(0);
    report.security.keyFileRead = true; report.security.liveAuthorizationAssumed = false;
    const sdk = new OpenAI({ apiKey: key, baseURL: 'https://api.openai.com/v1', organization: null, project: null, maxRetries: 0, timeout: LIVE_AI_LIMITS.timeoutMs, logLevel: 'off', fetch: createApprovedOpenAIFetch(nativeFetch, () => { providerRequests++; }) });
    guard = createSpendGuard({ client: sdk, rateCard: LIVE_AI_RATE_CARD, ...LIVE_AI_LIMITS,
      reserveBeforeSubmit: async ({ call, reservedUpperBoundMicroUsd }: { call: number; reservedUpperBoundMicroUsd: number }) => {
        await budgetLedger!.reserve({ call, reservedUpperBoundMicroUsd });
        report.aggregateBudget = budgetLedger!.snapshot();
        await persist();
      },
    });
    const provider = createOpenAIProvider({ client: guard.client, model: LIVE_AI_RATE_CARD.model, maxOutputTokens: LIVE_AI_LIMITS.maxOutputTokens } as any);
    const observedProvider = { async generate(input: any) {
      report.phase = input.stage; report.spend = guard!.snapshot(); await persist();
      console.log(JSON.stringify({ phase: input.stage, providerRequests, runId }));
      try { return await provider.generate(input); }
      finally { report.spend = guard!.snapshot(); await persist(); }
    } };
    const engine = createAgentEngine({ provider: observedProvider, maxRepairRounds: 2, maxTotalTokens: 200_000 });
    config.allowLiveAI = true; config.openaiKey = key; config.openaiModel = LIVE_AI_RATE_CARD.model;
    const worker = createWorker(services, {} as any, { renderer, engine, deadlineMs: 600_000 });
    const beforeCredits = await services.credits(workspaceId);
    const jobRequest = { kind: 'design', projectId, idempotencyKey: `live-evaluation-design:${runId}`, input: { revisionId: revision.id, sourceIds: revision.document.sources.map((source: any) => source.id), brief: FIXTURE_BRIEF, templateMode: 'exact', templateId: 'tidal-relay', screenCount: 5, profile, locale: 'en' } };
    const queued = await services.createJob(ctx, jobRequest); jobId = queued.job.id; report.jobId = jobId;
    report.status = 'live-running'; report.creditsBefore = beforeCredits; await persist();
    await worker.run(jobId!);
    const job = row<any>((await db.query('SELECT * FROM agent_jobs WHERE id=$1 AND workspace_id=$2', [jobId, workspaceId])).rows[0]);
    report.jobStatus = job.status; report.phase = job.stage; report.jobErrorCode = job.error?.code || null;
    report.spend = guard.snapshot(); report.creditsAfter = await services.credits(workspaceId);
    report.checkpointStages = (await db.query('SELECT stage FROM agent_job_steps WHERE job_id=$1 ORDER BY stage', [jobId])).rows.map(record => record.stage);
    report.usage = (await db.query('SELECT data FROM usage_events WHERE job_id=$1 ORDER BY created_at', [jobId])).rows.map(({ data }) => ({ stage: data.stage, responseId: data.responseId, inputTokens: data.input_tokens ?? null, outputTokens: data.output_tokens ?? null, totalTokens: data.total_tokens ?? null }));
    requireCheck(['ready', 'needs-input'].includes(job.status) && !!job.result?.revisionId, 'LIVE_JOB_DID_NOT_DELIVER');
    const delivered = await services.getRevision(ctx, projectId, job.result.revisionId);
    check('Delivered document validates and preserves five synthetic sources', validateCampaign(delivered.document).valid && delivered.document.scenes.length === 5 && canonicalJSON(delivered.document.sources) === canonicalJSON(revision.document.sources));
    assert.deepEqual(collectCampaignAssetIds(delivered.document), prepared.sources.map((source: any) => source.assetId).sort());
    check('Exact-template layout is retained and each connected device shares its border', canonicalJSON(connectedFixtureGeometry(delivered.document)) === canonicalJSON(connectedFixtureGeometry(revision.document)));
    check('AI draft did not overwrite the approved manual base', (await services.project(ctx, projectId)).activeRevisionId === revision.id);
    const files = new Map<string, Buffer>();
    await mkdir(join(output, 'live-result'));
    for (const artifact of [...job.result.artifacts, job.result.contactSheet]) {
      const asset = await services.asset(ctx, artifact.assetId), bytes = await services.storage.read(asset.storageKey);
      requireCheck(/^[a-zA-Z0-9_.-]+$/.test(asset.name), 'ARTIFACT_NAME_INVALID');
      check(`Artifact ${asset.name} matches persisted checksum`, bytes.length === Number(asset.byteSize) && sha256(bytes) === asset.sha256);
      files.set(asset.name, bytes); await writeFile(join(output, 'live-result', asset.name), bytes, { mode: 0o600 });
      report.artifacts.push({ name: asset.name, assetId: asset.id, bytes: bytes.length, sha256: sha256(bytes) });
      if (/^\d\d-en\.png$/.test(asset.name)) await verifyPng(bytes, profile.width, profile.height);
    }
    const pngNames = Array.from({ length: 5 }, (_, index) => `${String(index + 1).padStart(2, '0')}-en.png`);
    check('All five store PNGs, contact sheet, ZIP and editable backup exist', pngNames.every(name => files.has(name)) && ['contact-sheet.png', 'campaign.zip', 'editable-project.zip'].every(name => files.has(name)));
    const zip = await JSZip.loadAsync(files.get('campaign.zip')!, { checkCRC32: true });
    assert.deepEqual(Object.keys(zip.files).sort(), [...pngNames, 'manifest.json'].sort());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(manifest.revisionId, delivered.id); assert.deepEqual(manifest.profile, profile);
    assert.deepEqual(manifest.screens.map((item: any) => ({ sceneId: item.sceneId, file: item.file })), delivered.document.scenes.map((scene: any, index: number) => ({ sceneId: scene.id, file: pngNames[index] })));
    for (const name of pngNames) assert.equal(sha256(await zip.file(name)!.async('nodebuffer')), sha256(files.get(name)!));
    const backup = await JSZip.loadAsync(files.get('editable-project.zip')!, { checkCRC32: true });
    const project = JSON.parse(await backup.file('project.json')!.async('string'));
    check('Editable backup stores the exact valid AI document', project.format === 'appscreen-campaign' && project.version === 1 && validateCampaign(project.document).valid && canonicalJSON(project.document) === canonicalJSON(delivered.document));
    assert.equal(project.assets.length, 5); assert.equal(Object.keys(backup.files).length, 6);
    for (const asset of project.assets) {
      const index = prepared.sources.findIndex((source: any) => source.assetId === asset.id); assert.ok(index >= 0);
      assert.equal(sha256(await backup.file(asset.file)!.async('nodebuffer')), sha256(sources[index].bytes));
    }
    check('ZIP CRCs, ordering and five original image bytes verify', true);
    const callsBeforeReplay = providerRequests, spendBeforeReplay = canonicalJSON(guard.snapshot());
    const replayed = await services.createJob(ctx, jobRequest); assert.equal(replayed.job.id, jobId);
    await worker.run(jobId!);
    check('Identical admission and terminal replay make no additional model requests', providerRequests === callsBeforeReplay && canonicalJSON(guard.snapshot()) === spendBeforeReplay);
    assert.deepEqual(await services.credits(workspaceId), report.creditsAfter);
    check('The single design settles once without extra replay charges', report.creditsAfter.reserved === 0 && report.creditsAfter.available === beforeCredits.available - config.designCredits && (await db.query("SELECT count(*)::int AS count FROM credit_ledger WHERE workspace_id=$1 AND reference=$2", [workspaceId, `job:${jobId}`])).rows[0].count === 1);
    await writeJSON(join(output, 'live-result', 'document.json'), delivered.document);
    await writeJSON(join(output, 'live-result', 'qa.json'), job.result.qa);
    report.completed = true; report.status = job.status === 'ready' ? 'live-delivered-awaiting-visual-review' : 'live-delivered-review-needed';
    report.visualReview = { status: 'pending-review', contactSheet: join(output, 'live-result', 'contact-sheet.png'), originals: join(output, 'sources') };
    console.log(JSON.stringify({ status: report.status, runId, jobId, output, providerRequests, budgetMicroUsd: LIVE_AI_LIMITS.budgetMicroUsd, actualInvoiceCostUsd: null }));
  } catch (error: any) {
    report.status = args.mode === 'live' ? 'live-stopped-no-automatic-retry' : 'preparation-failed';
    report.failure = { code: /^[A-Z_]{2,80}$/.test(error?.code || '') ? error.code : 'REHEARSAL_FAILED' };
    if (guard) report.spend = guard.snapshot();
    if (jobId && services && ctx) {
      report.creditsAfter = await services.credits(ctx.workspaceId).catch(() => null);
      report.checkpointStages = (await db.query('SELECT stage FROM agent_job_steps WHERE job_id=$1 ORDER BY stage', [jobId]).catch(() => ({ rows: [] }))).rows.map(record => record.stage);
    }
    console.error(JSON.stringify({ status: report.status, code: report.failure.code, output, runId: report.runId || null, jobId: jobId || null, providerRequests }));
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); report.providerRequests = providerRequests; report.deniedFetches = deniedFetches;
    if (budgetLedger) {
      try { await budgetLedger.close(); report.budgetCloseStatus = 'closed'; }
      catch {
        report.budgetCloseStatus = 'blocked-uncertain'; report.completed = false;
        report.status = 'live-budget-close-uncertain'; process.exitCode = 1;
      }
      report.aggregateBudget = budgetLedger.snapshot();
    }
    try { await persist(); }
    finally {
      try { await renderer?.close(); }
      finally {
        try { if (server) await new Promise<void>(done => server!.close(() => done())); }
        finally { try { await db.end(); } finally { globalThis.fetch = nativeFetch; } }
      }
    }
  }
}
main().catch(() => { console.error('LIVE_AI_REHEARSAL_GUARD_FAILED'); process.exitCode = 1; });
