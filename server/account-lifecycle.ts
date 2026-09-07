import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { transaction } from './db.js';
import { invariant } from './errors.js';

const requestKey=z.string().min(8).max(200);
const deletionInput=z.object({confirmation:z.literal('DELETE'),idempotencyKey:requestKey}).strict();
const cancellationInput=z.object({requestId:z.string().uuid(),confirmation:z.literal('KEEP DATA'),idempotencyKey:requestKey}).strict();
const supportInput=z.object({message:z.string().trim().min(10).max(3000),jobId:z.string().uuid().optional(),idempotencyKey:requestKey.optional()}).strict();
const timestamp=(value:any):string|null=>{
  if(value===null||value===undefined)return null;
  const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;
};
const safeRequest=(record:any)=>record?{
  requestId:record.id,
  // No fulfillment worker exists. An unexpected historical status, including
  // "completed", is not evidence that erasure actually happened.
  status:record.status==='pending'?'pending':record.status==='cancelled'?'cancelled':'requires-review',
  requestedAt:timestamp(record.created_at),
  updatedAt:timestamp(record.details?.updatedAt)||timestamp(record.created_at),
  cancelledAt:timestamp(record.details?.cancelledAt),
  legacy:record.details?.lifecycleVersion!==2,
  confirmationVerified:record.details?.lifecycleVersion===2&&record.details?.confirmation==='DELETE',
  canCancel:record.status==='pending',
}:null;

/**
 * Admission/status/cancellation only: deliberately no data erasure, auth-account
 * removal, billing cancellation, retention promise, or "completed" transition.
 * Existing request details hold versioned timestamps, so no migration is needed.
 *
 * Suggested routes (all use the authenticated browser Context):
 * POST /api/account/deletion-request -> requestDeletion(ctx, body)
 * GET  /api/account/deletion-status  -> deletionStatus(ctx)
 * POST /api/account/deletion-cancel  -> cancelDeletion(ctx, body)
 * POST /api/support                 -> requestSupport(ctx, body)
 */
export class AccountLifecycle {
  constructor(public services:AppServices) {}
  private browser(ctx:Context,owner=false) {
    invariant(['web','development'].includes(ctx.authKind),'BROWSER_SESSION_REQUIRED','Open AppScreen to manage your account or contact support.',403);
    if(owner)invariant(ctx.role==='owner','OWNER_REQUIRED','Only the workspace owner can manage deletion requests.',403);
  }
  private async member(ctx:Context,client:pg.PoolClient,owner=false) {
    await this.services.assertMembership(ctx,client);
    // Lock the membership through commit. A concurrent revocation/demotion
    // either precedes and denies this action, or happens after its commit.
    const membership=await client.query('SELECT role,status FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.workspaceId,ctx.userId]);
    invariant(membership.rows[0]?.status==='active','WORKSPACE_FORBIDDEN','Workspace access was revoked.',403);
    if(owner)invariant(membership.rows[0].role==='owner','OWNER_REQUIRED','Workspace ownership changed. Only the current owner can manage deletion requests.',403);
  }
  private async locked<T>(ctx:Context,work:(client:pg.PoolClient)=>Promise<T>) {
    return transaction(this.services.db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`account-lifecycle:${ctx.workspaceId}`]);
      await this.member(ctx,client,true);return work(client);
    });
  }
  private async audit(client:pg.PoolClient,ctx:Context,action:string,targetId:string,metadata:Record<string,unknown>={}) {
    await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ctx.workspaceId,ctx.userId,action,targetId,{scope:'current-workspace',...metadata}]);
  }
  private async view(client:pg.PoolClient,ctx:Context,focusId?:string) {
    const counts=(await client.query("SELECT count(*) FILTER (WHERE status='pending')::integer AS pending,count(*) FILTER (WHERE status NOT IN ('pending','cancelled'))::integer AS review FROM account_requests WHERE workspace_id=$1 AND kind='deletion'",[ctx.workspaceId])).rows[0];
    const history=(await client.query("SELECT id,status,details,created_at FROM account_requests WHERE workspace_id=$1 AND kind='deletion' ORDER BY created_at DESC,id DESC LIMIT 50",[ctx.workspaceId])).rows;
    const active=(await client.query("SELECT id,status,details,created_at FROM account_requests WHERE workspace_id=$1 AND kind='deletion' AND status<>'cancelled' ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1",[ctx.workspaceId])).rows[0]||null;
    let focus=focusId?history.find(item=>item.id===focusId):null;
    if(focusId&&!focus)focus=(await client.query("SELECT id,status,details,created_at FROM account_requests WHERE id=$1 AND workspace_id=$2 AND kind='deletion'",[focusId,ctx.workspaceId])).rows[0];
    if(focusId)invariant(focus,'DELETION_REQUEST_NOT_FOUND','Deletion request not found.',404);
    const request=safeRequest(focus||active||history[0]),activeRequest=safeRequest(active);
    const status=request?.status||'none';
    const pendingMessage='A deletion request is pending. Your workspace data has not been deleted, and your subscription has not been cancelled. Fulfillment and retention handling require manual setup and review.';
    const message=counts.pending>0?pendingMessage:counts.review>0?'A historical deletion request requires manual status review. This service cannot confirm that any data was erased. No automatic deletion or subscription cancellation is configured.':status==='cancelled'?'The pending deletion request was cancelled. Your workspace data is being kept. Your subscription is unchanged.':'There is no pending deletion request. Automatic deletion and subscription cancellation are not configured.';
    return {scope:'current-workspace' as const,workspaceId:ctx.workspaceId,requestId:request?.requestId||null,status,request,activeRequest,pendingCount:counts.pending as number,reviewRequiredCount:counts.review as number,requests:history.map(safeRequest),fulfillment:{configured:false,automaticDeletion:false,billingCancellation:false},message};
  }
  async deletionStatus(ctx:Context) {
    this.browser(ctx,true);return this.locked(ctx,client=>this.view(client,ctx));
  }
  async requestDeletion(ctx:Context,input:unknown) {
    this.browser(ctx,true);const args=deletionInput.parse(input);
    return this.locked(ctx,async client=>{
      const receipt=await this.services.writeReceipt(client,ctx,'account.request-deletion',args);
      if(receipt?.result)return {...await this.view(client,ctx,receipt.result.requestId),replayed:true,reusedPendingRequest:!!receipt.result.reusedPendingRequest};
      const unexpected=await client.query("SELECT id FROM account_requests WHERE workspace_id=$1 AND kind='deletion' AND status NOT IN ('pending','cancelled') LIMIT 1",[ctx.workspaceId]);
      invariant(!unexpected.rowCount,'DELETION_REVIEW_REQUIRED','A historical deletion request needs manual review before another request can be admitted.',409);
      const existing=(await client.query("SELECT id FROM account_requests WHERE workspace_id=$1 AND kind='deletion' AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[ctx.workspaceId])).rows[0];
      const requestId=existing?.id||randomUUID();
      if(!existing) {
        await client.query("INSERT INTO account_requests(id,workspace_id,user_id,kind,status,details) VALUES($1,$2,$3,'deletion','pending',$4)",[requestId,ctx.workspaceId,ctx.userId,{lifecycleVersion:2,confirmation:'DELETE'}]);
        await this.audit(client,ctx,'account.deletion-request',requestId,{confirmation:'DELETE',fulfillmentConfigured:false});
      }
      await this.services.storeReceipt(client,ctx,receipt,{requestId,reusedPendingRequest:!!existing});
      return {...await this.view(client,ctx,requestId),replayed:false,reusedPendingRequest:!!existing};
    });
  }
  async cancelDeletion(ctx:Context,input:unknown) {
    this.browser(ctx,true);const args=cancellationInput.parse(input);
    return this.locked(ctx,async client=>{
      const receipt=await this.services.writeReceipt(client,ctx,'account.cancel-deletion',args);
      if(receipt?.result)return {...await this.view(client,ctx,receipt.result.requestId),cancelledRequestIds:receipt.result.cancelledRequestIds,replayed:true};
      const request=(await client.query("SELECT id,status FROM account_requests WHERE id=$1 AND workspace_id=$2 AND kind='deletion' FOR UPDATE",[args.requestId,ctx.workspaceId])).rows[0];
      invariant(request,'DELETION_REQUEST_NOT_FOUND','Deletion request not found.',404);
      invariant(['pending','cancelled'].includes(request.status),'DELETION_REVIEW_REQUIRED','This historical request needs manual review before its status can be changed.',409);
      let cancelledRequestIds:string[]=[];
      if(request.status==='pending') {
        // KEEP DATA applies to every pending duplicate visible at this point,
        // including legacy rows. Explicit IDs exclude a later request even if
        // an older writer outside this module inserts it concurrently.
        const pending=await client.query("SELECT id FROM account_requests WHERE workspace_id=$1 AND kind='deletion' AND status='pending' ORDER BY id LIMIT 10001 FOR UPDATE",[ctx.workspaceId]);
        invariant(pending.rows.length<=10_000,'DELETION_REVIEW_REQUIRED','The pending request history is too large for safe automatic cancellation. Contact support.',409);
        const changed=await client.query("UPDATE account_requests SET status='cancelled',details=(CASE WHEN jsonb_typeof(details)='object' THEN details ELSE '{}'::jsonb END)||jsonb_build_object('updatedAt',now(),'cancelledAt',now(),'cancelledBy',$3::text) WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='deletion' AND status='pending' RETURNING id",[ctx.workspaceId,pending.rows.map(item=>item.id),ctx.userId]);
        cancelledRequestIds=changed.rows.map(item=>item.id).sort();
        await this.audit(client,ctx,'account.deletion-cancel',args.requestId,{confirmation:'KEEP DATA',cancelledRequestIds,dataErased:false,billingChanged:false});
      }
      await this.services.storeReceipt(client,ctx,receipt,{requestId:args.requestId,cancelledRequestIds});
      return {...await this.view(client,ctx,args.requestId),cancelledRequestIds,replayed:false};
    });
  }
  async requestSupport(ctx:Context,input:unknown) {
    this.browser(ctx);const args=supportInput.parse(input);
    return transaction(this.services.db,async client=>{
      await this.member(ctx,client);
      const receipt=await this.services.writeReceipt(client,ctx,'account.support-request',args);
      if(receipt?.result)return {...receipt.result,replayed:true};
      if(args.jobId) {
        const job=await client.query('SELECT id FROM agent_jobs WHERE id=$1 AND workspace_id=$2',[args.jobId,ctx.workspaceId]);
        invariant(job.rowCount,'JOB_NOT_FOUND','Job not found.',404);
      }
      const requestId=randomUUID();
      const record=await client.query("INSERT INTO account_requests(id,workspace_id,user_id,kind,status,details) VALUES($1,$2,$3,'support','pending',$4) RETURNING created_at",[requestId,ctx.workspaceId,ctx.userId,{lifecycleVersion:2,message:args.message,...(args.jobId?{jobId:args.jobId}:{})}]);
      await this.audit(client,ctx,'account.support-request',requestId,args.jobId?{jobId:args.jobId}:{});
      const result={requestId,status:'received' as const,caseStatus:'pending' as const,createdAt:timestamp(record.rows[0].created_at),message:'Your support request has been saved.'};
      await this.services.storeReceipt(client,ctx,receipt,result);return {...result,replayed:false};
    });
  }
}
