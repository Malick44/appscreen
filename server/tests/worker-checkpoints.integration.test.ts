import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { ALL_SCOPES, type Context } from '../auth.js';
import { createWorker } from '../worker.js';
import { createAgentEngine } from '../agent/engine.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('actual worker persists and resumes JSON checkpoints in isolated PostgreSQL', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  const target = new URL(databaseUrl!);
  assert.equal(target.pathname, '/appscreen_test', 'Only the dedicated appscreen_test database is allowed.');
  assert.equal(target.hostname, '127.0.0.1', 'This regression must remain local.');
  assert.equal(target.port, '55432');
  assert.equal(process.env.DATABASE_URL, databaseUrl, 'Both database variables must identify the isolated test database.');
  assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null', 'Never load a real environment file for this regression.');

  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts++;
    assert.fail('External requests are forbidden in the offline checkpoint regression.');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    assert.equal(networkAttempts, 0, 'No real provider or external service may be contacted.');
  });

  const db = createDatabase(databaseUrl!);
  t.after(async () => { await db.end(); });
  await migrate(db);
  const directory = await mkdtemp(join(tmpdir(), 'appscreen-checkpoints-test-'));
  const config = loadConfig({
    NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!,
    APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'),
    APPSCREEN_STORAGE_PATH: directory, APP_BASE_URL: 'http://localhost',
    APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMAIL_ENABLED: 'false',
  });
  // Only the worker admission check needs these values. Every worker below is
  // injected with a fake engine/provider and renderer; no SDK or queue is started.
  config.allowLiveAI = true;
  config.openaiKey = 'offline-checkpoint-regression-not-a-real-key';
  const services = new AppServices(db, config, createStorage(config));
  const pixels = await sharp({ create: { width: 320, height: 640, channels: 4, background: '#303050' } }).png().toBuffer();
  const brief = { appName: 'Offline Tasks', promise: 'Organize your tasks', confirmedFacts: ['Organize tasks into lists'], audience: 'Busy people', style: 'Elegant', brandColors: [] };
  const fixture = async (count = 1) => {
    const workspaceId = randomUUID(), projectId = randomUUID(), userId = `checkpoint-test:${randomUUID()}`;
    const ctx: Context = { workspaceId, userId, email: 'checkpoint@example.test', role: 'owner', authKind: 'development', scopes: [...ALL_SCOPES] };
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Fresh offline checkpoint regression']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    await db.query("INSERT INTO subscriptions(workspace_id,plan_id,status) VALUES($1,'pro','active')", [workspaceId]);
    await db.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)', [projectId, workspaceId, 'Synthetic checkpoint campaign']);
    await db.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,100,'test',$3)", [randomUUID(), workspaceId, `checkpoint-fixture:${workspaceId}`]);
    const assetIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const { asset } = await services.uploadAsset(ctx, projectId, `synthetic-${index}.png`, pixels);
      assetIds.push(asset.id);
    }
    const { revision } = await services.createDraft(ctx, {
      projectId, assetIds, brief, templateId: 'tidal-relay', templateMode: 'exact',
      screenCount: count, profile: { id: 'custom', width: 320, height: 640 },
    });
    const { job } = await services.createJob(ctx, {
      projectId, kind: 'design', idempotencyKey: `checkpoint-job:${randomUUID()}`,
      input: { revisionId: revision.id, sourceIds: assetIds, brief, screenCount: count, templateMode: 'exact', templateId: 'tidal-relay', maxCredits: 5 },
    });
    return { workspaceId, projectId, ctx, assetIds, revision, job };
  };
  const renderer = {
    render: async (document: any) => ({
      scenes: document.scenes.map((scene: any) => ({ sceneId: scene.id, png: pixels, width: 320, height: 640 })),
      contactSheet: pixels, issues: [],
    }),
    close: async () => {},
  };
  const workerFor = (engine: any, service = services) => createWorker(service, {} as any, { engine, renderer: renderer as any, deadlineMs: 20_000 });
  const checkpoints = async (jobId: string) => Object.fromEntries((await db.query('SELECT stage,data FROM agent_job_steps WHERE job_id=$1', [jobId])).rows.map(entry => [entry.stage, entry.data]));
  const state = async (jobId: string) => (await db.query('SELECT status,stage,result,error,attempts FROM agent_jobs WHERE id=$1', [jobId])).rows[0];
  const usage = async (jobId: string) => (await db.query('SELECT data FROM usage_events WHERE job_id=$1 ORDER BY created_at,id', [jobId])).rows.map(entry => entry.data);
  const offlineProvider = (f: Awaited<ReturnType<typeof fixture>>, failFirstPlanning = false) => {
    const calls: string[] = [];
    let planningStopped = false;
    return {
      calls,
      generate: async (request: any) => {
        calls.push(request.stage);
        if (failFirstPlanning && request.stage === 'planning' && !planningStopped) {
          planningStopped = true;
          throw Object.assign(new Error('Offline injected interruption before planning usage'), { code: 'OFFLINE_INTERRUPTION' });
        }
        await request.onUsage({ responseId: `offline_${f.job.id}_${request.stage}`, input_tokens: 11, output_tokens: 7, total_tokens: 18 });
        if (request.stage === 'analyzing') return {
          sources: f.revision.document.sources.map((source: any) => ({
            sourceId: source.id, summary: 'Synthetic task lists', facts: [{ statement: 'Organize tasks into lists' }],
            dominantColors: ['#303050'], focalPoint: { x: 50, y: 50 }, quality: 'usable', containsPrivateData: false, warnings: [],
          })), missingFacts: [],
        };
        if (request.stage === 'planning') {
          // The model emits observations, never evidence identities. Planning
          // receives only IDs assigned by the engine and persisted by the worker.
          assert.deepEqual(request.data.analysis.sources.map((source: any) => source.facts), f.revision.document.sources.map((source: any) => [{ id: `${source.id}:fact-1`, statement: 'Organize tasks into lists' }]));
          return {
            templateId: 'tidal-relay', direction: 'Offline coherent campaign', backgroundColor: '#E9E8F7', accentColor: '#53449F', textColor: '#16141C',
            scenes: f.revision.document.sources.map((source: any) => ({ sourceId: source.id, purpose: 'Show task organization', headline: 'Organize your tasks', subheadline: 'Keep your lists together', evidenceIds: [`${source.id}:fact-1`] })),
          };
        }
        assert.equal(request.stage, 'checking_0', 'Unexpected stage must not fall through to a real provider.');
        return { summary: 'Synthetic offline review', issues: [] };
      },
    };
  };

  await t.test('pg encodes raw arrays differently from explicit JSON, including silent empty-array corruption', async () => {
    const sample = [{ responseId: 'offline_only', tokens: 18 }];
    await assert.rejects(db.query('SELECT $1::jsonb AS data', [sample]), { code: '22P02' });
    assert.deepEqual((await db.query('SELECT $1::jsonb AS data', [[]])).rows[0].data, {});
    for (const value of [sample, [], { nested: [{ text: 'quotes " braces {} slash \\ newline\n' }], empty: [] }]) {
      assert.deepEqual((await db.query('SELECT $1::jsonb AS data', [JSON.stringify(value)])).rows[0].data, value);
    }
  });

  await t.test('actual worker round-trips arrays, objects and JSON scalars without double encoding', async () => {
    const f = await fixture();
    const values = [[], [{ responseId: 'offline_"{}\\', tokens: 18 }], { array: [[], { text: '"{}\\\n', flag: false }], empty: {} }, 'plain "{}\\\n', 0, false, null];
    let completed = false;
    await workerFor(async (_job: any, host: any) => {
      for (const [index, value] of values.entries()) {
        const stage = `internal_roundtrip_${index}`;
        await host.checkpoint(stage, value);
        assert.deepEqual(await host.loadCheckpoint(stage), value);
      }
      await host.checkpoint('usage_budget', []);
      assert.deepEqual(await host.loadCheckpoint('usage_budget'), []);
      await assert.rejects(host.checkpoint('internal_undefined', undefined), { code: 'INVALID_CHECKPOINT' });
      completed = true;
      return { qa: { reviewNeeded: false } };
    }).run(f.job.id);
    assert.ok(completed, JSON.stringify(await state(f.job.id)));
    assert.equal((await state(f.job.id)).status, 'ready');
    const saved = await checkpoints(f.job.id);
    for (const [index, value] of values.entries()) assert.deepEqual(saved[`internal_roundtrip_${index}`], value);
    assert.deepEqual(saved.usage_budget, []);
    assert.ok(!Object.hasOwn(saved, 'internal_undefined'));
    assert.equal((await db.query("SELECT data IS NULL AS sql_null FROM agent_job_steps WHERE job_id=$1 AND stage='internal_roundtrip_6'", [f.job.id])).rows[0].sql_null, false);
    const events = (await db.query('SELECT event FROM job_events WHERE job_id=$1', [f.job.id])).rows;
    assert.ok(events.every(entry => !entry.event.stage?.startsWith('internal_') && entry.event.stage !== 'usage_budget'));
  });

  await t.test('actual engine onUsage persists budget and analysis, finishes five sources, and replays without extra calls or usage', async () => {
    const f = await fixture(5), provider = offlineProvider(f), engine = createAgentEngine({ provider });
    let replayed = false;
    await workerFor(async (job: any, host: any) => {
      await host.checkpoint('usage_budget', []);
      const result = await engine(job, host);
      const before = await checkpoints(job.id), priorUsage = await usage(job.id);
      const resultAgain = await engine(job, host);
      assert.deepEqual(resultAgain, result);
      assert.deepEqual(await checkpoints(job.id), before);
      assert.deepEqual(await usage(job.id), priorUsage);
      replayed = true;
      return resultAgain;
    }).run(f.job.id);
    const finished = await state(f.job.id);
    assert.ok(replayed, JSON.stringify(finished));
    assert.equal(finished.status, 'ready', JSON.stringify(finished.error));
    assert.deepEqual(provider.calls, ['analyzing', 'planning', 'checking_0']);
    assert.equal(finished.result.previews.length, 5);
    assert.equal(finished.result.artifacts.length, 7);
    const saved = await checkpoints(f.job.id);
    assert.deepEqual(saved.inputs, f.revision.document);
    assert.equal(saved.analyzing.sources.length, 5);
    assert.deepEqual(saved.analyzing.sources.map((source: any) => source.facts), f.revision.document.sources.map((source: any) => [{ id: `${source.id}:fact-1`, statement: 'Organize tasks into lists' }]));
    assert.deepEqual(saved.usage_budget, provider.calls.map(stage => ({ responseId: `offline_${f.job.id}_${stage}`, stage, tokens: 18 })));
    assert.equal((await usage(f.job.id)).length, 3);
    assert.ok((await usage(f.job.id)).every(entry => entry.attempt === 1));
    const finalRevision = await services.getRevision(f.ctx, f.projectId, finished.result.revisionId);
    assert.deepEqual(finalRevision.document.sources, f.revision.document.sources);
    assert.deepEqual(finalRevision.document.scenes.map((scene: any) => scene.devices), f.revision.document.scenes.map((scene: any) => scene.devices));
    assert.deepEqual(await services.credits(f.workspaceId), { available: 95, reserved: 0, totalGranted: 100 });
    await workerFor(engine).run(f.job.id); // Terminal queue redelivery cannot claim a finished job.
    assert.deepEqual(provider.calls, ['analyzing', 'planning', 'checking_0']);
    assert.equal((await usage(f.job.id)).length, 3);
  });

  await t.test('fresh offline retry loads a prior usage array and skips its completed analysis', async () => {
    const f = await fixture(), provider = offlineProvider(f, true), engine = createAgentEngine({ provider });
    const worker = workerFor(engine);
    await worker.run(f.job.id);
    const stopped = await state(f.job.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error.code, 'OFFLINE_INTERRUPTION');
    const before = await checkpoints(f.job.id);
    assert.equal(before.usage_budget.length, 1);
    assert.equal(before.usage_budget[0].stage, 'analyzing');
    assert.ok(before.analyzing);
    assert.equal((await usage(f.job.id)).length, 1);
    await services.retryJob(f.ctx, { jobId: f.job.id, idempotencyKey: `offline-retry:${randomUUID()}` });
    await worker.run(f.job.id);
    const finished = await state(f.job.id), after = await checkpoints(f.job.id);
    assert.equal(finished.status, 'ready', JSON.stringify(finished.error));
    assert.equal(finished.attempts, 2);
    assert.deepEqual(provider.calls, ['analyzing', 'planning', 'planning', 'checking_0']);
    assert.deepEqual(after.analyzing, before.analyzing);
    assert.deepEqual(after.usage_budget.map((entry: any) => entry.stage), ['analyzing', 'planning', 'checking_0']);
    assert.equal(after.usage_budget.reduce((sum: number, entry: any) => sum + entry.tokens, 0), 54);
    assert.deepEqual((await usage(f.job.id)).map(entry => entry.attempt).sort(), [1, 2, 2]);
    assert.deepEqual(await services.credits(f.workspaceId), { available: 95, reserved: 0, totalGranted: 100 });
  });

  await t.test('event failure rolls back checkpoint upsert and stage change in their original transaction', async () => {
    const f = await fixture();
    let injectFailure = false, checked = false;
    const wrappedDb: any = {
      query: db.query.bind(db),
      connect: async () => {
        const client = await db.connect();
        return { release: () => client.release(), query: async (sql: string, args?: any[]) => {
          if (injectFailure && sql.startsWith('INSERT INTO job_events')) throw new Error('Offline injected checkpoint event failure');
          return client.query(sql, args);
        } };
      },
    };
    const wrapped = new AppServices(wrappedDb, config, services.storage);
    await workerFor(async (_job: any, host: any) => {
      await host.checkpoint('analyzing', { prior: ['retained'] });
      await host.checkpoint('planning', { prior: 'stage' });
      injectFailure = true;
      await assert.rejects(host.checkpoint('analyzing', { replacement: ['must roll back'] }), /Offline injected/);
      injectFailure = false;
      assert.deepEqual(await host.loadCheckpoint('analyzing'), { prior: ['retained'] });
      assert.equal((await state(f.job.id)).stage, 'planning');
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM job_events WHERE job_id=$1', [f.job.id])).rows[0].count, 2);
      checked = true;
      return { qa: { reviewNeeded: false } };
    }, wrapped).run(f.job.id);
    assert.ok(checked, JSON.stringify(await state(f.job.id)));
    assert.equal((await state(f.job.id)).status, 'ready');
  });

  await t.test('a lost lease still rejects a checkpoint update before data or events can change', async () => {
    const f = await fixture();
    let rejected = false;
    await workerFor(async (_job: any, host: any) => {
      await host.checkpoint('usage_budget', []);
      await db.query("UPDATE agent_jobs SET status='queued',stage='recovering',attempts=attempts+1 WHERE id=$1", [f.job.id]);
      await assert.rejects(host.checkpoint('usage_budget', [{ tokens: 999 }]), { code: 'JOB_LEASE_LOST' });
      await assert.rejects(host.checkpoint('analyzing', { stale: true }), { code: 'JOB_LEASE_LOST' });
      rejected = true;
      throw Object.assign(new Error('Offline stale lease'), { code: 'JOB_LEASE_LOST' });
    }).run(f.job.id);
    assert.ok(rejected, JSON.stringify(await state(f.job.id)));
    assert.deepEqual(await checkpoints(f.job.id), { usage_budget: [] });
    assert.equal((await state(f.job.id)).status, 'queued');
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM job_events WHERE job_id=$1', [f.job.id])).rows[0].count, 0);
    assert.equal((await services.credits(f.workspaceId)).reserved, 5);
  });
});
