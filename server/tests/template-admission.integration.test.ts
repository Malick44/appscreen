import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createWorker } from '../worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('template compatibility admission protects real API/MCP jobs and credit reservations', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  const address = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', '[::1]'].includes(address.hostname));
  assert.match(address.pathname, /(?:^|[_/-])test(?:[_/-]|$)/); assert.equal(address.search, '');
  const db = createDatabase(databaseUrl!), storage = await mkdtemp(join(tmpdir(), 'appscreen-template-admission-'));
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!, APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APP_BASE_URL: 'http://localhost', APPSCREEN_STORAGE_PATH: storage, APPSCREEN_ENABLE_AI: 'false', TRIAL_CREDITS: '50' });
  // Admission only: no worker, real key, model, email or billing provider.
  config.allowLiveAI = true; config.openaiKey = 'test-not-a-provider-credential';
  const originalFetch = globalThis.fetch; let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error('External fetch forbidden in admission fixture'); };
  let application: Awaited<ReturnType<typeof createApp>>;
  t.after(async () => { globalThis.fetch = originalFetch; await application?.app.close(); await db.end(); assert.equal(externalCalls, 0); });
  await migrate(db); application = await createApp(config, db);
  const { app, services } = application; await app.ready();
  const enqueued: string[] = []; services.enqueue = async id => { enqueued.push(id); };
  const request = (method: 'GET'|'POST'|'DELETE'|'PATCH', path: string, token?: string, payload?: any, headers: Record<string,string> = {}) => app.inject({ method, url: path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  const checked = async (method:'GET'|'POST'|'DELETE'|'PATCH', path:string, token?:string, payload?:any) => {
    const response = await request(method, path, token, payload); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const { token } = await checked('POST', '/api/dev/session', undefined, { email: `template-${randomUUID()}@appscreen.test` });
  const session = await checked('GET', '/api/session', token);
  const { project } = await checked('POST', '/api/projects', token, { name: 'Synthetic template admission' });
  const png = await sharp({ create: { width: 660, height: 1434, channels: 3, background: '#345678' } }).png().toBuffer();
  const boundary = `fixture-${randomUUID()}`;
  const uploaded = await request('POST', `/api/projects/${project.id}/assets`, token, Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]), { 'content-type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(uploaded.statusCode, 200, uploaded.body); const asset = uploaded.json().asset;
  const { revision } = await checked('POST', `/api/projects/${project.id}/drafts`, token, { assetIds: [asset.id], templateId: 'tidal-relay', templateMode: 'exact', screenCount: 3 });
  const snapshot = async () => ({ credits: await services.credits(session.workspace.id), enqueued: enqueued.length, counts: (await db.query(`SELECT
    (SELECT count(*) FROM agent_jobs WHERE workspace_id=$1) AS jobs,
    (SELECT count(*) FROM credit_reservations WHERE workspace_id=$1) AS reservations,
    (SELECT count(*) FROM usage_events WHERE workspace_id=$1) AS usage,
    (SELECT count(*) FROM credit_ledger WHERE workspace_id=$1) AS ledger`, [session.workspace.id])).rows[0] });
  const brief = { appName: 'Fixture', promise: 'A synthetic test', audience: 'Testers' };

  await t.test('catalog and previews explain every local-only feature without hiding the template', async () => {
    const { templates } = await checked('GET', '/api/templates', token);
    const summary = templates.find((item:any) => item.id === 'pulse-portrait');
    assert.equal(summary.cloudCompatible, false);
    assert.deepEqual(summary.cloudLimitations.map((item:any) => item.code), ['DEVICE_3D', 'LAYERED_PHOTO']);
    const preview = await request('GET', '/api/templates/pulse-portrait/preview');
    assert.equal(preview.statusCode, 200); assert.match(preview.body, /Layered lifestyle photos/);
  });

  await t.test('unsupported, missing and unspecified explicit templates reserve no credits and queue no work', async () => {
    const before = await snapshot();
    for (const [templateId, expectedCode, status] of [['pulse-portrait', 'UNSUPPORTED_TEMPLATE', 422], ['unknown-template', 'TEMPLATE_NOT_FOUND', 404], [undefined, 'TEMPLATE_REQUIRED', 400]] as const) {
      const response = await request('POST', `/api/projects/${project.id}/design-jobs`, token, { sourceIds: [asset.id], brief, templateMode: 'exact', templateId, screenCount: 3, idempotencyKey: randomUUID() });
      assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, expectedCode);
    }
    const manual = await request('POST', `/api/projects/${project.id}/drafts`, token, { assetIds: [asset.id], templateId: 'pulse-portrait' });
    assert.equal(manual.statusCode, 422); assert.equal(manual.json().error.code, 'UNSUPPORTED_TEMPLATE');
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('MCP discovery and paid design reject local-only templates through the same service boundary', async () => {
    const connection = await checked('POST', '/api/connections', token, { name: 'Synthetic compatibility client', scopes: ['projects:read', 'ai:run'], days: 1 });
    const call = async (name:string, args:any) => {
      const response = await request('POST', '/mcp', connection.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' });
      assert.equal(response.statusCode, 200, response.body); const result = response.json().result;
      return { isError: result.isError, data: result.structuredContent || JSON.parse(result.content[0].text) };
    };
    try {
      const before = await snapshot(), catalog = await call('appscreen_list_templates', {});
      assert.equal(catalog.data.templates.find((item:any) => item.id === 'pulse-portrait').cloudCompatible, false);
      const detail = await call('appscreen_get_template', { templateId: 'pulse-portrait' });
      assert.equal(detail.data.template.cloudCompatible, false);
      assert.deepEqual(detail.data.template.cloudLimitations, catalog.data.templates.find((item:any) => item.id === 'pulse-portrait').cloudLimitations);
      const result = await call('appscreen_create_design_job', { projectId: project.id, input: { revisionId: revision.id, brief, screenCount: 3, template: { mode: 'exact', id: 'pulse-portrait' } }, maxCredits: 50, idempotencyKey: randomUUID() });
      assert.equal(result.isError, true); assert.equal(result.data.error.code, 'UNSUPPORTED_TEMPLATE');
      assert.match(result.data.error.message, /Layered lifestyle photos/);
      assert.deepEqual(await snapshot(), before);
    } finally { await checked('DELETE', `/api/connections/${connection.id}`, token); }
  });

  await t.test('local-only saved features block revision/export and locked redesign before admission', async () => {
    for (const feature of ['photo', '3d']) {
      const document = structuredClone(revision.document);
      if (feature === 'photo') document.scenes[0].background.photo = { enabled: true };
      else document.scenes[0].screenshot.use3D = true;
      document.locks.text = true;
      const saved = (await checked('POST', `/api/projects/${project.id}/revisions`, token, { document, expectedRevisionId: revision.id, apply: false })).revision;
      const before = await snapshot();
      for (const path of ['revision-jobs', 'export-jobs', 'design-jobs']) {
        const response = await request('POST', `/api/projects/${project.id}/${path}`, token, { revisionId: saved.id, prompt: 'Shorten this headline', brief, templateMode: 'auto', idempotencyKey: randomUUID() });
        assert.equal(response.statusCode, 422, response.body); assert.equal(response.json().error.code, 'UNSUPPORTED_DESIGN');
      }
      assert.deepEqual(await snapshot(), before);
      const retained = await checked('GET', `/api/projects/${project.id}/revisions/${saved.id}`, token);
      assert.deepEqual(retained.revision.document, saved.document);
    }
  });

  await t.test('automatic selection discards retained IDs, admits once and replays without double reservation', async () => {
    const current = (await checked('GET', `/api/projects/${project.id}`, token)).project;
    const saved = (await checked('PATCH', `/api/projects/${project.id}`, token, { brief, designPreferences: { templateMode: 'exact', templateId: 'removed-template' }, expectedUpdatedAt: current.updatedAt })).project;
    const automatic = (await checked('PATCH', `/api/projects/${project.id}`, token, { brief, designPreferences: { templateMode: 'auto', templateId: 'removed-template' }, expectedUpdatedAt: saved.updatedAt })).project;
    assert.equal(automatic.designPreferences.templateId, 'removed-template');
    assert.equal(automatic.designPreferences.templateMode, 'auto');
    const before = await snapshot(), key = randomUUID();
    const input = { revisionId: revision.id, brief, template: { mode: 'auto', id: 'pulse-portrait' }, templateId: 'unknown-retained-template', idempotencyKey: key };
    const response = await checked('POST', `/api/projects/${project.id}/design-jobs`, token, input);
    const replay = await checked('POST', `/api/projects/${project.id}/design-jobs`, token, input);
    assert.equal(response.job.id, replay.job.id);
    assert.equal(response.job.input.templateMode, 'auto');
    assert.equal(response.job.input.templateId, undefined); assert.equal(response.job.input.template?.id, undefined);
    const after = await snapshot();
    assert.equal(Number(after.counts.jobs), Number(before.counts.jobs) + 1);
    assert.equal(Number(after.counts.reservations), Number(before.counts.reservations) + 1);
    assert.equal(after.credits.reserved - before.credits.reserved, config.designCredits);
    assert.equal(after.counts.usage, before.counts.usage); assert.equal(after.counts.ledger, before.counts.ledger);
    // Close only this synthetic admission fixture, without running a worker.
    await db.query("UPDATE agent_jobs SET status='running',attempts=1 WHERE id=$1 AND workspace_id=$2", [response.job.id, session.workspace.id]);
    assert.equal(await services.finishJob(response.job.id, { status: 'cancelled', success: false, expectedAttempt: 1 }), true);
    assert.deepEqual(await services.credits(session.workspace.id), before.credits);
  });

  const historicalJob = async (input:any, key = randomUUID()) => {
    const id = randomUUID(), requestHash = createHash('sha256').update(JSON.stringify({ kind: 'design', projectId: project.id, input })).digest('hex');
    await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'design','failed','failed',$5,$6,$7)", [id, session.workspace.id, project.id, session.user.id, input, key, requestHash]);
    await db.query("INSERT INTO credit_reservations(job_id,workspace_id,amount,status) VALUES($1,$2,$3,'released')", [id, session.workspace.id, config.designCredits]);
    return { id, key };
  };

  await t.test('identical historical automatic and explicit receipts replay while changed substantive input conflicts', async () => {
    for (const mode of ['auto', 'exact']) {
      const input = { sourceIds: [asset.id], brief, templateMode: mode, templateId: 'pulse-portrait', screenCount: 3 };
      const old = await historicalJob(input), before = await snapshot();
      const replay = await checked('POST', `/api/projects/${project.id}/design-jobs`, token, { ...input, idempotencyKey: old.key });
      assert.equal(replay.job.id, old.id); assert.equal(replay.job.status, 'failed');
      for (const patch of [{ brief: { ...brief, promise: 'Changed content' } }, { screenCount: 4 }]) {
        const conflict = await request('POST', `/api/projects/${project.id}/design-jobs`, token, { ...input, ...patch, idempotencyKey: old.key });
        assert.equal(conflict.statusCode, 409, conflict.body); assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
      }
      assert.deepEqual((await snapshot()).credits, before.credits);
      assert.deepEqual((await snapshot()).counts, before.counts);
    }
  });

  await t.test('historical unsupported inputs and composition checkpoints cannot re-reserve credits on retry', async () => {
    for (const cached of [false, true]) {
      const old = await historicalJob({ sourceIds: [asset.id], brief, templateMode: cached ? 'auto' : 'exact', templateId: cached ? 'tidal-relay' : 'pulse-portrait', screenCount: 3 });
      if (cached) {
        const document = structuredClone(revision.document); document.scenes[0].background.photo = { enabled: true };
        await db.query("INSERT INTO agent_job_steps(job_id,stage,data) VALUES($1,'composing',$2)", [old.id, document]);
      }
      const before = await snapshot();
      const response = await request('POST', `/api/jobs/${old.id}/retry`, token, { idempotencyKey: randomUUID() });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().error.code, cached ? 'UNSUPPORTED_DESIGN' : 'UNSUPPORTED_TEMPLATE');
      assert.deepEqual(await snapshot(), before);
      assert.equal((await db.query('SELECT status FROM credit_reservations WHERE job_id=$1', [old.id])).rows[0].status, 'released');
      assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [old.id])).rows[0].status, 'failed');
    }
  });

  await t.test('historical auto jobs build a supported base even when an old retained ID was local-only or removed', async () => {
    let inspections = 0;
    const worker = createWorker(services, {} as any, {
      boss: {} as any,
      renderer: { render: async () => { throw new Error('No rendering in admission fixture'); }, close: async () => {} },
      engine: async (job:any, host:any) => {
        const document = await host.getDocument(job.input.revisionId);
        assert.equal(document.template.id, 'tidal-relay'); assert.equal(document.template.mode, 'auto');
        assert.equal(document.sources[0].assetId, asset.id); inspections++;
        // Stop after real base construction. Never simulate a completed AI design.
        throw Object.assign(new Error('Synthetic test stopped before provider dispatch.'), { code: 'CANCELLED' });
      },
    });
    for (const id of ['pulse-portrait', 'removed-template']) {
      const old = await historicalJob({ sourceIds: [asset.id], brief, template: { mode: 'auto', id }, templateId: id, screenCount: 3 });
      const credits = await services.credits(session.workspace.id);
      await checked('POST', `/api/jobs/${old.id}/retry`, token, { idempotencyKey: randomUUID() });
      await worker.run(old.id);
      assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [old.id])).rows[0].status, 'cancelled');
      assert.deepEqual(await services.credits(session.workspace.id), credits);
    }
    assert.equal(inspections, 2); assert.equal(externalCalls, 0);
  });
});
