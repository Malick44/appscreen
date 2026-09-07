import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createCampaign, applyOperations } from '../../core/campaign.mjs';
import { collectCampaignAssetIds, createRenderer, isAllowedRenderRequest } from '../render-service.js';
import { assertJobLease, createWorker, deterministicZip, persistArtifact, publicJobStage } from '../worker.js';

test('ZIP timestamps and entry ordering are deterministic across retry attempts', async () => {
  const entries = [{ name: 'assets/source.png', bytes: Buffer.from('original') }, { name: 'project.json', bytes: '{"id":"stable"}' }];
  const first = await deterministicZip(entries), second = await deterministicZip([...entries].reverse());
  assert.deepEqual(first, second);
  const zip = await JSZip.loadAsync(first);
  assert.equal(zip.file('project.json')!.date.toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(await zip.file('assets/source.png')!.async('string'), 'original');
});

test('asset traversal covers localized originals and every image layer without treating scene IDs as assets', () => {
  assert.deepEqual(collectCampaignAssetIds({ sources: [{ id: 'source-not-asset', assetId: 'primary', localizedAssets: { de: 'localized', fr: { assetId: 'localized-2' } } }], scenes: [{ id: 'scene-not-asset', background: { assetId: 'background' }, elements: [{ assetId: 'badge' }], popouts: [{ sourceAssetId: 'popout' }] }] }), ['background', 'badge', 'localized', 'localized-2', 'popout', 'primary']);
});

test('render allowlist permits the complete bundled renderer and no API or arbitrary external fetch', () => {
  const origin = 'http://127.0.0.1:8001';
  for (const path of ['/render/index.html', '/templates.js', '/core/canvas-primitives.mjs', '/core/layout-qa.mjs', '/render/fonts/InterVariable.woff2', '/img/laurel-simple-left.svg', '/img/laurel-detailed-left.svg']) assert.equal(isAllowedRenderRequest(origin + path, origin), true, path);
  for (const path of ['/api/session', '/img/arbitrary.svg', '/core/render.mjs?secret=1', '/server/config.ts']) assert.equal(isAllowedRenderRequest(origin + path, origin), false, path);
  assert.equal(isAllowedRenderRequest('https://evil.example/core/render.mjs', origin), false);
  assert.equal(publicJobStage('usage_budget'), false);
  assert.equal(publicJobStage('inputs'), false);
  assert.equal(publicJobStage('checking_0'), true);
});

function persistenceFixture(limit = 1_000_000) {
  const job: any = { id: 'job-1', workspaceId: 'workspace-1', projectId: 'project-1', attempts: 1, status: 'running' };
  const assets = new Map<string, any>(), objects = new Map<string, Buffer>(), statements: string[] = [];
  let failInsert = false;
  const query = async (sql: string, args: any[] = []): Promise<any> => {
    statements.push(sql);
    if (sql.includes("SET status='running'")) {
      if (job.status !== 'queued') return { rowCount: 0, rows: [] };
      job.status = 'running'; job.attempts++;
      return { rowCount: 1, rows: [{ id: job.id, workspace_id: job.workspaceId, project_id: job.projectId, user_id: 'user-1', attempts: job.attempts, kind: job.kind, input: job.input }] };
    }
    if (sql.startsWith('SELECT id FROM agent_jobs')) return { rowCount: job.status === 'running' && job.attempts === args[1] ? 1 : 0, rows: [{ id: job.id }] };
    if (sql.includes('SELECT cancel_requested')) return { rowCount: 1, rows: [{ cancel_requested: false }] };
    if (sql.startsWith('SELECT * FROM assets')) {
      const asset = assets.get(args[0]); return { rowCount: asset ? 1 : 0, rows: asset ? [asset] : [] };
    }
    if (sql.includes('sum(byte_size)')) return { rowCount: 1, rows: [{ used: [...assets.values()].reduce((sum, asset) => sum + asset.byte_size, 0) }] };
    if (sql.startsWith('INSERT INTO assets')) {
      if (failInsert) { failInsert = false; throw new Error('Simulated DB failure after immutable upload'); }
      assets.set(args[0], { id: args[0], workspace_id: args[1], project_id: args[2], name: args[3], storage_key: args[4], mime_type: args[5], byte_size: args[6], sha256: args[9] });
    }
    return { rowCount: 1, rows: [] };
  };
  const services: any = {
    config: { maxStorageBytes: limit },
    db: { query, connect: async () => ({ query, release() {} }) },
    storage: {
      put: async (key: string, bytes: Buffer) => { if (objects.has(key)) throw new Error('Already exists'); objects.set(key, bytes); },
      read: async (key: string) => { if (!objects.has(key)) throw new Error('Missing object'); return objects.get(key)!; },
    },
  };
  return { job, services, objects, assets, statements, failNextInsert: () => { failInsert = true; } };
}

test('artifact quota and lease are checked under the workspace transaction before writing bytes', async () => {
  const f = persistenceFixture(4);
  await assert.rejects(persistArtifact(f.services, f.job, 'campaign.zip', Buffer.from('over-budget'), 'application/zip', 'zip'), { code: 'STORAGE_LIMIT' });
  assert.equal(f.objects.size, 0);
  assert.ok(f.statements.indexOf('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE') < f.statements.findIndex(sql => sql.includes('sum(byte_size)')));
  assert.equal(f.statements.at(-1), 'ROLLBACK');
  f.job.attempts++;
  await assert.rejects(assertJobLease(f.services.db, { ...f.job, attempts: 1 }), { code: 'JOB_LEASE_LOST' });
});

test('retry adopts a matching orphan object after a database failure without consuming space twice', async () => {
  const f = persistenceFixture();
  const bytes = await deterministicZip([{ name: 'project.json', bytes: '{}' }]);
  f.failNextInsert();
  await assert.rejects(persistArtifact(f.services, f.job, 'project.zip', bytes, 'application/zip', 'project'));
  assert.equal(f.objects.size, 1);
  assert.equal(f.assets.size, 0);
  const result = await persistArtifact(f.services, f.job, 'project.zip', bytes, 'application/zip', 'project');
  assert.ok(result.assetId);
  assert.equal(f.objects.size, 1);
  assert.equal(f.assets.size, 1);
  await persistArtifact(f.services, f.job, 'project.zip', bytes, 'application/zip', 'project');
  assert.equal(f.assets.size, 1);
});

test('an old worker cannot publish artifacts after recovery changes its attempt', async () => {
  const f = persistenceFixture();
  const old = { ...f.job };
  f.job.attempts++;
  await assert.rejects(persistArtifact(f.services, old, 'campaign.zip', Buffer.from('data'), 'application/zip', 'zip'), { code: 'JOB_LEASE_LOST' });
  assert.equal(f.objects.size, 0);
});

test('preview consent denial needs user input and requests unsuccessful credit settlement', async () => {
  const f = persistenceFixture();
  f.job.status = 'queued'; f.job.attempts = 0; f.job.kind = 'revision';
  f.job.input = { revisionId: 'original-revision', prompt: 'Shorten the caption' };
  const outcomes: any[] = [];
  Object.assign(f.services.config, { allowLiveAI: true, openaiKey: 'synthetic-no-provider' });
  Object.assign(f.services, {
    assertMembership: async () => {},
    getRevision: async () => ({ id: 'original-revision', document: { sources: [], scenes: [], template: { mode: 'exact', id: 'tidal-relay' } } }),
    finishJob: async (_id: string, outcome: any) => { outcomes.push(outcome); f.job.status = outcome.status; },
  });
  const worker = createWorker(f.services, {} as any, {
    boss: {} as any,
    renderer: { render: async () => assert.fail('No rendering after consent denial'), close: async () => {} },
    engine: async () => { throw Object.assign(new Error('Include the displayed screenshots first.'), { code: 'SOURCE_CONSENT_REQUIRED' }); },
  });
  await worker.run(f.job.id);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].status, 'needs-input');
  assert.equal(outcomes[0].success, false); assert.equal(outcomes[0].error.code, 'SOURCE_CONSENT_REQUIRED');
  assert.equal(f.assets.size, 0); assert.equal(f.objects.size, 0);
});

test('export keeps its original revision, bundles localized/decorative assets, and uses atomic completion API', async () => {
  const f = persistenceFixture();
  f.job.status = 'queued'; f.job.attempts = 0; f.job.kind = 'export'; f.job.input = { revisionId: 'original-revision', format: 'project' };
  const document: any = { id: f.job.projectId, profile: { width: 320, height: 640 }, locale: 'en', sources: [{ assetId: 'primary', localizedAssets: { de: 'localized' } }], scenes: [{ id: 'scene-1', background: { assetId: 'background' }, elements: [{ assetId: 'badge' }] }] };
  const originalAssets = collectCampaignAssetIds(document);
  originalAssets.forEach(id => f.objects.set(`original/${id}`, Buffer.from(`bytes:${id}`)));
  const png = await sharp({ create: { width: 320, height: 640, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  const completed: any[] = [];
  Object.assign(f.services, {
    assertMembership: async () => {}, validateDocumentAssets: async () => {},
    getRevision: async () => ({ id: 'original-revision', document, qa: {} }),
    saveRevision: async () => { throw new Error('Exports must not create a new revision'); },
    asset: async (_ctx: unknown, id: string) => ({ id, projectId: f.job.projectId, name: id, mimeType: 'image/png', storageKey: `original/${id}` }),
    finishJob: async (_id: string, outcome: any) => { completed.push(outcome); f.job.status = outcome.status; return true; },
  });
  const worker = createWorker(f.services, {} as any, { boss: {} as any, renderer: { render: async () => ({ scenes: [{ sceneId: 'scene-1', png, width: 320, height: 640 }], contactSheet: png, issues: [] }), close: async () => {} } });
  await worker.run(f.job.id);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result.revisionId, 'original-revision');
  assert.equal(completed[0].success, true);
  assert.equal(completed[0].expectedAttempt, 1);
  const backup = [...f.objects.entries()].find(([key]) => key.endsWith('editable-project.zip'))![1];
  const zip = await JSZip.loadAsync(backup);
  for (const id of originalAssets) assert.equal(await zip.file(`assets/${id}.png`)!.async('string'), `bytes:${id}`);
  const project = JSON.parse(await zip.file('project.json')!.async('string'));
  assert.equal(project.assets.length, 4);
  assert.ok(![...f.objects.keys()].some(key => key.endsWith('campaign.zip')));
});

test('real Chromium rendering loads bundled laurels/fonts, localized and background images, and preserves deterministic QA', async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const types: Record<string, string> = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const http = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (!isAllowedRenderRequest(`http://localhost${path}`, 'http://localhost')) { res.writeHead(404).end(); return; }
    try { const bytes = await readFile(resolve(root, `.${path}`)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const bytes = new Map<string, Buffer>();
  for (const [id, background] of [['primary', '#ff0000'], ['localized', '#0000ff'], ['background', '#ffffff'], ['badge', '#ffff00']]) bytes.set(id, await sharp({ create: { width: 400, height: 800, channels: 3, background } }).png().toBuffer());
  let document = (createCampaign as (input: any) => any)({ id: 'render-project', assets: [{ id: 'primary', sourceId: 'source', width: 400, height: 800 }], templateId: 'lavender-stage-top', templateMode: 'inspiration', profile: { id: 'fixture', width: 320, height: 640 }, screenCount: 1, locale: 'de' });
  document.sources[0].localizedAssets.de = 'localized';
  document.scenes[0].background = { ...document.scenes[0].background, type: 'image', assetId: 'background' };
  document.scenes[0].elements = [{ id: 'badge-element', type: 'graphic', assetId: 'badge', x: 8, y: 8, width: 10, height: 10, opacity: 100, rotation: 0, layer: 'above-screenshot' }];
  document = applyOperations(document, [{ op: 'update_device', sceneId: document.scenes[0].id, deviceId: document.scenes[0].devices[0].id, patch: { positionMode: 'canvas', centerX: 0.5, centerY: 0.65, scale: 50 } }]);
  const loaded: string[] = [];
  const services: any = { config: { baseUrl: `http://127.0.0.1:${address.port}` }, db: { query: async (_sql: string, [id]: string[]) => { loaded.push(id); return { rowCount: 1, rows: [{ storage_key: id, mime_type: 'image/png' }] }; } }, storage: { read: async (key: string) => bytes.get(key)! } };
  const renderer = createRenderer(services);
  try {
    const first = await renderer.render(document), second = await renderer.render(document);
    assert.deepEqual(first.scenes[0].png, second.scenes[0].png);
    assert.ok(first.issues.some(issue => issue.code === 'EMPTY_HEADLINE'), 'Deterministic QA must not disappear inside output.qa');
    assert.deepEqual(new Set(loaded), new Set(['primary', 'localized', 'background', 'badge']));
    const metadata = await sharp(first.scenes[0].png).metadata();
    assert.equal(metadata.hasAlpha, false);
    const pixel = await sharp(first.scenes[0].png).extract({ left: 160, top: 416, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[2] > pixel[0], 'The localized blue screenshot must appear instead of the red original');
  } finally { await renderer.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
