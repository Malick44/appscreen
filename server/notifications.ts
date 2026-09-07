import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { transaction } from './db.js';
import { AppError, invariant } from './errors.js';

const uuid = z.string().uuid();
const recipient = { workspaceId: uuid, recipientUserId: z.string().min(1).max(200) };
const jobSource = { ...recipient, jobId: uuid, attempt: z.number().int().min(1).max(2_147_483_647) };
export const NotificationInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('design-ready'), ...jobSource }).strict(),
  z.object({ kind: z.literal('needs-review'), ...jobSource }).strict(),
  z.object({ kind: z.literal('job-failed'), ...jobSource }).strict(),
  z.object({ kind: z.literal('export-ready'), ...jobSource }).strict(),
  z.object({ kind: z.literal('support-reply'), ...recipient, requestId: uuid, messageId: uuid }).strict(),
  z.object({ kind: z.literal('payment-needs-attention'), ...recipient, billingEventId: z.string().min(1).max(200) }).strict(),
]);
export type NotificationInput = z.infer<typeof NotificationInputSchema>;
export type NotificationKind = NotificationInput['kind'];
export type EnqueueNotificationResult = { notificationId: string | null; created: boolean; skipped?: 'inactive-recipient' | 'outdated-source' };

// Intentionally static: no project names, prompts, screenshots, support bodies,
// provider errors, billing identifiers, or caller-supplied links enter this inbox.
export const notificationCopy: Record<NotificationKind, { title: string; message: string }> = {
  'design-ready': { title: 'Your design is ready', message: 'A new editable campaign draft is ready to review.' },
  'needs-review': { title: 'Your campaign needs review', message: 'Open your campaign to review the saved draft and next steps.' },
  'job-failed': { title: 'A campaign job needs attention', message: 'Open your campaign to review its status and available recovery options.' },
  'export-ready': { title: 'Your export is ready', message: 'Your campaign files are ready to view and download.' },
  'payment-needs-attention': { title: 'Your payment needs attention', message: 'Open billing to review your subscription and payment options.' },
  'support-reply': { title: 'Support replied', message: 'A reply is available in your support conversation.' },
};
const skip = (skipped: NonNullable<EnqueueNotificationResult['skipped']>): EnqueueNotificationResult => ({ notificationId: null, created: false, skipped });
const idOf = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;

/** Call inside the SAME open transaction that finalizes the source event.
 * This helper never commits, starts a second connection, or performs remote I/O.
 * The initiating job user / original support requester receives the notice;
 * billing callers invoke it once for each currently active workspace owner.
 */
export async function enqueueNotification(client: pg.PoolClient, args: NotificationInput, options: { emailEnabled?: boolean } = {}): Promise<EnqueueNotificationResult> {
  const input = NotificationInputSchema.parse(args);
  let projectId: string | null = null, jobId: string | null = null, requestId: string | null = null, messageId: string | null = null;
  let eventSource: string;
  if ('jobId' in input) {
    const found = await client.query('SELECT project_id,user_id,kind,status,attempts FROM public.agent_jobs WHERE id=$1 AND workspace_id=$2 FOR SHARE', [input.jobId, input.workspaceId]);
    invariant(found.rowCount, 'NOTIFICATION_SOURCE_INVALID', 'Notification source is not available in this workspace.', 404);
    const job = found.rows[0];
    invariant(job.user_id === input.recipientUserId, 'NOTIFICATION_RECIPIENT_INVALID', 'This notification recipient does not own the source event.', 403);
    const expectedStatus = input.kind === 'job-failed' ? 'failed' : input.kind === 'needs-review' ? 'needs-input' : 'ready';
    const compatible = input.kind === 'job-failed' || input.kind === 'needs-review' || (input.kind === 'export-ready' ? ['export', 'render'] : ['design', 'revision']).includes(job.kind);
    invariant(compatible, 'NOTIFICATION_SOURCE_INVALID', 'Notification type does not match its source.');
    if (job.attempts !== input.attempt || job.status !== expectedStatus) return skip('outdated-source');
    projectId = job.project_id; jobId = input.jobId; eventSource = `job:${jobId}:${input.attempt}`;
  } else if (input.kind === 'support-reply') {
    const found = await client.query(`SELECT r.user_id,m.author_kind,m.visibility FROM public.support_messages m
      JOIN public.account_requests r ON r.id=m.request_id AND r.workspace_id=m.workspace_id
      WHERE m.id=$1 AND m.request_id=$2 AND m.workspace_id=$3 AND r.kind='support' FOR SHARE OF m,r`, [input.messageId, input.requestId, input.workspaceId]);
    invariant(found.rowCount, 'NOTIFICATION_SOURCE_INVALID', 'Notification source is not available in this workspace.', 404);
    const message = found.rows[0];
    invariant(message.user_id === input.recipientUserId, 'NOTIFICATION_RECIPIENT_INVALID', 'This notification recipient does not own the source event.', 403);
    invariant(message.author_kind === 'support' && message.visibility === 'customer', 'NOTIFICATION_SOURCE_INVALID', 'Only a public support reply can create this notification.');
    requestId = input.requestId; messageId = input.messageId; eventSource = `support:${messageId}`;
  } else {
    const event = await client.query('SELECT type,payload FROM public.billing_events WHERE id=$1 FOR SHARE', [input.billingEventId]);
    invariant(event.rowCount && event.rows[0].type === 'invoice.payment_failed', 'NOTIFICATION_SOURCE_INVALID', 'Notification type does not match its source.');
    const subscription = await client.query('SELECT customer_id,subscription_id,status FROM public.subscriptions WHERE workspace_id=$1 FOR SHARE', [input.workspaceId]);
    const invoice = event.rows[0].payload?.data?.object, current = subscription.rows[0];
    invariant(current?.customer_id && idOf(invoice?.customer) === current.customer_id, 'NOTIFICATION_SOURCE_INVALID', 'Notification source is not available in this workspace.', 404);
    const subscriptionId = idOf(invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription);
    if (!subscriptionId || subscriptionId !== current.subscription_id || invoice?.status === 'paid' || !['past_due', 'unpaid', 'incomplete'].includes(current.status)) return skip('outdated-source');
    eventSource = `billing:${input.billingEventId}`;
  }
  // SHARE (not KEY SHARE) also serializes status/role revocation with delivery.
  const member = await client.query('SELECT role,status FROM public.workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [input.workspaceId, input.recipientUserId]);
  if (!member.rowCount || member.rows[0].status !== 'active') return skip('inactive-recipient');
  invariant(input.kind !== 'payment-needs-attention' || member.rows[0].role === 'owner', 'NOTIFICATION_RECIPIENT_INVALID', 'Payment notices are only available to workspace owners.', 403);
  const eventKey = createHash('sha256').update(`${input.kind}:${eventSource}`).digest('hex');
  const saved = await client.query(`INSERT INTO public.notifications(id,workspace_id,recipient_user_id,kind,event_key,project_id,job_id,request_id,message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,recipient_user_id,event_key) DO NOTHING RETURNING id`,
  [randomUUID(), input.workspaceId, input.recipientUserId, input.kind, eventKey, projectId, jobId, requestId, messageId]);
  if (saved.rowCount) {
    if(options.emailEnabled) {
      const preferences=await client.query('SELECT version FROM public.email_preferences WHERE workspace_id=$1 AND user_id=$2 AND enabled=true FOR SHARE',[input.workspaceId,input.recipientUserId]);
      if(preferences.rowCount)await client.query('INSERT INTO public.email_outbox(id,notification_id,workspace_id,recipient_user_id,preference_version) VALUES($1,$2,$3,$4,$5)',[randomUUID(),saved.rows[0].id,input.workspaceId,input.recipientUserId,preferences.rows[0].version]);
    }
    return { notificationId: saved.rows[0].id, created: true };
  }
  const existing = await client.query('SELECT id FROM public.notifications WHERE workspace_id=$1 AND recipient_user_id=$2 AND event_key=$3', [input.workspaceId, input.recipientUserId, eventKey]);
  invariant(existing.rowCount, 'NOTIFICATION_RETRY_REQUIRED', 'Notification delivery must be retried.', 409);
  return { notificationId: existing.rows[0].id, created: false };
}

const listInput = z.object({
  limit: z.preprocess(value => typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value, z.number().int().min(1).max(50).default(20)),
  cursor: z.string().min(1).max(1024).optional(),
  unreadOnly: z.preprocess(value => value === 'true' ? true : value === 'false' ? false : value, z.boolean().default(false)),
}).strict();
const markInput = z.object({ ids: z.array(uuid).min(1).max(50).refine(ids => new Set(ids).size === ids.length, 'Choose each notification only once.') }).strict();
const cursorInput = z.object({ v: z.literal(1), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: uuid, unread: z.boolean() }).strict();
type Cursor = z.infer<typeof cursorInput>;
type NotificationRow = { id: string; kind: NotificationKind; project_id: string | null; request_id: string | null; created_at: Date; read_at: Date | null; cursor_at: string };
export type PublicNotification = { id: string; kind: NotificationKind; title: string; message: string; href: string; createdAt: string; readAt: string | null };
function publicNotification(record: NotificationRow): PublicNotification {
  return { id: record.id, kind: record.kind, ...notificationCopy[record.kind],
    href: record.kind === 'support-reply' ? `/app/support/${record.request_id}` : record.kind === 'payment-needs-attention' ? '/app/billing' : `/app/projects/${record.project_id}`,
    createdAt: record.created_at.toISOString(), readAt: record.read_at?.toISOString() ?? null };
}

export class Notifications {
  constructor(public services: AppServices) {}

  private async authorize(ctx: Context, client: pg.PoolClient) {
    invariant((ctx.authKind === 'web' || ctx.authKind === 'development') && !ctx.connection, 'BROWSER_SESSION_REQUIRED', 'Open AppScreen to manage your notifications.', 403);
    const active = await client.query("SELECT user_id FROM public.workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE", [ctx.workspaceId, ctx.userId]);
    invariant(active.rowCount, 'WORKSPACE_FORBIDDEN', 'Workspace access was revoked.', 403);
  }
  private signature(ctx: Context, payload: string) {
    return createHmac('sha256', this.services.config.signingSecret).update(JSON.stringify(['appscreen-notifications-v1', ctx.workspaceId, ctx.userId, payload])).digest();
  }
  private encodeCursor(ctx: Context, cursor: Cursor) {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${this.signature(ctx, payload).toString('base64url')}`;
  }
  private decodeCursor(ctx: Context, token: string, unreadOnly: boolean): Cursor {
    try {
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined || !/^[a-zA-Z0-9_-]+$/.test(payload) || !/^[a-zA-Z0-9_-]{43}$/.test(signature)) throw new Error('invalid');
      const actual = Buffer.from(signature, 'base64url'), expected = this.signature(ctx, payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid');
      const cursor = cursorInput.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (cursor.unread !== unreadOnly || Number.isNaN(Date.parse(cursor.at))) throw new Error('invalid');
      return cursor;
    } catch { throw new AppError('NOTIFICATION_CURSOR_INVALID', 'Reload the notification inbox before continuing.', 400); }
  }
  private async count(client: pg.PoolClient, ctx: Context) {
    return (await client.query('SELECT count(*)::integer AS count FROM public.notifications WHERE workspace_id=$1 AND recipient_user_id=$2 AND read_at IS NULL', [ctx.workspaceId, ctx.userId])).rows[0].count as number;
  }
  async list(ctx: Context, args: unknown = {}): Promise<{ notifications: PublicNotification[]; unreadCount: number; nextCursor: string | null }> {
    const input = listInput.parse(args);
    return transaction(this.services.db, async client => {
      await this.authorize(ctx, client);
      const cursor = input.cursor ? this.decodeCursor(ctx, input.cursor, input.unreadOnly) : null;
      const params: unknown[] = [ctx.workspaceId, ctx.userId];
      const filters = ['workspace_id=$1', 'recipient_user_id=$2'];
      if (input.unreadOnly) filters.push('read_at IS NULL');
      if (cursor) { params.push(cursor.at, cursor.id); filters.push('(created_at,id)<($3::timestamptz,$4::uuid)'); }
      params.push(input.limit + 1);
      // Preserve PostgreSQL microseconds in cursors. JS Date loses precision and
      // would skip rows created within the last displayed millisecond.
      const rows = (await client.query<NotificationRow>(`SELECT id,kind,project_id,request_id,created_at,read_at,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM public.notifications WHERE ${filters.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params)).rows;
      const page = rows.slice(0, input.limit), last = page.at(-1);
      return { notifications: page.map(publicNotification), unreadCount: await this.count(client, ctx),
        nextCursor: rows.length > input.limit && last ? this.encodeCursor(ctx, { v: 1, at: last.cursor_at, id: last.id, unread: input.unreadOnly }) : null };
    });
  }
  async unreadCount(ctx: Context): Promise<{ unreadCount: number }> {
    return transaction(this.services.db, async client => { await this.authorize(ctx, client); return { unreadCount: await this.count(client, ctx) }; });
  }
  async markRead(ctx: Context, args: unknown): Promise<{ readIds: string[]; unreadCount: number }> {
    const input = markInput.parse(args);
    return transaction(this.services.db, async client => {
      await this.authorize(ctx, client);
      // Lock in one order to avoid deadlocks for overlapping batches; fail the
      // entire request if even one ID is missing/foreign. There is no mark-all.
      const owned = await client.query('SELECT id FROM public.notifications WHERE workspace_id=$1 AND recipient_user_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE', [ctx.workspaceId, ctx.userId, input.ids]);
      invariant(owned.rowCount === input.ids.length, 'NOTIFICATION_NOT_FOUND', 'One or more notifications are no longer available.', 404);
      await client.query('UPDATE public.notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE workspace_id=$1 AND recipient_user_id=$2 AND id=ANY($3::uuid[])', [ctx.workspaceId, ctx.userId, input.ids]);
      return { readIds: input.ids, unreadCount: await this.count(client, ctx) };
    });
  }
}
