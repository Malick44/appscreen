import { PgBoss } from 'pg-boss';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { row, transaction, type Connection } from './db.js';
import { hash, ALL_SCOPES, type Context } from './auth.js';
import { AppError, invariant } from './errors.js';
import { collectCampaignAssetIds, createRenderer } from './render-service.js';
import { createAgentEngine } from './agent/engine.mjs';
import type { AppServices } from './services.js';
import type { Billing } from './billing.js';
import { EmailDelivery } from './email.js';

export function stableArtifactId(value: string) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function deterministicZip(entries: Array<{ name: string; bytes: Buffer | string }>): Promise<Buffer> {
  const zip = new JSZip(), date = new Date('2000-01-01T00:00:00.000Z');
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    zip.file(entry.name, entry.bytes, { date, createFolders: false, unixPermissions: 0o100600 });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}

export const publicJobStage = (stage: string) => !['inputs', 'base_revision', 'usage_budget'].includes(stage) && !stage.startsWith('internal_');

/** The monotonic attempts field is a lease epoch: requeue immediately invalidates
 * an old worker. It may still record incurred usage, but cannot publish a result. */
export async function assertJobLease(conn: Connection, job: any, lock = false) {
  const result = await conn.query(`SELECT id FROM agent_jobs WHERE id=$1 AND status='running' AND attempts=$2${lock ? ' FOR UPDATE' : ''}`, [job.id, job.attempts]);
  invariant(result.rowCount, 'JOB_LEASE_LOST', 'Another worker owns this job now.', 409);
}

export async function persistArtifact(services: AppServices, job: any, name: string, bytes: Buffer, mimeType: string, kind: string, metadata: Record<string, unknown> = {}) {
  invariant(/^[a-zA-Z0-9_.-]+$/.test(name), 'INVALID_ARTIFACT_NAME', 'Invalid export file name.');
  const id = stableArtifactId(`${job.id}:${name}`), key = `${job.workspaceId}/exports/${job.id}/${name}`, checksum = hash(bytes);
  const meta: { width?: number; height?: number } = mimeType === 'image/png' ? await sharp(bytes).metadata() : {};
  return transaction(services.db, async client => {
    // Same admission lock as source uploads, so exports cannot bypass storage quotas.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [job.workspaceId]);
    await assertJobLease(client, job, true);
    const existing = await client.query('SELECT * FROM assets WHERE id=$1 AND workspace_id=$2 AND project_id=$3', [id, job.workspaceId, job.projectId]);
    if (existing.rowCount) {
      invariant(existing.rows[0].sha256 === checksum, 'ARTIFACT_CONFLICT', 'An export with this identity contains different bytes.');
      return { assetId: id, name, kind };
    }
    const used = await client.query('SELECT COALESCE(sum(byte_size),0)::bigint AS used FROM assets WHERE workspace_id=$1', [job.workspaceId]);
    invariant(Number(used.rows[0].used) + bytes.length <= services.config.maxStorageBytes, 'STORAGE_LIMIT', 'Your workspace has reached its storage limit. Remove unused files or upgrade before exporting.', 402);
    try { await services.storage.put(key, bytes, mimeType); }
    catch (error) {
      const prior = await services.storage.read(key).catch(() => null);
      if (!prior || hash(prior) !== checksum) throw error;
    }
    // Keep an object after ambiguous DB failure; retry adopts matching bytes. Never
    // delete a potentially committed artifact as part of error handling.
    await client.query('INSERT INTO assets(id,workspace_id,project_id,name,storage_key,mime_type,byte_size,width,height,sha256,kind,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, job.workspaceId, job.projectId, name, key, mimeType, bytes.length, meta.width || 1, meta.height || 1, checksum, kind, metadata]);
    return { assetId: id, name, kind };
  });
}

type WorkerOptions = { renderer?: ReturnType<typeof createRenderer>; engine?: ReturnType<typeof createAgentEngine>; boss?: PgBoss; deadlineMs?: number; heartbeatMs?: number };

export function createWorker(services: AppServices, billing: Billing, options: WorkerOptions = {}) {
  const boss = options.boss || new PgBoss({ connectionString: services.config.databaseUrl, schema: 'appscreen_queue' });
  const renderer = options.renderer || createRenderer(services);
  const engine = options.engine || createAgentEngine({ apiKey: services.config.openaiKey, model: services.config.openaiModel });
  let scanTimer: ReturnType<typeof setInterval> | undefined, reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let emailWorker:ReturnType<EmailDelivery['start']>|undefined;
  const controllers = new Set<AbortController>();
  async function enqueue(jobId: string) { await boss.send('appscreen-jobs', { jobId }, { singletonKey: jobId, retryLimit: 2, retryDelay: 10, expireInSeconds: 900 }); }
  async function event(job: any, stage: string, data: Record<string, unknown> = {}) {
    await transaction(services.db, async client => {
      await assertJobLease(client, job, true);
      await client.query('UPDATE agent_jobs SET stage=$1,heartbeat_at=now(),updated_at=now() WHERE id=$2', [stage, job.id]);
      await client.query('INSERT INTO job_events(job_id,workspace_id,event) VALUES($1,$2,$3)', [job.id, job.workspaceId, { stage, ...data }]);
    });
  }

  async function deliver(job: any, ctx: Context, document: any, qa: any, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await event(job, 'exporting');
    await services.validateDocumentAssets(ctx, job.projectId, document);
    const isAI = job.kind === 'design' || job.kind === 'revision';
    const saved = isAI
      ? (await services.saveRevision(ctx, job.projectId, { document, expectedRevisionId: job.input.revisionId || null, revisionId: stableArtifactId(`${job.id}:result`), qa, label: qa?.reviewNeeded ? 'AI draft · review needed' : 'AI campaign' })).revision
      : await services.getRevision(ctx, job.projectId, job.input.revisionId);
    await assertJobLease(services.db, job);
    const render = await renderer.render(saved.document, { signal });
    await assertJobLease(services.db, job);
    const checkedIssues = [...new Map([...(qa?.issues || []), ...(render.issues || [])].map(issue => [JSON.stringify(issue), issue])).values()];
    qa = { ...qa, issues: checkedIssues, reviewNeeded: checkedIssues.length > 0 };
    const previews: any[] = [], artifacts: any[] = [];
    const manifest: any = { version: 1, revisionId: saved.id, profile: saved.document.profile, locale: saved.document.locale, screens: [], sourceAssetIds: collectCampaignAssetIds(saved.document) };
    const sceneEntries = [];
    for (let index = 0; index < render.scenes.length; index++) {
      signal?.throwIfAborted();
      const scene = render.scenes[index], name = `${String(index + 1).padStart(2, '0')}-${saved.document.locale}.png`;
      const artifact = await persistArtifact(services, job, name, scene.png, 'image/png', 'export', { sceneId: scene.sceneId });
      previews.push({ sceneId: scene.sceneId, assetId: artifact.assetId }); artifacts.push(artifact);
      sceneEntries.push({ name, bytes: scene.png }); manifest.screens.push({ sceneId: scene.sceneId, file: name, width: scene.width, height: scene.height });
    }
    const contactSheet = await persistArtifact(services, job, 'contact-sheet.png', render.contactSheet, 'image/png', 'preview');
    const format = isAI ? 'all' : job.input.format || 'zip';
    if (format === 'all' || format === 'zip') artifacts.push(await persistArtifact(services, job, 'campaign.zip', await deterministicZip([...sceneEntries, { name: 'manifest.json', bytes: JSON.stringify(manifest, null, 2) }]), 'application/zip', 'zip'));
    if (format === 'all' || format === 'project') {
      const entries = [], assets = [];
      for (const id of collectCampaignAssetIds(saved.document)) {
        signal?.throwIfAborted();
        const asset = await services.asset(ctx, id);
        invariant(asset.projectId === job.projectId, 'ASSET_FORBIDDEN', 'A backup asset belongs to another project.', 403);
        const name = `assets/${id}.${asset.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
        entries.push({ name, bytes: await services.storage.read(asset.storageKey) }); assets.push({ id, file: name, name: asset.name, mimeType: asset.mimeType });
      }
      entries.push({ name: 'project.json', bytes: Buffer.from(JSON.stringify({ format: 'appscreen-campaign', version: 1, document: saved.document, assets }, null, 2)) });
      artifacts.push(await persistArtifact(services, job, 'editable-project.zip', await deterministicZip(entries), 'application/zip', 'project'));
    }
    return { revisionId: saved.id, previews, artifacts, contactSheet, qa };
  }

  async function run(jobId: string) {
    const claim = await services.db.query("UPDATE agent_jobs SET status='running',stage='starting',attempts=attempts+1,heartbeat_at=now(),updated_at=now() WHERE id=$1 AND status='queued' RETURNING *", [jobId]);
    if (!claim.rowCount) return;
    const job = row<any>(claim.rows[0]);
    const ctx: Context = { userId: job.userId, workspaceId: job.workspaceId, email: '', role: 'owner', scopes: [...ALL_SCOPES], authKind: 'web' };
    const controller = new AbortController(); controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(new AppError('JOB_DEADLINE', 'The design job reached its execution deadline.')), options.deadlineMs ?? 600_000);
    const heartbeat = setInterval(() => {
      void services.db.query("UPDATE agent_jobs SET heartbeat_at=now() WHERE id=$1 AND status='running' AND attempts=$2 RETURNING id", [job.id, job.attempts])
        .then(result => { if (!result.rowCount) controller.abort(new AppError('JOB_LEASE_LOST', 'Another worker owns this job now.')); })
        .catch(() => controller.abort(new AppError('JOB_HEARTBEAT_FAILED', 'The worker lost its database connection.')));
    }, options.heartbeatMs ?? 10_000);
    const checkpoint = async (stage: string, data: any) => {
      await transaction(services.db, async client => {
        await assertJobLease(client, job, true);
        // pg serializes top-level JS arrays as PostgreSQL arrays, not JSON:
        // usage_budget then fails with 22P02, while [] silently becomes {}.
        // Serialize every checkpoint uniformly so objects and scalars also
        // round-trip as JSON values without double encoding.
        const json = JSON.stringify(data);
        invariant(typeof json === 'string', 'INVALID_CHECKPOINT', 'A job checkpoint must contain JSON data.');
        await client.query('INSERT INTO agent_job_steps(job_id,stage,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(job_id,stage) DO UPDATE SET data=excluded.data', [job.id, stage, json]);
        if (publicJobStage(stage)) {
          await client.query('UPDATE agent_jobs SET stage=$1,heartbeat_at=now(),updated_at=now() WHERE id=$2', [stage, job.id]);
          await client.query('INSERT INTO job_events(job_id,workspace_id,event) VALUES($1,$2,$3)', [job.id, job.workspaceId, { stage }]);
        }
      });
    };
    const loadCheckpoint = async (stage: string) => {
      await assertJobLease(services.db, job);
      const result = await services.db.query('SELECT data FROM agent_job_steps WHERE job_id=$1 AND stage=$2', [job.id, stage]); return result.rows[0]?.data ?? null;
    };
    const isCancelled = async () => {
      await services.assertMembership(ctx); await assertJobLease(services.db, job);
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await services.db.query('SELECT cancel_requested FROM agent_jobs WHERE id=$1', [job.id]); return Boolean(result.rows[0]?.cancel_requested);
    };
    try {
      if (await isCancelled()) throw new AppError('CANCELLED', 'Generation cancelled.');
      let result: any;
      if (job.kind === 'design' || job.kind === 'revision') {
        invariant(services.config.allowLiveAI && services.config.openaiKey, 'AI_NOT_CONFIGURED', 'AI generation is not enabled.', 503);
        if (!job.input.revisionId) {
          const prior = await loadCheckpoint('base_revision');
          if (prior) job.input.revisionId = prior.id;
          else {
            const templateMode = job.input.templateMode || job.input.template?.mode || 'auto';
            const templateId = templateMode === 'auto' ? undefined : job.input.templateId || job.input.template?.id;
            const draft = await services.createDraft(ctx, { projectId: job.projectId, assetIds: job.input.sourceIds, brief: job.input.brief, templateId, templateMode, screenCount: job.input.screenCount, profile: typeof job.input.profile === 'object' ? job.input.profile : undefined, locale: job.input.locale, locks: job.input.locks });
            job.input.revisionId = draft.revision.id; await checkpoint('base_revision', { id: draft.revision.id });
          }
        }
        const base = await services.getRevision(ctx, job.projectId, job.input.revisionId);
        const brief = typeof job.input.brief === 'string' ? { appName: base.document.name, promise: job.input.brief } : job.input.brief || base.document.brief;
        const sourceIds = (job.input.sourceIds || base.document.sources.map((source: any) => source.id)).map((id: string) => base.document.sources.find((source: any) => source.id === id || source.assetId === id)?.id || id);
        const input = { revisionId: job.input.revisionId, sourceIds, brief, screenCount: job.input.screenCount || base.document.scenes.length, locale: job.input.locale || base.document.locale, template: { mode: job.input.templateMode || job.input.template?.mode || base.document.template.mode, id: job.input.templateId || job.input.template?.id || base.document.template.id }, ...(job.kind === 'revision' ? { instruction: job.input.prompt || job.input.instruction, scope: job.input.scope } : {}), maxCredits: job.input.maxCredits };
        result = await engine({ ...job, input }, {
          signal: controller.signal,
          getDocument: async (id: string) => (await services.getRevision(ctx, job.projectId, id)).document,
          getAssets: async (ids: string[]) => Promise.all(ids.map(id => services.asset(ctx, id))),
          getAssetBytes: async (id: string) => { const asset = await services.asset(ctx, id); return services.storage.read(asset.storageKey); },
          checkpoint, loadCheckpoint, isCancelled,
          render: async (document: any) => {
            if (await isCancelled()) throw new AppError('CANCELLED', 'Generation cancelled.');
            await services.validateDocumentAssets(ctx, job.projectId, document); const result = await renderer.render(document, { signal: controller.signal }); await assertJobLease(services.db, job); return result;
          },
          saveDraft: async (document: any, qa: any) => deliver(job, ctx, document, qa, controller.signal),
          recordUsage: async (usage: any) => {
            await services.db.query('INSERT INTO usage_events(id,workspace_id,job_id,data,reference) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reference) DO NOTHING', [randomUUID(), ctx.workspaceId, job.id, { ...usage, attempt: job.attempts }, `${job.id}:${usage.responseId || hash(JSON.stringify(usage))}`]);
          },
        });
      } else {
        const revision = await services.getRevision(ctx, job.projectId, job.input.revisionId); result = await deliver(job, ctx, revision.document, revision.qa, controller.signal);
      }
      const status = result.reviewNeeded || result.qa?.reviewNeeded ? 'needs-input' : 'ready';
      await services.finishJob(job.id, { status, result, success: true, expectedAttempt: job.attempts });
    } catch (error: any) {
      if (error.code === 'JOB_LEASE_LOST') return;
      const status = error.code === 'CANCELLED' ? 'cancelled' : ['NEEDS_INPUT', 'UNUSABLE_SOURCE', 'LINKED_SCOPE_REQUIRED', 'SOURCE_CONSENT_REQUIRED'].includes(error.code) ? 'needs-input' : 'failed';
      const code = /^[A-Z_]{2,60}$/.test(error.code || '') ? error.code : 'JOB_FAILED';
      const message = code === 'JOB_FAILED' ? 'The job could not finish. Your screenshots and completed checkpoints are safe. Retry or contact support with this job ID.' : String(error.message).slice(0, 700);
      // If success committed before a response was lost, finishJob refuses to
      // replace the already-terminal result with this apparent failure.
      await services.finishJob(job.id, { status, error: { code, message }, success: false, expectedAttempt: job.attempts });
      console.error(`AppScreen job ${job.id} stopped (${code}).`);
    } finally { clearInterval(heartbeat); clearTimeout(deadline); controllers.delete(controller); }
  }
  async function scan() {
    await services.db.query("UPDATE agent_jobs SET status='queued',stage='recovering',updated_at=now() WHERE status='running' AND heartbeat_at<now()-interval '5 minutes'");
    const pending = await services.db.query("SELECT id FROM agent_jobs WHERE status='queued' ORDER BY created_at LIMIT 100"); for (const job of pending.rows) await enqueue(job.id);
  }
  return {
    run, enqueue, renderer,
    async start() {
      boss.on('error', () => console.error('AppScreen job queue error; checking database connectivity.'));
      await boss.start(); await boss.createQueue('appscreen-jobs');
      await boss.work<{ jobId: string }>('appscreen-jobs', { localConcurrency: 1 }, async jobs => { for (const job of jobs) await run(job.data.jobId); });
      services.enqueue = enqueue; await scan(); scanTimer = setInterval(() => void scan().catch(() => {}), 15_000); reconcileTimer = setInterval(() => void billing.reconcile().catch(() => {}), 60_000);
      emailWorker=new EmailDelivery(services).start();
    },
    async stop() {
      if (scanTimer) clearInterval(scanTimer); if (reconcileTimer) clearInterval(reconcileTimer);
      await emailWorker?.stop();
      controllers.forEach(controller => controller.abort(new AppError('WORKER_STOPPING', 'The worker is shutting down.')));
      await boss.stop(); await renderer.close();
    },
  };
}
