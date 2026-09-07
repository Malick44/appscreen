import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { Operations } from './operator.js';
import { transaction } from './db.js';
import { AppError, invariant } from './errors.js';

const version=z.number().int().min(1).max(2_147_483_646);
const listInput=z.object({state:z.enum(['open','reviewed','all']).default('open'),limit:z.coerce.number().int().min(1).max(50).default(30),cursor:z.string().max(1000).optional()}).strict();
const reviewInput=z.object({disposition:z.enum(['investigating','closed-no-resend']),reason:z.string().trim().min(10).max(1000),expectedDeliveryVersion:version,expectedReviewVersion:version.or(z.literal(0)),idempotencyKey:z.string().min(8).max(200),confirmation:z.literal('RECORD EMAIL REVIEW')}).strict();
const iso=(value:Date)=>value.toISOString();
const metadata=(r:any)=>({id:r.id,workspaceId:r.workspace_id,status:r.status,errorCode:r.error_code,attempts:r.attempts,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),deliveryVersion:r.delivery_version,reviewVersion:r.review_version,reviewState:r.review_state,previousReviewStale:r.previous_review_stale});
const validTime=(value:string)=>{const day=new Date(value.slice(0,10));return Number.isFinite(day.getTime())&&day.toISOString().startsWith(value.slice(0,10))&&Number.isFinite(Date.parse(value));};

/** Review-only workflow. There is deliberately no provider, recipient resolver,
 * notification producer or outbox/suppression mutation in this service. */
export class EmailIncidents {
  constructor(public services:AppServices) {}
  private async authorize(ctx:Context,client:pg.PoolClient) {
    await new Operations(this.services).authorize(ctx,client);
    // Hold membership through the write/audit; revocation/demotion cannot race it.
    const member=await client.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.userId]);
    invariant(member.rowCount,'OPERATOR_REQUIRED','Operator access is no longer active.',403);
  }
  async list(ctx:Context,args:unknown={}) {
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client);
      const input=listInput.parse(args);let cursor:any=null;
      if(input.cursor)try{
        invariant(/^[a-zA-Z0-9_-]+$/.test(input.cursor),'EMAIL_CURSOR_INVALID','Invalid email queue cursor.');
        cursor=z.object({at:z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/).refine(validTime),id:z.string().uuid(),state:z.literal(input.state)}).strict().parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));
      }catch{throw new AppError('EMAIL_CURSOR_INVALID','The email queue cursor is invalid for this view.',400);}
      const clauses=[input.state==='all'?'true':input.state==='reviewed'?"review_state='closed-no-resend'":"review_state<>'closed-no-resend'"];
      const params:any[]=[];
      if(cursor){params.push(cursor.at,cursor.id);clauses.push('(created_at,id)<($1::timestamptz,$2::uuid)');}
      params.push(input.limit+1);
      const result=await client.query(`SELECT *,created_at::text AS cursor_at FROM email_incident_state WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,params);
      const incidents=result.rows.slice(0,input.limit),last=incidents.at(-1);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.workspaceId,ctx.userId,'operator.email.queue',{state:input.state,returned:incidents.length}]);
      return {incidents:incidents.map(metadata),nextCursor:result.rows.length>input.limit?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id,state:input.state})).toString('base64url'):null};
    });
  }
  async review(ctx:Context,id:string,args:unknown) {
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client);z.string().uuid().parse(id);const input=reviewInput.parse(args);
      const receipt=await this.services.writeReceipt(client,ctx,'operator.email.review',{id,...input});
      // An exact replay confirms the recorded decision, never reapplies it to
      // newer delivery evidence. It is returned only after current authorization.
      if(receipt?.result)return receipt.result;
      const outbox=await client.query('SELECT id FROM email_outbox WHERE id=$1 FOR UPDATE',[id]);
      invariant(outbox.rowCount,'EMAIL_INCIDENT_NOT_FOUND','Email record not found.',404);
      const current=(await client.query('SELECT * FROM email_incident_state WHERE id=$1',[id])).rows[0];
      invariant(current,'EMAIL_INCIDENT_NOT_ACTIVE','This email no longer needs review. Reload the queue.',409);
      invariant(current.delivery_version===input.expectedDeliveryVersion&&current.review_version===input.expectedReviewVersion,'EMAIL_INCIDENT_CHANGED','Delivery evidence or its review changed. Reload before recording a decision.',409);
      await client.query(`INSERT INTO email_incident_reviews(outbox_id,delivery_version,version,disposition) VALUES($1,$2,1,$3)
        ON CONFLICT(outbox_id) DO UPDATE SET delivery_version=$2,version=email_incident_reviews.version+1,disposition=$3,updated_at=clock_timestamp()`,[id,current.delivery_version,input.disposition]);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),current.workspace_id,ctx.userId,'operator.email.review',id,{operatorWorkspaceId:ctx.workspaceId,disposition:input.disposition,reason:input.reason,deliveryVersion:current.delivery_version,reviewVersion:current.review_version+1,status:current.status}]);
      const result={incident:metadata((await client.query('SELECT * FROM email_incident_state WHERE id=$1',[id])).rows[0])};
      await this.services.storeReceipt(client,ctx,receipt,result);return result;
    });
  }
}
