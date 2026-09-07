import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, transaction, verifyMigrations } from '../db.js';
import { ALL_SCOPES, createAuth, type Context } from '../auth.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { createApp } from '../app.js';
import { SupportCases } from '../support.js';
import { enqueueNotification, Notifications, NotificationInputSchema, type NotificationInput } from '../notifications.js';

test('notification inputs prohibit dynamic content, links, unknown kinds, and unbounded source IDs', () => {
  const input = { kind: 'design-ready', workspaceId: randomUUID(), recipientUserId: 'fixture-user', jobId: randomUUID(), attempt: 1 };
  assert.equal(NotificationInputSchema.safeParse(input).success, true);
  for (const extra of [{ message: 'secret prompt' }, { href: 'https://evil.example.test' }, { title: 'provider error' }, { payload: { image: 'data:image/png;base64,...' } }]) assert.equal(NotificationInputSchema.safeParse({ ...input, ...extra }).success, false);
  for (const patch of [{ kind: 'email-sent' }, { attempt: 0 }, { attempt: 1.5 }, { jobId: 'file:///etc/passwd' }, { recipientUserId: 'x'.repeat(201) }]) assert.equal(NotificationInputSchema.safeParse({ ...input, ...patch }).success, false);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('durable recipient-scoped notification inbox', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/);
  const db = createDatabase(databaseUrl!); t.after(() => db.end());
  // DDL is a separate coordinated step, not work each parallel test repeats.
  await verifyMigrations(db);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: await mkdtemp(join(tmpdir(), 'appscreen-notifications-test-')) });
  const services = new AppServices(db, config, createStorage(config)), inbox = new Notifications(services);
  const fixture = async (workspaceId: string = randomUUID(), role = 'owner') => {
    const userId = randomUUID();
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [workspaceId, 'Synthetic notification test workspace']);
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,$4)', [workspaceId, userId, 'notification-fixture@example.test', role]);
    await db.query('INSERT INTO subscriptions(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [workspaceId]);
    const ctx: Context = { workspaceId, userId, email: 'notification-fixture@example.test', role, authKind: 'development', scopes: [...ALL_SCOPES] };
    return ctx;
  };
  const job = async (ctx: Context, kind = 'design', status = 'ready', attempts = 1) => {
    const id = randomUUID(), projectId = randomUUID(), key = randomUUID();
    await db.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)', [projectId, ctx.workspaceId, 'Private synthetic app name should not appear in notices']);
    await db.query('INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,input,result,error,idempotency_key,request_hash,attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)', [id, ctx.workspaceId, projectId, ctx.userId, kind, status, { prompt: 'PRIVATE PROMPT' }, { provider: 'PRIVATE PROVIDER' }, { message: 'PRIVATE FAILURE' }, key, attempts]);
    return { id, projectId, input: { kind: 'design-ready', workspaceId: ctx.workspaceId, recipientUserId: ctx.userId, jobId: id, attempt: attempts } as NotificationInput };
  };
  const deliver = (input: NotificationInput) => transaction(db, client => enqueueNotification(client, input));
  const support = async (ctx: Context, authorKind = 'support', visibility = 'customer') => {
    const requestId = randomUUID(), messageId = randomUUID();
    await db.query("INSERT INTO account_requests(id,workspace_id,user_id,kind,details) VALUES($1,$2,$3,'support',$4)", [requestId, ctx.workspaceId, ctx.userId, { message: 'PRIVATE ORIGINAL MESSAGE' }]);
    await db.query('INSERT INTO support_messages(id,request_id,workspace_id,author_id,author_kind,visibility,body) VALUES($1,$2,$3,$4,$5,$6,$7)', [messageId, requestId, ctx.workspaceId, randomUUID(), authorKind, visibility, 'PRIVATE SUPPORT BODY']);
    return { kind: 'support-reply', workspaceId: ctx.workspaceId, recipientUserId: ctx.userId, requestId, messageId } as const;
  };
  const payment = async (ctx: Context, status = 'past_due') => {
    const customerId = `cus_test_${randomUUID()}`, subscriptionId = `sub_test_${randomUUID()}`, billingEventId = `evt_test_${randomUUID()}`;
    await db.query('UPDATE subscriptions SET customer_id=$1,subscription_id=$2,status=$3 WHERE workspace_id=$4', [customerId, subscriptionId, status, ctx.workspaceId]);
    await db.query("INSERT INTO billing_events(id,type,payload) VALUES($1,'invoice.payment_failed',$2)", [billingEventId, { id: billingEventId, type: 'invoice.payment_failed', data: { object: { id: `in_test_${randomUUID()}`, customer: customerId, parent: { subscription_details: { subscription: subscriptionId } }, status: 'open', privateMetadata: 'PRIVATE BILLING CONTENT' } } }]);
    return { kind: 'payment-needs-attention', workspaceId: ctx.workspaceId, recipientUserId: ctx.userId, billingEventId } as const;
  };

  await t.test('all six event templates expose only static text and bounded app links', async () => {
    const ctx = await fixture();
    const design = await job(ctx), review = await job(ctx, 'revision', 'needs-input'), failed = await job(ctx, 'design', 'failed'), exported = await job(ctx, 'export');
    for (const input of [design.input, { ...review.input, kind: 'needs-review' }, { ...failed.input, kind: 'job-failed' }, { ...exported.input, kind: 'export-ready' }, await support(ctx), await payment(ctx)] as NotificationInput[]) assert.equal((await deliver(input)).created, true);
    const result = await inbox.list(ctx);
    assert.equal(result.notifications.length, 6); assert.equal(result.unreadCount, 6); assert.equal(result.nextCursor, null);
    assert.deepEqual(new Set(result.notifications.map(n => n.kind)), new Set(['design-ready', 'needs-review', 'job-failed', 'export-ready', 'support-reply', 'payment-needs-attention']));
    for (const notice of result.notifications) {
      assert.deepEqual(Object.keys(notice).sort(), ['id', 'kind', 'title', 'message', 'href', 'createdAt', 'readAt'].sort());
      assert.match(notice.href, /^\/app\/(billing$|(?:projects|support)\/[a-f0-9-]{36}$)/);
      assert.equal(notice.readAt, null);
    }
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cus_test_|sub_test_|evt_test_|fixture@example|event_key|recipientUser|storage_key/);
    const persisted = await db.query('SELECT * FROM notifications WHERE workspace_id=$1', [ctx.workspaceId]);
    assert.doesNotMatch(JSON.stringify(persisted.rows), /PRIVATE|cus_test_|sub_test_|evt_test_|fixture@example/);
  });

  await t.test('duplicate and concurrent source retries create one notice without resetting read state', async () => {
    const ctx = await fixture(), source = await job(ctx);
    const deliveries = await Promise.all(Array.from({ length: 6 }, () => deliver(source.input)));
    assert.equal(deliveries.filter(result => result.created).length, 1);
    const id = deliveries[0].notificationId!; assert.equal(new Set(deliveries.map(result => result.notificationId)).size, 1);
    assert.deepEqual(await inbox.markRead(ctx, { ids: [id] }), { readIds: [id], unreadCount: 0 });
    const initialRead = (await inbox.list(ctx)).notifications[0].readAt;
    assert.ok(initialRead); assert.equal((await deliver(source.input)).created, false);
    await inbox.markRead(ctx, { ids: [id] });
    assert.equal((await inbox.list(ctx)).notifications[0].readAt, initialRead);
  });

  await t.test('a source transaction rollback rolls notification delivery back with it', async () => {
    const ctx = await fixture(), source = await job(ctx, 'design', 'running');
    await assert.rejects(transaction(db, async client => {
      await client.query("UPDATE agent_jobs SET status='ready' WHERE id=$1", [source.id]);
      assert.equal((await enqueueNotification(client, source.input)).created, true);
      throw new Error('synthetic source transaction failed');
    }), /synthetic source/);
    assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [source.id])).rows[0].status, 'running');
    assert.equal((await inbox.unreadCount(ctx)).unreadCount, 0);
    await transaction(db, async client => { await client.query("UPDATE agent_jobs SET status='ready' WHERE id=$1", [source.id]); await enqueueNotification(client, source.input); });
    assert.equal((await inbox.unreadCount(ctx)).unreadCount, 1);
  });

  await t.test('source ownership, recipient ownership, terminal kind, and current attempt are checked', async () => {
    const ctx = await fixture(), stranger = await fixture(), source = await job(ctx);
    await assert.rejects(deliver({ ...source.input, workspaceId: stranger.workspaceId }), { code: 'NOTIFICATION_SOURCE_INVALID' });
    await assert.rejects(deliver({ ...source.input, recipientUserId: stranger.userId }), { code: 'NOTIFICATION_RECIPIENT_INVALID' });
    await assert.rejects(deliver({ ...source.input, kind: 'export-ready' } as NotificationInput), { code: 'NOTIFICATION_SOURCE_INVALID' });
    assert.deepEqual(await deliver({ ...source.input, attempt: 2 } as NotificationInput), { notificationId: null, created: false, skipped: 'outdated-source' });
    await db.query("UPDATE agent_jobs SET status='cancelled' WHERE id=$1", [source.id]);
    assert.equal((await deliver(source.input)).skipped, 'outdated-source');
    assert.equal((await inbox.unreadCount(ctx)).unreadCount, 0);
    for (const input of [await support(ctx, 'customer'), await support(ctx, 'support', 'internal')]) await assert.rejects(deliver(input), { code: 'NOTIFICATION_SOURCE_INVALID' });
    const reply = await support(ctx);
    await assert.rejects(deliver({ ...reply, recipientUserId: stranger.userId }), { code: 'NOTIFICATION_RECIPIENT_INVALID' });
    await assert.rejects(deliver({ ...reply, workspaceId: stranger.workspaceId }), { code: 'NOTIFICATION_SOURCE_INVALID' });
  });

  await t.test('payment notices require current subscription ownership and skip stale failures', async () => {
    const ctx = await fixture(), input = await payment(ctx), stranger = await fixture();
    await assert.rejects(deliver({ ...input, workspaceId: stranger.workspaceId, recipientUserId: stranger.userId }), { code: 'NOTIFICATION_SOURCE_INVALID' });
    const member = await fixture(ctx.workspaceId, 'member');
    await assert.rejects(deliver({ ...input, recipientUserId: member.userId }), { code: 'NOTIFICATION_RECIPIENT_INVALID' });
    await db.query("UPDATE subscriptions SET status='active' WHERE workspace_id=$1", [ctx.workspaceId]);
    assert.equal((await deliver(input)).skipped, 'outdated-source');
    await db.query("UPDATE subscriptions SET status='past_due',subscription_id=$2 WHERE workspace_id=$1", [ctx.workspaceId, `sub_new_${randomUUID()}`]);
    assert.equal((await deliver(input)).skipped, 'outdated-source');
    const current = await payment(ctx);
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
    assert.equal((await deliver(current)).skipped, 'inactive-recipient');
  });

  await t.test('inbox reads and atomic mark-read are scoped by workspace AND recipient', async () => {
    const ctx = await fixture(), teammate = await fixture(ctx.workspaceId, 'member'), stranger = await fixture();
    const mine = (await deliver((await job(ctx)).input)).notificationId!, teamId = (await deliver((await job(teammate)).input)).notificationId!, foreignId = (await deliver((await job(stranger)).input)).notificationId!;
    assert.deepEqual((await inbox.list(ctx)).notifications.map(n => n.id), [mine]);
    for (const id of [teamId, foreignId, randomUUID()]) await assert.rejects(inbox.markRead(ctx, { ids: [mine, id] }), { code: 'NOTIFICATION_NOT_FOUND' });
    assert.equal((await inbox.list(ctx)).notifications[0].readAt, null);
    assert.deepEqual(await inbox.markRead(ctx, { ids: [mine] }), { readIds: [mine], unreadCount: 0 });
    assert.equal((await inbox.unreadCount(teammate)).unreadCount, 1); assert.equal((await inbox.unreadCount(stranger)).unreadCount, 1);
    for (const operation of [(context: Context) => inbox.list(context), (context: Context) => inbox.unreadCount(context), (context: Context) => inbox.markRead(context, { ids: [mine] })]) {
      await assert.rejects(operation({ ...ctx, authKind: 'mcp' }), { code: 'BROWSER_SESSION_REQUIRED' });
      await assert.rejects(operation({ ...ctx, connection: { kind: 'token', id: randomUUID() } }), { code: 'BROWSER_SESSION_REQUIRED' });
    }
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
    await assert.rejects(inbox.list(ctx), { code: 'WORKSPACE_FORBIDDEN' });
    await assert.rejects(inbox.unreadCount(ctx), { code: 'WORKSPACE_FORBIDDEN' });
    await assert.rejects(inbox.markRead(ctx, { ids: [mine] }), { code: 'WORKSPACE_FORBIDDEN' });
    assert.equal((await deliver((await job(ctx)).input)).skipped, 'inactive-recipient');
  });

  await t.test('opaque keyset paging preserves microseconds and binds recipient and unread filter', async () => {
    const ctx = await fixture(), teammate = await fixture(ctx.workspaceId), stranger = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = (await deliver((await job(ctx)).input)).notificationId!; ids.push(id);
      await db.query('UPDATE notifications SET created_at=$2::timestamptz WHERE id=$1', [id, `2026-09-04T10:00:00.00000${i}Z`]);
    }
    const first = await inbox.list(ctx, { limit: '2', unreadOnly: 'false' });
    assert.deepEqual(first.notifications.map(n => n.id), ids.slice(3).reverse()); assert.ok(first.nextCursor);
    const second = await inbox.list(ctx, { limit: 2, cursor: first.nextCursor });
    const third = await inbox.list(ctx, { limit: 2, cursor: second.nextCursor });
    assert.deepEqual([...first.notifications, ...second.notifications, ...third.notifications].map(n => n.id), [...ids].reverse());
    assert.equal(third.nextCursor, null);
    for (const context of [teammate, stranger]) await assert.rejects(inbox.list(context, { cursor: first.nextCursor }), { code: 'NOTIFICATION_CURSOR_INVALID' });
    await assert.rejects(inbox.list(ctx, { cursor: first.nextCursor, unreadOnly: true }), { code: 'NOTIFICATION_CURSOR_INVALID' });
    await assert.rejects(inbox.list(ctx, { cursor: `${first.nextCursor}.extra` }), { code: 'NOTIFICATION_CURSOR_INVALID' });
    await inbox.markRead(ctx, { ids: [ids[4]] });
    assert.equal((await inbox.list(ctx, { unreadOnly: 'true' })).notifications.length, 4);
    assert.equal((await inbox.list(ctx, { unreadOnly: 'false' })).notifications.length, 5);
    for (const input of [{ limit: 51 }, { limit: 0 }, { limit: '1;SELECT' }, { unreadOnly: '0' }, { userId: teammate.userId }]) await assert.rejects(inbox.list(ctx, input));
    for (const input of [{ ids: [] }, { ids: Array(51).fill(randomUUID()) }, { ids: [ids[0], ids[0]] }, { ids: [ids[0]], all: true }]) await assert.rejects(inbox.markRead(ctx, input));
  });

  await t.test('overlapping concurrent read batches cannot lose read state or deadlock', async () => {
    const ctx = await fixture(), ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await deliver((await job(ctx)).input)).notificationId!);
    await Promise.all([inbox.markRead(ctx, { ids: [ids[0], ids[1]] }), inbox.markRead(ctx, { ids: [ids[2], ids[1]] })]);
    assert.equal((await inbox.unreadCount(ctx)).unreadCount, 0);
    assert.equal((await inbox.list(ctx)).notifications.filter(n => n.readAt).length, 3);
  });

  await t.test('membership revocation waits for in-flight delivery then prevents future access', async () => {
    const ctx = await fixture(), source = await job(ctx), writer = await db.connect(), revoker = await db.connect();
    try {
      await writer.query('BEGIN'); await enqueueNotification(writer, source.input);
      const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const revocation = revoker.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
      let waiting = false;
      for (let i = 0; i < 40; i++) {
        if ((await db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'revocation must wait for recipient SHARE lock');
      await writer.query('COMMIT'); await revocation;
      await assert.rejects(inbox.list(ctx), { code: 'WORKSPACE_FORBIDDEN' });
      assert.equal((await deliver(source.input)).skipped, 'inactive-recipient');
    } finally { await writer.query('ROLLBACK'); writer.release(); revoker.release(); }
  });

  await t.test('finishJob preserves export QA needs-input and atomically adds one current-attempt notice', async () => {
    const ctx = await fixture(), source = await job(ctx, 'export', 'running');
    await db.query('INSERT INTO credit_reservations(job_id,workspace_id,amount) VALUES($1,$2,0)', [source.id, ctx.workspaceId]);
    assert.equal(await services.finishJob(source.id, { status: 'needs-input', success: true, expectedAttempt: 1, result: { warnings: [{ code: 'REVIEW_EXPORT', message: 'PRIVATE QA NOTE' }] } }), true);
    assert.equal((await db.query('SELECT status FROM agent_jobs WHERE id=$1', [source.id])).rows[0].status, 'needs-input');
    const notices = await inbox.list(ctx); assert.equal(notices.notifications.length, 1); assert.equal(notices.notifications[0].kind, 'needs-review');
    assert.doesNotMatch(JSON.stringify(notices), /PRIVATE QA/);
    assert.equal(await services.finishJob(source.id, { status: 'failed', success: false, expectedAttempt: 1, error: { message: 'PRIVATE OLD WORKER FAILURE' } }), false);
    assert.equal((await inbox.unreadCount(ctx)).unreadCount, 1);
  });

  await t.test('an operator replying to their own case races safely with their customer follow-up', async () => {
    const ctx = await fixture(), source = await support(ctx);
    const staffServices = new AppServices(db, { ...config, operatorUserIds: [ctx.userId] }, services.storage);
    const cases = new SupportCases(staffServices, { onStaffReply: (client, input) => enqueueNotification(client, { kind: 'support-reply', ...input }) });
    const staffInput = { expectedVersion: 1, idempotencyKey: randomUUID(), message: 'Synthetic public staff reply.' };
    const results = await Promise.allSettled([
      cases.operatorReply(ctx, source.requestId, staffInput),
      cases.customerFollowUp(ctx, source.requestId, { expectedVersion: 1, idempotencyKey: randomUUID(), message: 'Synthetic customer follow-up.' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const conflict = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(conflict.reason.code, 'SUPPORT_VERSION_CONFLICT');
    if (results[0].status === 'rejected') await cases.operatorReply(ctx, source.requestId, { ...staffInput, expectedVersion: 2 });
    const notices = await inbox.list(ctx); assert.equal(notices.notifications.length, 1); assert.equal(notices.notifications[0].kind, 'support-reply');
  });

  await t.test('HTTP browser routes deny agent credentials, cross-origin writes, and foreign IDs', async () => {
    const { app } = await createApp(config, db); t.after(() => app.close());
    const auth = createAuth(db, config), email = `notification-http-${randomUUID()}@example.test`;
    const { token } = await auth.developmentSession(email);
    const headers = { authorization: `Bearer ${token}`, origin: new URL(config.baseUrl).origin };
    const session = (await app.inject({ url: '/api/session', headers })).json();
    const ctx = await auth.resolveContext(session.user.id, email, session.workspace.id, 'development', [...ALL_SCOPES]);
    const id = (await deliver((await job(ctx)).input)).notificationId!;
    const page = await app.inject({ url: '/api/notifications?limit=1&unreadOnly=true', headers });
    assert.equal(page.statusCode, 200); assert.equal(page.json().notifications[0].id, id);
    assert.equal((await app.inject({ url: '/api/notifications/unread-count', headers })).json().unreadCount, 1);
    const connection = await auth.issueToken(ctx, 'Synthetic inbox denial check', [...ALL_SCOPES]);
    for (const url of ['/api/notifications', '/api/notifications/unread-count']) assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${connection.token}` } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { authorization: `Bearer ${connection.token}` }, payload: { ids: [id] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { ...headers, origin: 'https://foreign.example.test' }, payload: { ids: [id] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/read', headers, payload: { ids: [id, randomUUID()] } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/read', headers, payload: { ids: [id] } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/notifications/unread-count', headers })).json().unreadCount, 0);
    await db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [connection.id]);
  });

  await t.test('database client roles have no direct notification access or policies', async () => {
    const table = (await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.notifications'::regclass")).rows[0]; assert.equal(table.relrowsecurity, true);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM pg_policies WHERE schemaname='public' AND tablename='notifications'")).rows[0].count, 0);
    for (const role of ['anon', 'authenticated']) if ((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
      const access = (await db.query("SELECT has_table_privilege($1,'public.notifications','SELECT,INSERT,UPDATE,DELETE') AS allowed", [role])).rows[0]; assert.equal(access.allowed, false);
    }
  });
});
