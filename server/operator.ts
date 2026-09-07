import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { transaction, row, type Connection } from './db.js';
import { invariant } from './errors.js';

// A customer-controlled workspace role, email or OAuth claim cannot grant staff
// access. The deployment's explicit allowlist is the only source of this role.
export function canOperate(config:Config,ctx:Context) {
  return config.operatorUserIds.includes(ctx.userId)&&ctx.role==='owner'&&!ctx.connection&&
    ((ctx.authKind==='web'&&ctx.assuranceLevel==='aal2')||(!config.production&&config.developmentAuth&&ctx.authKind==='development'));
}
const stage=(value:unknown)=>typeof value==='string'&&/^(?:queued|running|analyzing|planning|composing|rendering|checking|repairing|saving|delivering|ready|needs-input|failed|cancelling|cancelled|exporting)(?:_[0-9]{1,2})?$/.test(value)?value:'other';
const count=(value:unknown)=>(typeof value==='number'||typeof value==='string'&&/^(?:0|[1-9][0-9]*)$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
const safeJob=(job:any)=>({id:job.id,workspaceId:job.workspace_id,projectId:job.project_id,kind:job.kind,status:stage(job.status),stage:stage(job.stage),attempts:count(job.attempts),createdAt:job.created_at,updatedAt:job.updated_at,errorCode:typeof job.error_code==='string'&&/^[A-Z_]{2,60}$/.test(job.error_code)?job.error_code:null});
const jobColumns="id,workspace_id,project_id,kind,status,stage,attempts,created_at,updated_at,error->>'code' AS error_code";

export class Operations {
  constructor(private services:AppServices) {}
  async authorize(ctx:Context,connection:Connection=this.services.db) {
    invariant(canOperate(this.services.config,ctx),'OPERATOR_REQUIRED','This view requires a configured operator account and verified multi-factor sign-in.',403);
    await this.services.assertMembership(ctx,connection);
    const member=await connection.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND status='active'",[ctx.workspaceId,ctx.userId]);
    invariant(member.rowCount,'OPERATOR_REQUIRED','Operator workspace access is no longer active.',403);
  }
  async overview(ctx:Context) {
    await this.authorize(ctx);
    const [jobs,billing,support,credits,storage]=await Promise.all([
      this.services.db.query(`SELECT ${jobColumns} FROM agent_jobs ORDER BY updated_at DESC LIMIT 100`),
      this.services.db.query("SELECT count(*) FILTER(WHERE processed_at IS NULL)::integer AS pending_events,count(*) FILTER(WHERE processed_at IS NULL AND error_code IS NOT NULL)::integer AS failed_events FROM billing_events"),
      this.services.db.query("SELECT id,workspace_id,kind,status,created_at FROM account_requests WHERE status NOT IN ('resolved','cancelled','completed') ORDER BY created_at DESC LIMIT 100"),
      this.services.db.query("SELECT count(*)::integer AS reserved_jobs FROM credit_reservations WHERE status='reserved'"),
      this.services.db.query('SELECT COALESCE(sum(byte_size),0) AS asset_bytes FROM assets'),
    ]);
    await this.services.audit(ctx,'operator.overview');
    return {jobs:jobs.rows.map(safeJob),billing:row(billing.rows[0]),support:support.rows.map(r=>row(r)),credits:row(credits.rows[0]),storage:{assetBytes:count(storage.rows[0].asset_bytes)}};
  }
  async job(ctx:Context,id:string) {
    await this.authorize(ctx);z.string().uuid().parse(id);
    const result=await this.services.db.query(`SELECT ${jobColumns} FROM agent_jobs WHERE id=$1`,[id]);
    invariant(result.rowCount,'JOB_NOT_FOUND','Job not found.',404);
    const [events,usage,reservation]=await Promise.all([
      // Never select event bodies, provider response IDs, images, URLs or prompts.
      this.services.db.query("SELECT event->>'stage' AS stage,created_at FROM job_events WHERE job_id=$1 ORDER BY id LIMIT 500",[id]),
      this.services.db.query("SELECT data->>'stage' AS stage,data->>'input_tokens' AS input_tokens,data->>'output_tokens' AS output_tokens,data->>'total_tokens' AS total_tokens FROM usage_events WHERE job_id=$1 ORDER BY created_at LIMIT 1000",[id]),
      this.services.db.query('SELECT amount,status FROM credit_reservations WHERE job_id=$1',[id]),
    ]);
    await this.services.audit(ctx,'operator.job.view',id,{targetWorkspaceId:result.rows[0].workspace_id});
    return {job:safeJob(result.rows[0]),events:events.rows.map(e=>({stage:stage(e.stage),createdAt:e.created_at})),usage:usage.rows.map(u=>({stage:stage(u.stage),inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens),totalTokens:count(u.total_tokens)})),reservation:reservation.rows[0]||null};
  }
  async adjustCredits(ctx:Context,args:unknown) {
    await this.authorize(ctx);
    const input=z.object({workspaceId:z.string().uuid(),amount:z.number().int().min(-1000).max(1000).refine(n=>n!==0),reason:z.string().trim().min(10).max(1000),idempotencyKey:z.string().min(8).max(200),confirmation:z.literal('ADJUST CREDITS')}).strict().parse(args);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client);
      // Same ordering as job admission and billing; debit cannot consume credits
      // already promised to an in-flight job. No payment/subscription mutation.
      const workspace=await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId]);
      invariant(workspace.rowCount,'WORKSPACE_NOT_FOUND','Workspace not found.',404);
      const prior=await this.services.writeReceipt(client,ctx,'operator.credit-adjustment',input);
      if(prior?.result)return prior.result;
      const balance=await this.services.credits(input.workspaceId,client);
      invariant(input.amount>0||balance.available+input.amount>=0,'CREDIT_ADJUSTMENT_RESERVED','This reduction would consume reserved credits or make available credits negative.',409);
      const id=randomUUID();
      const ledger=await client.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,$3,'operator-adjustment',$4) RETURNING created_at",[id,input.workspaceId,input.amount,`operator:${id}`]);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.workspaceId,ctx.userId,'operator.credit-adjustment',id,{amount:input.amount,reason:input.reason,operatorWorkspaceId:ctx.workspaceId}]);
      const result={receipt:{id,workspaceId:input.workspaceId,amount:input.amount,reason:input.reason,createdAt:ledger.rows[0].created_at.toISOString()}};
      await this.services.storeReceipt(client,ctx,prior,result);
      return result;
    });
  }
}
