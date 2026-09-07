import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { z } from 'zod';
import type { Context } from './auth.js';
import type { Config } from './config.js';
import type { AppServices } from './services.js';
import { transaction } from './db.js';
import { invariant } from './errors.js';
import { Operations } from './operator.js';
import { notificationCopy, type NotificationKind } from './notifications.js';
import { createResendProvider, EmailDeliveryError, verifyResendEvent, type EmailPayload } from './email-provider.js';

const emailSchema=z.string().trim().email().max(254);
export function recipientHash(email:string) { return createHash('sha256').update(email.trim().toLowerCase()).digest('hex'); }
const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Freeze the complete provider request before sending; changing code, the sender,
 * or APP_BASE_URL must never change a retried request's idempotency payload. */
export function serviceEmail(config:Config,kind:NotificationKind,email:string):EmailPayload {
  const copy=notificationCopy[kind],url=new URL('/app/inbox',config.baseUrl).href;
  return {from:`AppScreen <${config.emailFrom}>`,to:[emailSchema.parse(email)],subject:copy.title,
    text:`${copy.title}\n\n${copy.message}\n\nSign in to AppScreen to view the update: ${url}\n\nYou enabled service emails for your workspace. Manage email preferences in your AppScreen inbox. Account sign-in and recovery emails are managed separately.`,
    html:`<!doctype html><html lang="en"><body><h1>${escape(copy.title)}</h1><p>${escape(copy.message)}</p><p><a href="${escape(url)}">View your AppScreen updates</a></p><p>You enabled service emails for your workspace. Manage email preferences in your AppScreen inbox. Account sign-in and recovery emails are managed separately.</p></body></html>`};
}

/** Membership email is not identity evidence: resolve the current, confirmed
 * Supabase Auth email on every attempt. Never redirect an old intent to a new
 * address. No client-supplied destination or local-development fallback. */
export function verifiedEmailResolver(config:Config) {
  const auth=config.supabaseServiceKey&&config.supabaseUrl&&!config.developmentAuth?createClient(config.supabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,options)=>fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10_000)})}}):null;
  return async(userId:string):Promise<string|null>=>{
    if(!auth||!z.string().uuid().safeParse(userId).success)return null;
    let result;
    try{result=await auth.auth.admin.getUserById(userId);}catch{throw new EmailDeliveryError('EMAIL_IDENTITY_UNAVAILABLE',true);}
    if(result.error){if(result.error.status===404)return null;throw new EmailDeliveryError('EMAIL_IDENTITY_UNAVAILABLE',true);}
    const user=result.data.user;
    if(!user||user.id!==userId||user.is_anonymous||user.deleted_at||!user.email_confirmed_at||!Number.isFinite(Date.parse(user.email_confirmed_at))||Date.parse(user.email_confirmed_at)>Date.now()||(user.banned_until&&Date.parse(user.banned_until)>Date.now()))return null;
    const email=emailSchema.safeParse(user.email);
    return email.success?email.data:null;
  };
}

const preferenceInput=z.object({enabled:z.boolean(),expectedVersion:z.number().int().min(0).max(2_147_483_646)}).strict();
const eventStatus:Record<string,string>={'email.sent':'accepted','email.delivered':'delivered','email.delivery_delayed':'delayed','email.bounced':'bounced','email.complained':'complained','email.failed':'failed','email.suppressed':'suppressed'};
// Negative terminal evidence must not be erased by a late "sent"/"delivered".
const ranks:Record<string,number>={accepted:1,delayed:2,delivered:3,failed:4,suppressed:5,bounced:6,complained:7};
type EmailOptions={provider?:ReturnType<typeof createResendProvider>;resolveEmail?:(userId:string)=>Promise<string|null>};
export class EmailDelivery {
  private provider:ReturnType<typeof createResendProvider>;
  private resolveEmail:(userId:string)=>Promise<string|null>;
  constructor(public services:AppServices,options:EmailOptions={}) {
    this.provider=options.provider||createResendProvider(services.config.resendKey);
    this.resolveEmail=options.resolveEmail||verifiedEmailResolver(services.config);
  }
  private async authorize(ctx:Context,client:pg.PoolClient,exclusive=false) {
    invariant((ctx.authKind==='web'||ctx.authKind==='development')&&!ctx.connection,'BROWSER_SESSION_REQUIRED','Open AppScreen to manage email preferences.',403);
    const member=await client.query(`SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR ${exclusive?'UPDATE':'SHARE'}`,[ctx.workspaceId,ctx.userId]);
    invariant(member.rowCount,'WORKSPACE_FORBIDDEN','Workspace access was revoked.',403);
  }
  private publicPreference(row:any) {return {enabled:row?.enabled??false,version:row?.version??0,updatedAt:row?.updated_at?.toISOString()??null,sendingAvailable:this.services.config.emailEnabled};}
  async preferences(ctx:Context) {
    return transaction(this.services.db,async client=>{await this.authorize(ctx,client);return this.publicPreference((await client.query('SELECT enabled,version,updated_at FROM email_preferences WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId])).rows[0]);});
  }
  async savePreferences(ctx:Context,args:unknown) {
    const input=preferenceInput.parse(args);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client,true);
      const current=(await client.query('SELECT enabled,version,updated_at FROM email_preferences WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.workspaceId,ctx.userId])).rows[0];
      if(current?.enabled===input.enabled&&current.version===input.expectedVersion+1)return this.publicPreference(current);
      invariant(input.expectedVersion===(current?.version??0),'EMAIL_PREFERENCES_CHANGED','Email preferences changed. Reload them before saving again.',409);
      invariant(!input.enabled||this.services.config.emailEnabled,'EMAIL_SENDING_UNAVAILABLE','Service email is not available yet. Your in-app updates are still available.',503);
      if(current?.enabled===input.enabled)return this.publicPreference(current);
      const result=await client.query(`INSERT INTO email_preferences(workspace_id,user_id,enabled,version) VALUES($1,$2,$3,1)
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET enabled=$3,version=email_preferences.version+1,updated_at=clock_timestamp() RETURNING enabled,version,updated_at`,[ctx.workspaceId,ctx.userId,input.enabled]);
      return this.publicPreference(result.rows[0]);
    });
  }

  /** No network while claiming. A crashed send retains the SAME intent/key.
   * 23 hours leaves margin before Resend's 24-hour deduplication expires. */
  private async claim() {
    return transaction(this.services.db,async client=>{
      const found=await client.query(`SELECT * FROM email_outbox WHERE
        (status IN ('queued','retry') AND next_attempt_at<=clock_timestamp()) OR
        (status='sending' AND lease_until<clock_timestamp())
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row=found.rows[0];if(!row)return null;
      const expired=(await client.query("SELECT $1::timestamptz<clock_timestamp()-interval '23 hours' AS attempted,$2::timestamptz<clock_timestamp()-interval '24 hours' AS queued",[row.first_attempt_at,row.created_at])).rows[0];
      if(expired.attempted||expired.queued||row.attempts>=8){
        await client.query("UPDATE email_outbox SET status=$2,error_code=$3,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",[row.id,row.first_attempt_at?'review-needed':'skipped',row.first_attempt_at?'EMAIL_RETRY_REVIEW_REQUIRED':'EMAIL_NOTICE_EXPIRED']);return null;
      }
      const claimed=await client.query("UPDATE email_outbox SET status='sending',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,randomUUID()]);
      return claimed.rows[0];
    });
  }
  private async finish(row:any,status:string,errorCode:string|null=null) {
    await this.services.db.query("UPDATE email_outbox SET status=$3,error_code=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+($5*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND status='sending'",[row.id,row.lease_id,status,errorCode,Math.min(3600,30*2**Math.min(row.attempts-1,7))]);
  }
  private async prepare(row:any,email:string):Promise<EmailPayload|null> {
    return transaction(this.services.db,async client=>{
      const member=(await client.query('SELECT status,role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,row.recipient_user_id])).rows[0];
      const preference=(await client.query('SELECT enabled,version FROM email_preferences WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[row.workspace_id,row.recipient_user_id])).rows[0];
      const current=(await client.query("SELECT o.*,n.kind FROM email_outbox o JOIN notifications n ON n.id=o.notification_id WHERE o.id=$1 AND o.lease_id=$2 AND o.status='sending' AND o.lease_until>clock_timestamp() FOR UPDATE OF o",[row.id,row.lease_id])).rows[0];
      if(!current)return null;
      let skip:string|null=null;
      if(member?.status!=='active'||(current.kind==='payment-needs-attention'&&member.role!=='owner'))skip='EMAIL_ACCESS_REVOKED';
      else if(!preference?.enabled||preference.version!==row.preference_version)skip='EMAIL_PREFERENCE_CHANGED';
      else if(current.recipient_hash&&current.recipient_hash!==recipientHash(email))skip='EMAIL_RECIPIENT_CHANGED';
      else if((await client.query('SELECT 1 FROM email_suppressions WHERE recipient_hash=$1',[recipientHash(email)])).rowCount)skip='EMAIL_RECIPIENT_SUPPRESSED';
      if(skip){await client.query("UPDATE email_outbox SET status='skipped',error_code=$2,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",[row.id,skip]);return null;}
      // Recheck the provider window immediately before a retry, not only at claim.
      if(current.first_attempt_at&&(await client.query("SELECT $1::timestamptz<clock_timestamp()-interval '23 hours' AS expired",[current.first_attempt_at])).rows[0].expired){await client.query("UPDATE email_outbox SET status='review-needed',error_code='EMAIL_RETRY_REVIEW_REQUIRED',lease_id=NULL,lease_until=NULL WHERE id=$1",[row.id]);return null;}
      if(current.payload)return current.payload as EmailPayload;
      const payload=serviceEmail(this.services.config,current.kind,email);
      await client.query('UPDATE email_outbox SET payload=$2,recipient_hash=$3,first_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',[row.id,payload,recipientHash(email)]);
      return payload;
    });
  }
  private async reconcileMessage(client:pg.PoolClient,messageId:string) {
    const outbox=(await client.query('SELECT id,status,recipient_hash FROM email_outbox WHERE provider_message_id=$1 FOR UPDATE',[messageId])).rows[0];
    if(!outbox)return;
    const events=(await client.query('SELECT type FROM email_events WHERE provider_message_id=$1 AND recipient_hash=$2',[messageId,outbox.recipient_hash])).rows;
    let status=outbox.status;
    for(const event of events){const next=eventStatus[event.type];if((ranks[next]??0)>(ranks[status]??0))status=next;}
    if(['bounced','complained','suppressed'].includes(status))await client.query('INSERT INTO email_suppressions(recipient_hash,reason) VALUES($1,$2) ON CONFLICT(recipient_hash) DO NOTHING',[outbox.recipient_hash,status]);
    if(status!==outbox.status)await client.query('UPDATE email_outbox SET status=$2,updated_at=clock_timestamp() WHERE id=$1',[outbox.id,status]);
  }
  async runOne(signal?:AbortSignal):Promise<boolean> {
    if(!this.services.config.emailEnabled||signal?.aborted)return false;
    const claimed=await this.claim();if(!claimed)return false;
    try{
      const email=await this.resolveEmail(claimed.recipient_user_id);
      if(!email||!emailSchema.safeParse(email).success){await this.finish(claimed,'skipped','EMAIL_RECIPIENT_UNVERIFIED');return true;}
      const payload=await this.prepare(claimed,email);if(!payload)return true;
      signal?.throwIfAborted();
      const result=await this.provider.send(payload,`appscreen-email/${claimed.id}`,signal);
      await transaction(this.services.db,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`appscreen-email:${result.id}`]);
        // Even a late response can establish an accepted intent, but cannot
        // overwrite another provider identity or a confirmed delivery outcome.
        await client.query("UPDATE email_outbox SET provider_message_id=$2,status=CASE WHEN provider_message_id IS NULL OR status IN ('queued','sending','retry','skipped','review-needed') THEN 'accepted' ELSE status END,lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND (provider_message_id IS NULL OR provider_message_id=$2)",[claimed.id,result.id]);
        await this.reconcileMessage(client,result.id);
      });
    }catch(error){
      const known=error instanceof EmailDeliveryError;
      const retryable=!known||error.retryable;
      // A permanent rejection now cannot prove an earlier ambiguous send failed.
      // A signed provider event is separate evidence and can settle it later.
      await this.finish(claimed,retryable?'retry':claimed.first_attempt_at?'review-needed':'failed',known?error.code:'EMAIL_DELIVERY_UNCERTAIN');
    }
    return true;
  }
  async webhook(raw:Buffer,headers:Record<string,string|string[]|undefined>) {
    invariant(this.services.config.resendWebhookSecret,'EMAIL_WEBHOOK_UNAVAILABLE','Email event verification is not configured.',503);
    let event;
    try{event=verifyResendEvent(raw,headers,this.services.config.resendWebhookSecret);}catch{invariant(false,'EMAIL_WEBHOOK_INVALID','Email event signature or format is invalid.',400);}
    if(!event)return {received:true};
    const digest=createHash('sha256').update(raw).digest('hex');
    await transaction(this.services.db,async client=>{
      // Serialize both sides of the event-before-send-response race. Without
      // this lock each transaction could miss the other's uncommitted row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`appscreen-email:${event.messageId}`]);
      const result=await client.query('INSERT INTO email_events(event_id,provider_message_id,type,recipient_hash,payload_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',[event.eventId,event.messageId,event.type,recipientHash(event.recipients[0]),digest,event.createdAt]);
      if(!result.rowCount){const prior=(await client.query('SELECT payload_hash FROM email_events WHERE event_id=$1',[event.eventId])).rows[0];invariant(prior?.payload_hash===digest,'EMAIL_EVENT_CONFLICT','Email event identity was reused.',409);}
      await this.reconcileMessage(client,event.messageId);
    });
    return {received:true};
  }
  async report(ctx:Context) {
    return transaction(this.services.db,async client=>{
      await new Operations(this.services).authorize(ctx,client);
      const member=await client.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.userId]);
      invariant(member.rowCount,'OPERATOR_REQUIRED','Operator access is no longer active.',403);
      const counts=await client.query('SELECT status,count(*)::integer AS count FROM email_outbox GROUP BY status ORDER BY status');
      const pending=await client.query("SELECT COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-created_at)) FILTER(WHERE status IN ('queued','retry','sending')),0)::integer AS oldest_pending_seconds,count(*) FILTER(WHERE status='review-needed')::integer AS review_required FROM email_outbox");
      const incidents=await client.query("SELECT count(*)::integer AS count FROM email_incident_state WHERE review_state<>'closed-no-resend'");
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.workspaceId,ctx.userId,'operator.email.report',{}]);
      return {sendingEnabled:this.services.config.emailEnabled,counts:counts.rows,oldestPendingSeconds:pending.rows[0].oldest_pending_seconds,reviewRequired:pending.rows[0].review_required,openIncidents:incidents.rows[0].count};
    });
  }
  start() {
    if(!this.services.config.emailEnabled)return {stop:async()=>{}};
    const controller=new AbortController();let running:Promise<unknown>|null=null;
    const tick=()=>{if(!running&&!controller.signal.aborted)running=this.runOne(controller.signal).catch(()=>console.error('AppScreen email queue needs attention (EMAIL_QUEUE_FAILED).')).finally(()=>{running=null;});};
    const timer=setInterval(tick,2000);tick();
    return {stop:async()=>{clearInterval(timer);controller.abort();await running;}};
  }
}
