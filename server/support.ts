import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { Operations } from './operator.js';
import { transaction } from './db.js';
import { AppError, invariant } from './errors.js';

export const SUPPORT_STATUSES=['pending','in-progress','waiting-on-customer','escalated','resolved'] as const;
type Status=typeof SUPPORT_STATUSES[number];
export const SUPPORT_TRANSITIONS:Record<Status,readonly Status[]>={
  pending:['in-progress','waiting-on-customer','escalated','resolved'],
  'in-progress':['waiting-on-customer','escalated','resolved'],
  'waiting-on-customer':['in-progress','escalated','resolved'],
  escalated:['in-progress','waiting-on-customer','resolved'],
  resolved:['in-progress'],
};
const statusSchema=z.enum(SUPPORT_STATUSES),message=z.string().trim().min(1).max(3000);
const write={expectedVersion:z.number().int().min(1),idempotencyKey:z.string().min(8).max(200)};
const idSchema=z.string().uuid(),listSchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional(),status:statusSchema.optional()}).strict();
const known=(value:string):value is Status=>(SUPPORT_STATUSES as readonly string[]).includes(value);
const iso=(value:any)=>value?new Date(value).toISOString():null;
const safeJobId=(value:any)=>idSchema.safeParse(value).success?value:null;
const metadata=(record:any,staff=false)=>({id:record.id,...(staff?{workspaceId:record.workspace_id}:{}),status:known(record.status)?record.status:'requires-review',version:record.support_version,createdAt:iso(record.created_at),updatedAt:iso(record.support_updated_at||record.created_at),jobId:safeJobId(record.job_id??record.details?.jobId),canReply:known(record.status)});
const allowed=(record:any):readonly Status[]=>known(record.status)?SUPPORT_TRANSITIONS[record.status as Status]:['in-progress'];
const publicMessage=(record:any)=>({id:record.id,author:record.author_kind==='support'?'support':'customer',body:record.body,createdAt:iso(record.created_at)});
const validCursorTime=(value:string)=>{const day=new Date(value.slice(0,10));return Number.isFinite(day.getTime())&&day.toISOString().startsWith(value.slice(0,10))&&Number.isFinite(Date.parse(value));};
export type SupportNotificationInput={workspaceId:string;requestId:string;messageId:string;recipientUserId:string};
export type SupportOptions={onStaffReply?:(client:pg.PoolClient,input:SupportNotificationInput)=>Promise<unknown>};

/** Customer support is workspace-level: every active browser member of a
 * workspace can read/follow up its cases, even when a teammate opened them.
 * Customer and operator projections deliberately use different paths. Private
 * detail is an explicitly reasoned, audited read, never a queue-list side effect.
 * No messages are sent externally here; onStaffReply can atomically enqueue a
 * notification intent alongside the public staff reply. */
export class SupportCases {
  private operations:Operations;
  constructor(public services:AppServices,private options:SupportOptions={}) {this.operations=new Operations(services);}
  private browser(ctx:Context) {invariant(['web','development'].includes(ctx.authKind)&&!ctx.connection,'BROWSER_SESSION_REQUIRED','Open AppScreen to use support.',403);}
  private async authorize(ctx:Context,client:pg.PoolClient,staff=false) {
    this.browser(ctx);
    if(staff)await this.operations.authorize(ctx,client);else await this.services.assertMembership(ctx,client);
    const member=await client.query('SELECT role,status FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.workspaceId,ctx.userId]);
    invariant(member.rows[0]?.status==='active','WORKSPACE_FORBIDDEN','Workspace access was revoked.',403);
    if(staff)invariant(member.rows[0].role==='owner','OPERATOR_REQUIRED','Operator workspace ownership changed.',403);
  }
  private async case(client:pg.PoolClient,ctx:Context,id:string,staff=false,lock='UPDATE') {
    const result=await client.query(`SELECT * FROM account_requests WHERE id=$1 AND kind='support'${staff?'':' AND workspace_id=$2'} FOR ${lock}`,staff?[id]:[id,ctx.workspaceId]);
    invariant(result.rowCount,'SUPPORT_NOT_FOUND','Support case not found.',404);return result.rows[0];
  }
  private async audit(client:pg.PoolClient,ctx:Context,record:any,action:string,details:any={}) {
    await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),record.workspace_id||ctx.workspaceId,ctx.userId,action,record.id||null,{operatorWorkspaceId:ctx.workspaceId,...details}]);
  }
  private async detail(client:pg.PoolClient,record:any,staff=false) {
    const messages=await client.query(`SELECT id,author_kind,body,created_at${staff?',visibility,author_id':''} FROM support_messages WHERE request_id=$1 AND workspace_id=$2${staff?'':" AND visibility='customer'"} ORDER BY created_at,id LIMIT 1001`,[record.id,record.workspace_id]);
    invariant(messages.rows.length<=1000,'SUPPORT_THREAD_LIMIT','This case needs a support-assisted conversation export because it exceeds the message limit.',413);
    const initial=typeof record.details?.message==='string'?{id:`${record.id}:initial`,author:'customer',body:record.details.message,createdAt:iso(record.created_at)}:null;
    const result={case:metadata(record,staff),messages:[...(initial?[initial]:[]),...messages.rows.filter(item=>!staff||item.visibility==='customer').map(publicMessage)],initialMessageAvailable:!!initial,allowedActions:{followUp:known(record.status)}};
    if(!staff)return result;
    const member=(await client.query('SELECT user_id,email FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[record.workspace_id,record.user_id])).rows[0];
    return {...result,requester:{userId:record.user_id,email:member?.email||null},internalNotes:messages.rows.filter(item=>item.visibility==='internal').map(item=>({id:item.id,body:item.body,createdAt:iso(item.created_at),staffUserId:item.author_id})),allowedTransitions:allowed(record)};
  }
  private async list(ctx:Context,input:unknown,staff=false) {
    this.browser(ctx);const args=listSchema.parse(input||{}),scope=staff?'operator':ctx.workspaceId;
    let cursor:any=null;
    if(args.cursor) {
      try {
        invariant(/^[a-zA-Z0-9_-]+$/.test(args.cursor),'SUPPORT_CURSOR_INVALID','Invalid support page cursor.');
        cursor=z.object({at:z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/).refine(validCursorTime),id:idSchema,scope:z.literal(scope),status:z.literal(args.status||'all')}).strict().parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8')));
      } catch {throw new AppError('SUPPORT_CURSOR_INVALID','The support page cursor is invalid for this view.',400);}
    }
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client,staff);
      const params:any[]=[];const clauses=["kind='support'"];
      if(!staff){params.push(ctx.workspaceId);clauses.push(`workspace_id=$${params.length}`);}
      if(args.status){params.push(args.status);clauses.push(`status=$${params.length}`);}
      if(cursor){params.push(cursor.at,cursor.id);clauses.push(`(created_at,id)<($${params.length-1}::timestamptz,$${params.length}::uuid)`);}
      params.push(args.limit+1);
      const result=await client.query(`SELECT id,workspace_id,status,support_version,support_updated_at,created_at,created_at::text AS cursor_at,details->>'jobId' AS job_id FROM account_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,params);
      const records=result.rows.slice(0,args.limit),last=records.at(-1);
      if(staff)await this.audit(client,ctx,{workspace_id:ctx.workspaceId},'operator.support.queue',{returned:records.length,status:args.status||'all'});
      return {cases:records.map(record=>metadata(record,staff)),nextCursor:result.rows.length>args.limit?Buffer.from(JSON.stringify({at:last!.cursor_at,id:last!.id,scope,status:args.status||'all'})).toString('base64url'):null};
    });
  }
  customerList(ctx:Context,input:unknown={}) {return this.list(ctx,input);}
  operatorList(ctx:Context,input:unknown={}) {return this.list(ctx,input,true);}
  async customerDetail(ctx:Context,id:string) {
    this.browser(ctx);idSchema.parse(id);
    return transaction(this.services.db,async client=>{await this.authorize(ctx,client);return this.detail(client,await this.case(client,ctx,id,false,'SHARE'));});
  }
  async operatorDetail(ctx:Context,id:string,input:unknown) {
    this.browser(ctx);idSchema.parse(id);const args=z.object({reason:z.string().trim().min(10).max(500)}).strict().parse(input);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client,true);const record=await this.case(client,ctx,id,true,'SHARE');
      await this.audit(client,ctx,record,'operator.support.private-view',{reason:args.reason});return this.detail(client,record,true);
    });
  }
  private async addMessage(client:pg.PoolClient,ctx:Context,record:any,body:string,staff=false,internal=false) {
    const count=(await client.query('SELECT count(*)::integer AS count FROM support_messages WHERE request_id=$1',[record.id])).rows[0].count;
    invariant(count<1000,'SUPPORT_THREAD_LIMIT','This case reached its message limit. Open a new case and include this case ID.',413);
    const id=randomUUID();await client.query('INSERT INTO support_messages(id,request_id,workspace_id,author_id,author_kind,visibility,body) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,record.id,record.workspace_id,ctx.userId,staff?'support':'customer',internal?'internal':'customer',body]);return id;
  }
  private async advance(client:pg.PoolClient,record:any,next:string,expected:number) {
    this.checkVersion(record,expected);
    const saved=await client.query('UPDATE account_requests SET status=$2,support_version=support_version+1,support_updated_at=now() WHERE id=$1 AND support_version=$3 RETURNING *',[record.id,next,expected]);
    invariant(saved.rowCount,'SUPPORT_VERSION_CONFLICT','This support case changed. Reload it before continuing.',409);return saved.rows[0];
  }
  private checkVersion(record:any,expected:number) {invariant(record.support_version===expected,'SUPPORT_VERSION_CONFLICT','This support case changed. Reload it before replying or changing its status.',409,{version:record.support_version});}
  async customerFollowUp(ctx:Context,id:string,input:unknown) {
    this.browser(ctx);idSchema.parse(id);const args=z.object({...write,message}).strict().parse(input);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client);const record=await this.case(client,ctx,id),receipt=await this.services.writeReceipt(client,ctx,'support.customer-reply',{requestId:id,...args});
      if(receipt?.result)return {...await this.detail(client,record),replayed:true,messageId:receipt.result.messageId};
      this.checkVersion(record,args.expectedVersion);
      invariant(known(record.status),'SUPPORT_STATUS_INVALID','This historical case requires staff review before another reply.',409);
      const next=['waiting-on-customer','resolved'].includes(record.status)?'pending':record.status;
      const saved=await this.advance(client,record,next,args.expectedVersion),messageId=await this.addMessage(client,ctx,record,args.message);
      await this.audit(client,ctx,record,'support.customer-reply',{messageId,version:saved.support_version});
      await this.services.storeReceipt(client,ctx,receipt,{messageId});return {...await this.detail(client,saved),replayed:false,messageId};
    });
  }
  async operatorReply(ctx:Context,id:string,input:unknown) {
    this.browser(ctx);idSchema.parse(id);const args=z.object({...write,message,status:statusSchema.default('waiting-on-customer')}).strict().parse(input);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client,true);const record=await this.case(client,ctx,id,true),receipt=await this.services.writeReceipt(client,ctx,'support.operator-reply',{requestId:id,...args});
      if(receipt?.result)return {case:metadata(record,true),messageId:receipt.result.messageId,replayed:true};
      this.checkVersion(record,args.expectedVersion);
      invariant(known(record.status)&&(args.status!=='escalated'||record.status==='escalated')&&(args.status===record.status||allowed(record).includes(args.status)),'SUPPORT_TRANSITION_INVALID','Choose a permitted status. Escalation requires a separate internal explanation.',409);
      const saved=await this.advance(client,record,args.status,args.expectedVersion),messageId=await this.addMessage(client,ctx,record,args.message,true);
      await this.audit(client,ctx,record,'operator.support.reply',{messageId,fromStatus:record.status,toStatus:args.status,version:saved.support_version});
      if(this.options.onStaffReply)await this.options.onStaffReply(client,{workspaceId:record.workspace_id,requestId:id,messageId,recipientUserId:record.user_id});
      await this.services.storeReceipt(client,ctx,receipt,{messageId});return {case:metadata(saved,true),messageId,replayed:false};
    });
  }
  async operatorTransition(ctx:Context,id:string,input:unknown) {
    this.browser(ctx);idSchema.parse(id);const args=z.object({...write,status:statusSchema,internalNote:z.string().trim().min(10).max(3000).optional()}).strict().parse(input);
    return transaction(this.services.db,async client=>{
      await this.authorize(ctx,client,true);const record=await this.case(client,ctx,id,true),receipt=await this.services.writeReceipt(client,ctx,'support.operator-status',{requestId:id,...args});
      if(receipt?.result)return {case:metadata(record,true),replayed:true};
      this.checkVersion(record,args.expectedVersion);
      invariant(args.status===record.status||allowed(record).includes(args.status),'SUPPORT_TRANSITION_INVALID','That status transition is not permitted.',409);
      invariant((args.status!=='escalated'&&known(record.status))||args.internalNote,'SUPPORT_NOTE_REQUIRED','Explain escalations or historical-status recovery in a private internal note.',400);
      const saved=await this.advance(client,record,args.status,args.expectedVersion);
      const noteId=args.internalNote?await this.addMessage(client,ctx,record,args.internalNote,true,true):null;
      await this.audit(client,ctx,record,'operator.support.status',{fromStatus:record.status,toStatus:args.status,version:saved.support_version,noteId});
      await this.services.storeReceipt(client,ctx,receipt,{version:saved.support_version});return {case:metadata(saved,true),replayed:false};
    });
  }
}
