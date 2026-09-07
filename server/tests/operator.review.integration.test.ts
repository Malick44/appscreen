import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../db.js';
import { createAuth, ALL_SCOPES, type Context } from '../auth.js';
import { loadConfig } from '../config.js';
import { AppServices } from '../services.js';
import { createStorage } from '../storage.js';
import { Operations } from '../operator.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('independent operator review: concurrent debits and retained authorization', { skip: !databaseUrl, timeout: 30_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/);
  const db = createDatabase(databaseUrl!); t.after(() => db.end()); await migrate(db);
  const operatorId = randomUUID();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, SUPABASE_URL: 'https://isolated-auth.example.test', SUPABASE_PUBLISHABLE_KEY: 'isolated-public-test', APPSCREEN_OPERATOR_USER_IDS: operatorId, APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: await mkdtemp(join(tmpdir(), 'appscreen-operator-review-')), TRIAL_CREDITS: '20' });
  const auth = createAuth(db, config), services = new AppServices(db, config, createStorage(config)), operations = new Operations(services);
  const staffWorkspace = await auth.ensureWorkspace(operatorId, 'isolated-operator@example.test');
  // This retained context is a service-layer fixture; no live identity provider is called.
  const staff: Context = { ...await auth.resolveContext(operatorId, '', staffWorkspace, 'web', [...ALL_SCOPES]), assuranceLevel: 'aal2' };
  const fixture = async () => {
    const userId = randomUUID(), workspaceId = await auth.ensureWorkspace(userId, 'isolated-customer@example.test');
    return { userId, workspaceId };
  };
  const input = (workspaceId: string, amount: number, idempotencyKey = randomUUID()) => ({ workspaceId, amount, reason: 'Isolated review credit adjustment', idempotencyKey, confirmation: 'ADJUST CREDITS' });

  await t.test('distinct concurrent debit requests cannot consume credits reserved for a job', async () => {
    const customer = await fixture(), projectId = randomUUID(), jobId = randomUUID();
    await db.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)', [projectId, customer.workspaceId, 'Review fixture']);
    await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,input,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'design','{}',$5,$5)", [jobId, customer.workspaceId, projectId, customer.userId, randomUUID()]);
    await db.query('INSERT INTO credit_reservations(job_id,workspace_id,amount) VALUES($1,$2,12)', [jobId, customer.workspaceId]);
    const results = await Promise.allSettled([operations.adjustCredits(staff, input(customer.workspaceId, -5)), operations.adjustCredits(staff, input(customer.workspaceId, -5))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'CREDIT_ADJUSTMENT_RESERVED');
    assert.deepEqual(await services.credits(customer.workspaceId), { available: 3, reserved: 12, totalGranted: 20 });
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM credit_ledger WHERE workspace_id=$1 AND reason='operator-adjustment'", [customer.workspaceId])).rows[0].count, 1);
  });

  await t.test('reusing an adjustment key for another customer cannot modify either receipt or second balance', async () => {
    const first = await fixture(), second = await fixture(), key = randomUUID();
    const receipt = await operations.adjustCredits(staff, input(first.workspaceId, 3, key));
    await assert.rejects(operations.adjustCredits(staff, input(second.workspaceId, 3, key)), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await services.credits(first.workspaceId)).available, 23);
    assert.equal((await services.credits(second.workspaceId)).available, 20);
    assert.deepEqual(await operations.adjustCredits(staff, input(first.workspaceId, 3, key)), receipt);
  });

  await t.test('a demoted membership invalidates a previously verified operator context', async () => {
    const customer = await fixture(); await operations.authorize(staff);
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [staff.workspaceId, staff.userId]);
    try {
      await assert.rejects(operations.overview(staff), { code: 'OPERATOR_REQUIRED' });
      await assert.rejects(operations.adjustCredits(staff, input(customer.workspaceId, 1)), { code: 'OPERATOR_REQUIRED' });
      assert.equal((await services.credits(customer.workspaceId)).available, 20);
    } finally { await db.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [staff.workspaceId, staff.userId]); }
  });
});
