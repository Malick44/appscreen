// Opt-in, local capacity rehearsal; deliberately excluded from *.test.ts.
// TEST_DATABASE_URL=postgresql://...@127.0.0.1:.../appscreen_test \
//   npx tsx server/tests/render-capacity-smoke.ts
// Uses four real worker exports (before/after copy-only refinement, backup first
// then store ZIP for each revision), ten explicitly
// synthetic sources, current migrations, private temporary storage and sandboxed
// Chromium. Never starts the queue, loads .env, calls AI/billing or deletes data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import sharp from 'sharp';
import { resolveDevice, validateCampaign } from '../../core/campaign.mjs';
import { ALL_SCOPES, hash, type Context } from '../auth.js';
import { loadConfig } from '../config.js';
import { createDatabase, transaction, verifyMigrations } from '../db.js';
import { createRenderer, isAllowedRenderRequest } from '../render-service.js';
import { AppServices } from '../services.js';
import { createStorage } from '../storage.js';
import { createWorker } from '../worker.js';

const ps = promisify(execFile);
const profile = { id: 'iphone-6.9', width: 1320, height: 2868 };
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const palette = ['#C85435', '#A65493', '#7152C6', '#475ECB', '#2472BE', '#14796C', '#547723', '#AB671E', '#B84562', '#7D6388'];
type FileEvidence = { name: string; assetId: string; bytes: number; sha256: string; width: number; height: number; kind: string };
type ProcessSample = { elapsedMs: number; phase: string; nodeRssBytes: number; nodeHeapUsedBytes: number; nodeExternalBytes: number; nodeArrayBufferBytes: number; chromiumRssSumBytes: number; chromiumProcesses: number; measuredRssSumBytes: number };

function memorySampler(currentPhase: () => string) {
  const started = performance.now(), samples: ProcessSample[] = [], errors: string[] = [];
  let sampling: Promise<void> | undefined;
  async function take() {
    const node = process.memoryUsage();
    try {
      // Only pid/ppid/RSS/executable names are read: never process arguments or
      // environments. Sum only Chromium descendants of THIS rehearsal process.
      const result = await ps('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
      const rows = result.stdout.split('\n').flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]) * 1024, command: match[4] }] : [];
      });
      const descendants = new Set([process.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
      }
      const chromium = rows.filter(row => descendants.has(row.pid) && /chrom(?:e|ium)|headless_shell/i.test(row.command));
      const chromiumRssSumBytes = chromium.reduce((sum, row) => sum + row.rss, 0);
      samples.push({ elapsedMs: Math.round(performance.now() - started), phase: currentPhase(), nodeRssBytes: node.rss, nodeHeapUsedBytes: node.heapUsed, nodeExternalBytes: node.external, nodeArrayBufferBytes: node.arrayBuffers, chromiumRssSumBytes, chromiumProcesses: chromium.length, measuredRssSumBytes: node.rss + chromiumRssSumBytes });
    } catch { errors.push('A process-RSS sample could not be collected.'); }
  }
  const sample = () => sampling ??= take().finally(() => { sampling = undefined; });
  const timer = setInterval(() => { void sample(); }, 250);
  timer.unref();
  const summarize = (selected: ProcessSample[]) => ({ samples: selected.length, peakNodeRssBytes: Math.max(0, ...selected.map(s => s.nodeRssBytes)), peakChromiumRssSumBytes: Math.max(0, ...selected.map(s => s.chromiumRssSumBytes)), peakMeasuredRssSumBytes: Math.max(0, ...selected.map(s => s.measuredRssSumBytes)), peakChromiumProcesses: Math.max(0, ...selected.map(s => s.chromiumProcesses)) });
  return {
    sample,
    async stop() {
      clearInterval(timer); await sampling; await take();
      return {
        method: '250 ms attempted samples of this Node process and its descendant Chromium processes using ps RSS; subprocess sampling time is not zero.',
        caveats: ['Sampled peaks may miss brief spikes.', 'Summed RSS double-counts shared pages; this is not PSS, a container cgroup peak or a production memory requirement.', 'Node RSS includes Sharp/libvips, archive buffers and this rehearsal instrumentation.', 'Database, local HTTP clients in other processes, other running apps, the OS and filesystem cache are outside this measurement.', 'Chromium process names identify only descendants of this rehearsal; unrelated user browsers are excluded.'],
        errors, ...summarize(samples), byPhase: Object.fromEntries([...new Set(samples.map(s => s.phase))].map(phase => [phase, summarize(samples.filter(s => s.phase === phase))])), samples,
      };
    },
  };
}

async function syntheticSource(index: number) {
  const n = String(index + 1).padStart(2, '0'), color = palette[index];
  const rows = [0, 1, 2, 3, 4, 5].map(row => `<rect x="96" y="${660 + row * 280}" width="1128" height="222" rx="28" fill="${color}"/><text x="140" y="${752 + row * 280}" font-size="58" font-weight="700" fill="white">SYNTHETIC ${n} / ${row + 1}</text><text x="140" y="${820 + row * 280}" font-size="35" fill="white">Capacity fixture - no real app or customer data</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="2868"><rect width="1320" height="2868" fill="#162333"/><g font-family="sans-serif"><rect x="0" y="0" width="1320" height="142" fill="${color}"/><text x="96" y="96" fill="white" font-size="45" font-weight="700">SYNTHETIC SCREEN ${n}</text><text x="96" y="312" fill="#F0F4FC" font-size="112" font-weight="700">Fixture ${n}</text><text x="96" y="412" fill="#BCC9DB" font-size="44">Render, continuity and export rehearsal</text><rect x="96" y="486" width="1128" height="98" rx="28" fill="#283A50"/><text x="142" y="552" fill="#D9E4F3" font-size="39">Distinct source ${n} / ten-screen campaign</text>${rows}<text x="96" y="2580" fill="#BCC9DB" font-size="44">NOT A CUSTOMER SCREENSHOT</text><text x="96" y="2660" fill="#BCC9DB" font-size="40">Synthetic test fixture ${n}</text><rect x="440" y="2778" width="440" height="16" rx="8" fill="#BCC9DB"/></g></svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: '#162333' }).removeAlpha().png().toBuffer();
}

async function verifyPng(bytes: Buffer, width: number, height: number, requireNoAlpha = true) {
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  if (requireNoAlpha) assert.equal(metadata.hasAlpha, false);
  // Decode all pixels, not only the header; truncated/corrupt IDAT must fail.
  const { data, info } = await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data.length, width * height * info.channels);
  assert.ok(info.channels === 3 || (!requireNoAlpha && info.channels === 4));
  if (info.channels === 4) for (let p = 3; p < data.length; p += 4) assert.equal(data[p], 255, 'Preview pixels must still be fully opaque.');
  return data;
}

async function validateCampaignZip(bytes: Buffer, document: any, revisionId: string, files: Map<string, Buffer>) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = [...files.keys()].sort();
  assert.deepEqual(Object.keys(zip.files).sort(), [...names, 'manifest.json'].sort());
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  assert.equal(manifest.version, 1); assert.equal(manifest.revisionId, revisionId);
  assert.deepEqual(manifest.profile, profile); assert.equal(manifest.locale, 'en');
  assert.deepEqual(manifest.sourceAssetIds, document.sources.map((source: any) => source.assetId).sort());
  assert.deepEqual(manifest.screens, document.scenes.map((scene: any, index: number) => ({ sceneId: scene.id, file: `${String(index + 1).padStart(2, '0')}-en.png`, width: profile.width, height: profile.height })));
  for (const name of names) assert.equal(hash(await zip.file(name)!.async('nodebuffer')), hash(files.get(name)!));
  for (const entry of Object.values(zip.files)) assert.equal(entry.date.toISOString(), '2000-01-01T00:00:00.000Z');
  return manifest;
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL || '';
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to an already migrated loopback test database.');
  const dbAddress = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(dbAddress.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(dbAddress.hostname), 'Only a literal loopback database address is allowed.');
  assert.match(decodeURIComponent(dbAddress.pathname), /(?:^|[_/-])test(?:[_/-]|$)/, 'Use a dedicated test database, never the development or production database.');
  assert.equal(dbAddress.search, '', 'Connection-option overrides are not allowed in this rehearsal.');
  const output = await mkdtemp(join(tmpdir(), 'appscreen-ten-screen-'));
  const started = performance.now(), runId = randomUUID(), workspaceId = randomUUID();
  let phase = 'setup';
  const report: any = {
    version: 1, runId, output, startedAt: new Date().toISOString(), completed: false,
    environment: { productionMeasurement: false, platform: platform(), release: release(), architecture: arch(), node: process.version, cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, hostTotalMemoryBytes: totalmem(), database: decodeURIComponent(dbAddress.pathname).slice(1), databaseTransport: 'literal loopback only', sources: 'ten explicitly labelled synthetic PNG fixtures; no customer captures', storage: 'new temporary directory retained after run', queue: 'not started; only the four newly created job IDs are run directly' },
    security: { chromiumSandbox: true, dotenvLoaded: false, aiEnabled: false, billingEnabled: false, oauthEnabled: false, externalFetchAttempts: 0, rendererRequestPolicy: 'unmodified production allowlist: only bundled renderer files from this ephemeral loopback server' },
    limits: { screens: 10, width: profile.width, height: profile.height, renderedPixelsPerJob: 10 * profile.width * profile.height, rendererDeadlineMs: 120_000, workerDeadlineMs: 600_000, jobsSequential: 4, queueLocalConcurrency: 1, configuredWorkspaceConcurrentAdmission: 2, configuredWorkspaceStorageBytes: 524_288_000, configuredSourceUploadLimitBytes: 20_971_520, configuredMaxImagePixels: 40_000_000, performancePassThreshold: null },
    limitations: ['This is one local rehearsal, not Linux/container, production, concurrency, queue recovery, S3 latency, worst-case source entropy, live-AI quality or load testing.', 'No elapsed-time or memory acceptance threshold has been approved; timings and sampled RSS are evidence, not an SLA.', 'Export integrity is automatic; human visual review of the retained contact sheet and detailed seam crops remains required.'],
    checks: [], jobs: [], sources: [], http: { requests: 0, denied: [], failed: [] }, workspaceId,
  };
  const check = (name: string, value: boolean, details?: unknown) => { report.checks.push({ name, pass: value, ...(details === undefined ? {} : { details }) }); assert.ok(value, name); };
  console.log(`Synthetic ten-screen export rehearsal: ${output}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { report.security.externalFetchAttempts++; throw new Error('Network fetch is disabled in this synthetic export rehearsal.'); };
  const db = createDatabase(databaseUrl);
  let http: Server | undefined, renderer: ReturnType<typeof createRenderer> | undefined;
  const memory = memorySampler(() => phase);
  try {
    await verifyMigrations(db);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: join(output, 'private-storage'), APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMBEDDED_WORKER: 'false' });
    assert.equal(config.allowLiveAI, false); assert.equal(config.enableBilling, false); assert.equal(config.openaiKey, ''); assert.equal(config.supabaseServiceKey, ''); assert.equal(config.mcpOAuthEnabled, false);
    const mime: Record<string, string> = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    http = createServer(async (request, response) => {
      report.http.requests++;
      const path = new URL(request.url || '/', config.baseUrl).pathname;
      if (!['GET', 'HEAD'].includes(request.method || '') || !isAllowedRenderRequest(new URL(request.url || '/', config.baseUrl).href, config.baseUrl)) { report.http.denied.push(path); response.writeHead(404).end(); return; }
      try { const data = await readFile(resolve(repository, `.${path}`)); response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(request.method === 'HEAD' ? undefined : data); }
      catch { report.http.failed.push(path); response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    config.baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const services = new AppServices(db, config, createStorage(config));
    const ctx: Context = { userId: `capacity:${runId}`, workspaceId, email: 'capacity-rehearsal@example.test', role: 'owner', authKind: 'development', scopes: [...ALL_SCOPES] };
    await transaction(db, async client => {
      await client.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [workspaceId, `Synthetic ten-screen rehearsal ${runId.slice(0, 8)}`]);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, ctx.userId]);
      await client.query("INSERT INTO subscriptions(workspace_id,plan_id,status) VALUES($1,'pro','active')", [workspaceId]);
    });
    const { project } = await services.createProject(ctx, { name: 'SYNTHETIC - ten-screen capacity rehearsal', idempotencyKey: `capacity-project:${runId}` });
    report.projectId = project.id;
    const sourceBytes = new Map<string, Buffer>();
    await mkdir(join(output, 'sources'));
    phase = 'source-preparation';
    for (let index = 0; index < 10; index++) {
      const bytes = await syntheticSource(index), name = `synthetic-source-${String(index + 1).padStart(2, '0')}.png`;
      const { asset } = await services.uploadAsset(ctx, project.id, name, bytes);
      sourceBytes.set(asset.id, bytes); await writeFile(join(output, 'sources', name), bytes, { mode: 0o600 });
      report.sources.push({ index: index + 1, assetId: asset.id, name, bytes: bytes.length, sha256: hash(bytes), width: profile.width, height: profile.height, markerColor: palette[index] });
    }
    check('All ten uploaded source images are distinct', new Set(report.sources.map((source: any) => source.sha256)).size === 10);
    const draft = await services.createDraft(ctx, { projectId: project.id, assetIds: [...sourceBytes.keys()], templateId: 'tidal-relay', templateMode: 'exact', screenCount: 10, profile, locale: 'en', apply: true });
    const document = structuredClone(draft.revision.document);
    document.scenes.forEach((scene: any, index: number) => {
      scene.text.headlines.en = `Synthetic ${String(index + 1).padStart(2, '0')}\nConnected screens`;
      scene.text.headlineSize = 88;
      scene.text.subheadlineEnabled = false;
    });
    check('Ten-screen exact Tidal Relay campaign validates', validateCampaign(document).valid && document.scenes.length === 10 && document.sources.length === 10);
    const connections = [];
    for (let index = 0; index < document.scenes.length - 1; index++) {
      const left = document.scenes[index], right = document.scenes[index + 1];
      const shared = left.devices.filter((device: any) => right.devices.some((next: any) => next.groupId === device.groupId));
      check(`Screens ${index + 1}/${index + 2} have one shared overflow device`, shared.length === 1);
      const a = resolveDevice(document, left.id, shared[0].id), b = resolveDevice(document, right.id, right.devices.find((device: any) => device.groupId === shared[0].groupId).id);
      check(`Screens ${index + 1}/${index + 2} preserve canonical geometry and border`, Math.abs(a.centerX - b.centerX - 1) < 1e-9 && a.centerY === b.centerY && a.scale === b.scale && a.rotation === b.rotation && a.sourceId === b.sourceId && a.appearanceGroupId === b.appearanceGroupId && JSON.stringify(a.frame) === JSON.stringify(b.frame) && a.frame.enabled);
      connections.push({ leftScreen: index + 1, rightScreen: index + 2, groupId: a.groupId, sourceId: a.sourceId, frame: a.frame });
    }
    report.connections = connections;
    const saved = await services.saveRevision(ctx, project.id, { document, expectedRevisionId: draft.revision.id, apply: true, label: 'Synthetic ten-screen continuity fixture' });
    report.revisionId = saved.revision.id;
    await writeFile(join(output, 'campaign-document.json'), JSON.stringify(saved.revision.document, null, 2), { mode: 0o600 });
    const actualRenderer = createRenderer(services); renderer = actualRenderer;
    let activeJob: any;
    const observedRenderer: ReturnType<typeof createRenderer> = {
      async render(doc, options) {
        const start = performance.now();
        const rendered = await actualRenderer.render(doc, options);
        activeJob.rendererDurationMs = Math.round(performance.now() - start);
        activeJob.rendererPngBytes = rendered.scenes.reduce((sum, scene) => sum + scene.png.length, 0);
        return rendered;
      },
      close: () => actualRenderer.close(),
    };
    const worker = createWorker(services, {} as any, { renderer: observedRenderer });
    const exports = new Map<string, { files: Map<string, Buffer>; artifacts: FileEvidence[]; zip?: Buffer; backup?: Buffer; contactSheet: Buffer }>();
    async function runExport(format: 'project' | 'zip', label: string, revision: any) {
      phase = report.jobs.length === 0 ? 'cold-backup-export' : label === 'zip' ? 'warm-store-export' : label;
      activeJob = { format, label, revisionId: revision.id, browser: report.jobs.length === 0 ? 'cold launch' : 'reused browser/new page', phase, artifacts: [] };
      report.jobs.push(activeJob);
      const start = performance.now();
      const { job: queued } = await services.createJob(ctx, { kind: 'export', projectId: project.id, idempotencyKey: `capacity-${label}:${runId}`, input: { revisionId: revision.id, format } });
      activeJob.jobId = queued.id;
      await memory.sample();
      await worker.run(queued.id);
      activeJob.jobDurationMs = Math.round(performance.now() - start);
      const { job } = await services.getJob(ctx, { jobId: queued.id });
      activeJob.status = job.status; activeJob.qa = job.result?.qa; activeJob.error = job.error;
      check(`${format} real worker job produced a terminal result`, ['ready', 'needs-input'].includes(job.status), job.error || job.status);
      check(`${label} export preserved the requested revision and ten scenes`, job.result.revisionId === revision.id && job.result.previews.length === 10);
      check(`${format} renderer reports no error-severity QA issues`, !(job.result.qa?.issues || []).some((issue: any) => issue.severity === 'error'), job.result.qa);
      const path = join(output, label); await mkdir(path);
      const files = new Map<string, Buffer>(), evidence: FileEvidence[] = [];
      let zip: Buffer | undefined, backup: Buffer | undefined, contactSheet: Buffer | undefined;
      const artifacts = [...job.result.artifacts, job.result.contactSheet];
      for (const artifact of artifacts) {
        const asset = await services.asset(ctx, artifact.assetId), bytes = await services.storage.read(asset.storageKey);
        check(`${format}/${asset.name} matches persisted bytes and SHA-256`, bytes.length === Number(asset.byteSize) && hash(bytes) === asset.sha256);
        await writeFile(join(path, asset.name), bytes, { mode: 0o600 });
        evidence.push({ name: asset.name, assetId: asset.id, bytes: bytes.length, sha256: hash(bytes), width: asset.width, height: asset.height, kind: artifact.kind });
        if (/^\d\d-en\.png$/.test(asset.name)) {
          const pixels = await verifyPng(bytes, profile.width, profile.height), index = Number(asset.name.slice(0, 2)) - 1;
          const rgb = palette[index].slice(1).match(/../g)!.map(hex => parseInt(hex, 16));
          let markerPixels = 0;
          for (let p = 0; p < pixels.length; p += 3) if (pixels[p] === rgb[0] && pixels[p + 1] === rgb[1] && pixels[p + 2] === rgb[2]) markerPixels++;
          check(`${format}/${asset.name} visibly contains its distinct source marker`, markerPixels > 1000, { markerPixels });
          files.set(asset.name, bytes);
        } else if (asset.name === 'campaign.zip') zip = bytes;
        else if (asset.name === 'editable-project.zip') backup = bytes;
        else if (asset.name === 'contact-sheet.png') contactSheet = bytes;
      }
      check(`${format} contains exactly ten ordered opaque store PNGs`, files.size === 10 && [...files.keys()].join(',') === Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, '0')}-en.png`).join(','));
      check(`${format} contact sheet exists`, !!contactSheet);
      // Contact sheets are previews, not store-upload images: the renderer may
      // retain an all-opaque alpha channel after composition. Store PNGs above
      // must have no alpha channel at all.
      await verifyPng(contactSheet!, 2772, 598, false);
      activeJob.artifacts = evidence; activeJob.persistedBytes = evidence.reduce((sum, file) => sum + file.bytes, 0);
      exports.set(label, { files, artifacts: evidence, zip, backup, contactSheet: contactSheet! });
      console.log(`${label}: ${activeJob.jobDurationMs} ms job / ${activeJob.rendererDurationMs} ms renderer; ${activeJob.persistedBytes} persisted bytes; status=${job.status}`);
    }
    await runExport('project', 'project', saved.revision);
    await runExport('zip', 'zip', saved.revision);
    phase = 'archive-verification';
    const projectExport = exports.get('project')!, storeExport = exports.get('zip')!;
    check('Backup exists before the store ZIP is created', !!projectExport.backup && !projectExport.zip && !!storeExport.zip && !storeExport.backup);
    for (const [name, bytes] of storeExport.files) check(`${name} pixels are deterministic across cold and warm worker exports`, hash(bytes) === hash(projectExport.files.get(name)!));
    check('Contact sheet is deterministic across both exports', hash(projectExport.contactSheet) === hash(storeExport.contactSheet));
    report.manifest = await validateCampaignZip(storeExport.zip!, saved.revision.document, saved.revision.id, storeExport.files);
    check('Store ZIP CRCs, manifest order, dimensions, timestamps and PNG checksums verify', true);
    const backup = await JSZip.loadAsync(projectExport.backup!, { checkCRC32: true });
    const restored = JSON.parse(await backup.file('project.json')!.async('string'));
    check('Editable backup contains the complete valid campaign document', restored.format === 'appscreen-campaign' && restored.version === 1 && validateCampaign(restored.document).valid && JSON.stringify(restored.document) === JSON.stringify(saved.revision.document));
    check('Editable backup contains exactly ten original assets and project metadata', restored.assets.length === 10 && Object.keys(backup.files).length === 11);
    for (const asset of restored.assets) check(`Backup original ${asset.id} matches uploaded SHA-256`, sourceBytes.has(asset.id) && hash(await backup.file(asset.file)!.async('nodebuffer')) === hash(sourceBytes.get(asset.id)!));
    // Verify that the verifier itself rejects missing, reordered and changed
    // output. Mutations exist only in memory; delivered exports stay untouched.
    const missing = await JSZip.loadAsync(storeExport.zip!); missing.remove('04-en.png');
    await assert.rejects(validateCampaignZip(await missing.generateAsync({ type: 'nodebuffer' }), saved.revision.document, saved.revision.id, storeExport.files));
    check('Archive verification rejects missing PNG output', true);
    const reordered = await JSZip.loadAsync(storeExport.zip!), wrongManifest = structuredClone(report.manifest);
    wrongManifest.screens.reverse(); reordered.file('manifest.json', JSON.stringify(wrongManifest));
    await assert.rejects(validateCampaignZip(await reordered.generateAsync({ type: 'nodebuffer' }), saved.revision.document, saved.revision.id, storeExport.files));
    check('Archive verification rejects a reordered manifest', true);
    const changed = await JSZip.loadAsync(storeExport.zip!); changed.file('01-en.png', storeExport.files.get('02-en.png')!);
    await assert.rejects(validateCampaignZip(await changed.generateAsync({ type: 'nodebuffer' }), saved.revision.document, saved.revision.id, storeExport.files));
    check('Archive verification rejects a substituted PNG', true);
    await assert.rejects(verifyPng(storeExport.files.get('01-en.png')!.subarray(0, 120), profile.width, profile.height));
    check('Pixel verification rejects a truncated PNG', true);
    phase = 'copy-only-refinement';
    const bottomCaptions = ['Focus', 'Create', 'Share'];
    let bottomIndex = 0;
    const operations = saved.revision.document.scenes.flatMap((scene: any) => scene.text.position === 'bottom' ? [{ op: 'update_text', sceneId: scene.id, patch: { headlines: { en: bottomCaptions[bottomIndex++] }, headlineSize: 80 } }] : []);
    const refined = await services.applyOperations(ctx, { projectId: project.id, baseRevisionId: saved.revision.id, operations, idempotencyKey: `capacity-copy-refinement:${runId}` });
    await services.applyRevision(ctx, { projectId: project.id, revisionId: refined.revision.id, expectedRevisionId: saved.revision.id, idempotencyKey: `capacity-apply-refinement:${runId}` });
    const withoutText = (document: any) => { const cloned = structuredClone(document); delete cloned.revision; delete cloned.revisionId; cloned.scenes.forEach((scene: any) => { delete scene.text; }); return cloned; };
    check('Direct copy refinement preserves exact-template device geometry, source order, backgrounds, borders and locks', JSON.stringify(withoutText(saved.revision.document)) === JSON.stringify(withoutText(refined.revision.document)) && refined.revision.document.template.mode === 'exact');
    report.refinement = { reason: 'The baseline deliberately tests two-line copy. Review warnings and images remain intact. Bottom captions are shortened to the single words “Focus”, “Create” and “Share” at 80 px instead of two lines at 88 px; no device or appearance changes are allowed. An earlier visual review rejected intermediate “Synthetic NN” and “Screen NN” captions which the old whole-line bounding-box check missed. The separate ink-contact regression now detects “Synthetic 02” touching the incoming device. These are synthetic caption fixtures, not verified product claims or an AI-authored campaign.', operations, beforeRevisionId: saved.revision.id, afterRevisionId: refined.revision.id, beforeQa: report.jobs[1].qa };
    await writeFile(join(output, 'refined-campaign-document.json'), JSON.stringify(refined.revision.document, null, 2), { mode: 0o600 });
    await runExport('project', 'refined-project', refined.revision);
    await runExport('zip', 'refined-zip', refined.revision);
    const refinedProject = exports.get('refined-project')!, refinedStore = exports.get('refined-zip')!;
    report.refinement.afterQa = report.jobs[3].qa;
    report.refinement.manifest = await validateCampaignZip(refinedStore.zip!, refined.revision.document, refined.revision.id, refinedStore.files);
    check('Refined store ZIP CRCs, order, manifest dimensions and PNG checksums verify', true);
    for (const [name, bytes] of refinedStore.files) check(`Refined ${name} is deterministic across both real exports`, hash(bytes) === hash(refinedProject.files.get(name)!));
    const refinedArchive = await JSZip.loadAsync(refinedProject.backup!, { checkCRC32: true }), refinedBackup = JSON.parse(await refinedArchive.file('project.json')!.async('string'));
    check('Refined editable backup stores the exact copy-only revision and all ten originals', refinedBackup.format === 'appscreen-campaign' && refinedBackup.version === 1 && validateCampaign(refinedBackup.document).valid && JSON.stringify(refinedBackup.document) === JSON.stringify(refined.revision.document) && refinedBackup.assets.length === 10 && Object.keys(refinedArchive.files).length === 11);
    for (const asset of refinedBackup.assets) check(`Refined backup original ${asset.id} retains its uploaded checksum`, sourceBytes.has(asset.id) && hash(await refinedArchive.file(asset.file)!.async('nodebuffer')) === hash(sourceBytes.get(asset.id)!));
    phase = 'visual-review-artifacts';
    for (const [name, exported] of [['contact-sheet-grid.png', storeExport], ['refined-contact-sheet-grid.png', refinedStore]] as const) {
      const tiles = await Promise.all([...exported.files.values()].map(bytes => sharp(bytes).resize(264, 574).toBuffer()));
      const grid = await sharp({ create: { width: 1392, height: 1184, channels: 3, background: '#111422' } }).composite(tiles.map((input, index) => ({ input, left: 12 + index % 5 * 276, top: 12 + Math.floor(index / 5) * 586 }))).png().toBuffer();
      await writeFile(join(output, name), grid, { mode: 0o600 });
    }
    const ordered = [...refinedStore.files.values()];
    await mkdir(join(output, 'seams'));
    for (let index = 0; index < ordered.length - 1; index++) {
      const left = await sharp(ordered[index]).extract({ left: 1120, top: 0, width: 200, height: 2868 }).toBuffer();
      const right = await sharp(ordered[index + 1]).extract({ left: 0, top: 0, width: 200, height: 2868 }).toBuffer();
      await sharp({ create: { width: 400, height: 2868, channels: 3, background: '#111422' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: 200, top: 0 }]).png().toFile(join(output, 'seams', `${String(index + 1).padStart(2, '0')}-${String(index + 2).padStart(2, '0')}.png`));
    }
    report.visualReview = { status: 'pending-human-review', beforeContactSheet: join(output, 'contact-sheet-grid.png'), refinedContactSheet: join(output, 'refined-contact-sheet-grid.png'), unmodifiedRendererContactSheet: join(output, 'refined-zip', 'contact-sheet.png'), seamCrops: join(output, 'seams') };
    check('Copy-only refinement clears automated QA in both real worker exports', report.jobs.slice(2).every((job: any) => job.status === 'ready' && job.qa.issues.length === 0));
    const usage = await db.query('SELECT count(*)::integer AS events FROM usage_events WHERE workspace_id=$1', [workspaceId]);
    check('No AI usage events or credits spent', usage.rows[0].events === 0 && (await services.credits(workspaceId)).totalGranted === 0 && (await services.credits(workspaceId)).available === 0);
    check('No fetch, external provider or missing render-file attempt occurred', report.security.externalFetchAttempts === 0 && report.http.failed.length === 0 && report.http.denied.length === 0);
    const stored = await db.query('SELECT count(*)::integer AS files, sum(byte_size)::bigint AS bytes FROM assets WHERE workspace_id=$1', [workspaceId]);
    report.storage = { persistedFiles: stored.rows[0].files, persistedBytes: Number(stored.rows[0].bytes), quotaBytes: config.maxStorageBytes, originalBytes: report.sources.reduce((sum: number, source: any) => sum + source.bytes, 0) };
    report.completed = true;
  } catch (error: any) {
    report.failure = { name: error?.name || 'Error', message: String(error?.message || 'Rehearsal failed').slice(0, 1800), phase };
    throw error;
  } finally {
    phase = 'cleanup';
    await renderer?.close().catch(() => {});
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    await db.end();
    report.memory = await memory.stop();
    report.completedAt = new Date().toISOString(); report.totalDurationMs = Math.round(performance.now() - started);
    report.evidencePolicy = 'All temporary files and isolated synthetic database rows are retained. No existing project, development server, queue or provider configuration was modified.';
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    globalThis.fetch = originalFetch;
    console.log(`Report: ${join(output, 'report.json')} (${report.checks.filter((check: any) => check.pass).length}/${report.checks.length} checks; completed=${report.completed})`);
  }
}

await main();
