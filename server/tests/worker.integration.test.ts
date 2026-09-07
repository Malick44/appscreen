import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { ALL_SCOPES, type Context } from '../auth.js';
import { persistArtifact } from '../worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('real PostgreSQL worker credit, lease and storage admission regressions', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/, 'Use a dedicated test database only.');
  const db = createDatabase(databaseUrl!), path = await mkdtemp(join(tmpdir(), 'appscreen-worker-test-'));
  t.after(async () => { await db.end(); });
  await migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!, APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: path, APP_BASE_URL: 'http://localhost', MAX_CONCURRENT_JOBS: '1' });
  // Allows testing admission logic without constructing a worker/model or calling AI.
  config.allowLiveAI = true; config.openaiKey = 'test-not-a-real-provider-credential';
  const services = new AppServices(db, config, createStorage(config));
  const fixture = async () => {
    const workspaceId = randomUUID(), projectId = randomUUID(), userId = `worker-test:${randomUUID()}`;
    const ctx: Context = { workspaceId, userId, email: 'worker@example.test', role: 'owner', authKind: 'development', scopes: [...ALL_SCOPES] };
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Isolated worker regression']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    await db.query("INSERT INTO subscriptions(workspace_id,plan_id,status) VALUES($1,'pro','active')", [workspaceId]);
    await db.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)', [projectId, workspaceId, 'Worker regression campaign']);
    await db.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,100,'test',$3)", [randomUUID(), workspaceId, `fixture:${workspaceId}`]);
    return { workspaceId, projectId, userId, ctx };
  };
  const job = async (f: Awaited<ReturnType<typeof fixture>>, status = 'running', reservationStatus = 'reserved', amount = 5) => {
    const id = randomUUID();
    await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,idempotency_key,request_hash,attempts) VALUES($1,$2,$3,$4,'design',$5,$5,$6,$7,$8,1)", [id, f.workspaceId, f.projectId, f.userId, status, { maxCredits: amount }, `fixture:${id}`, id]);
    await db.query('INSERT INTO credit_reservations(job_id,workspace_id,amount,status) VALUES($1,$2,$3,$4)', [id, f.workspaceId, amount, reservationStatus]);
    return { id, attempts: 1, ...f };
  };

  await t.test('terminal result and credit settlement commit once; stale attempts cannot publish', async () => {
    const f = await fixture(), j = await job(f);
    assert.equal(await services.finishJob(j.id, { status: 'ready', success: true, result: { revisionId: 'stale' }, expectedAttempt: 0 }), false);
    assert.equal((await services.credits(f.workspaceId)).reserved, 5);
    const results = await Promise.all([1, 2].map(() => services.finishJob(j.id, { status: 'ready', success: true, result: { revisionId: 'finished' }, expectedAttempt: 1 })));
    assert.deepEqual(results.sort(), [false, true]);
    assert.deepEqual(await services.credits(f.workspaceId), { available: 95, reserved: 0, totalGranted: 100 });
    assert.equal(await services.finishJob(j.id, { status: 'failed', success: false, error: { code: 'CONNECTION_LOST' }, expectedAttempt: 1 }), false);
    const record = await db.query('SELECT status,result FROM agent_jobs WHERE id=$1', [j.id]);
    assert.equal(record.rows[0].status, 'ready'); assert.equal(record.rows[0].result.revisionId, 'finished');
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM credit_ledger WHERE reference=$1', [`job:${j.id}`])).rows[0].count, 1);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM job_events WHERE job_id=$1', [j.id])).rows[0].count, 1);
  });

  await t.test('failed terminal event insert rolls back job, ledger and reservation together', async () => {
    const f = await fixture(), j = await job(f);
    const injected: any = { query: db.query.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql: string, args?: any[]) => {
        if (sql.startsWith('INSERT INTO job_events')) throw new Error('Injected terminal event failure');
        return client.query(sql, args);
      } };
    } };
    const failing = new AppServices(injected, config, services.storage);
    await assert.rejects(failing.finishJob(j.id, { status: 'ready', success: true, result: { revisionId: 'not-committed' }, expectedAttempt: 1 }), /Injected/);
    assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [j.id])).rows[0].status, 'running');
    assert.equal((await services.credits(f.workspaceId)).reserved, 5);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM credit_ledger WHERE reference=$1', [`job:${j.id}`])).rows[0].count, 0);
  });

  await t.test('concurrent artifact exports cannot exceed the workspace storage quota', async () => {
    const f = await fixture(), a = await job(f), b = await job(f);
    const limited = new AppServices(db, { ...config, maxStorageBytes: 12 }, services.storage);
    const results = await Promise.allSettled([a, b].map(j => persistArtifact(limited, j, 'campaign.zip', Buffer.from('1234567'), 'application/zip', 'zip')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'STORAGE_LIMIT');
    assert.equal(Number((await db.query('SELECT sum(byte_size) AS bytes FROM assets WHERE workspace_id=$1', [f.workspaceId])).rows[0].bytes), 7);
    await db.query("UPDATE agent_jobs SET status='queued' WHERE id=$1", [a.id]);
    await assert.rejects(persistArtifact(limited, a, 'stale.zip', Buffer.from('one'), 'application/zip', 'zip'), { code: 'JOB_LEASE_LOST' });
  });

  await t.test('retry rechecks subscription and admits one concurrent request under the current limit', async () => {
    const f = await fixture(), j = await job(f, 'failed', 'released');
    await db.query("UPDATE subscriptions SET status='canceled' WHERE workspace_id=$1", [f.workspaceId]);
    await assert.rejects(services.retryJob(f.ctx, { jobId: j.id, idempotencyKey: `cancelled-plan:${j.id}` }), { code: 'SUBSCRIPTION_REQUIRED' });
    await db.query("UPDATE subscriptions SET status='active' WHERE workspace_id=$1", [f.workspaceId]);
    const results = await Promise.allSettled([1, 2].map(index => services.retryJob(f.ctx, { jobId: j.id, idempotencyKey: `retry:${j.id}:${index}` })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [j.id])).rows[0].status, 'queued');
    assert.equal((await services.credits(f.workspaceId)).reserved, 5);
    const next = await job(f, 'failed', 'released');
    await assert.rejects(services.retryJob(f.ctx, { jobId: next.id, idempotencyKey: `limit:${next.id}` }), { code: 'JOB_LIMIT' });
  });
});
