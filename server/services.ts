import { createHmac, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { transaction, row, type DB, type Connection } from './db.js';
import { AppError, invariant } from './errors.js';
import { hash, requireScope, type Context } from './auth.js';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import { canOperate } from './operator.js';
import { recordMilestone } from './product-metrics.js';
import { enqueueNotification } from './notifications.js';

export const uuid = z.string().uuid();
const terminal = ['ready','needs-input','failed','cancelled'];
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
export class AppServices {
  enqueue: ((jobId:string)=>Promise<void>) | null=null;
  constructor(public db:DB, public config:Config, public storage:Storage) {}
  async writeReceipt(client:Connection,ctx:Context,action:string,args:any) {
    if(!args.idempotencyKey)return null;
    const key=z.string().min(8).max(200).parse(args.idempotencyKey);const requestHash=hash(JSON.stringify(canonical(args)));
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${ctx.workspaceId}:${ctx.userId}:${action}:${key}`]);
    const existing=await client.query('SELECT * FROM write_receipts WHERE workspace_id=$1 AND user_id=$2 AND action=$3 AND request_key=$4',[ctx.workspaceId,ctx.userId,action,key]);
    if(existing.rowCount)invariant(existing.rows[0].request_hash===requestHash,'IDEMPOTENCY_CONFLICT','This request key was already used for different work.',409);
    return {key,action,requestHash,result:existing.rows[0]?.result};
  }
  async storeReceipt(client:Connection,ctx:Context,receipt:any,result:any) {
    if(receipt)await client.query('INSERT INTO write_receipts(workspace_id,user_id,action,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[ctx.workspaceId,ctx.userId,receipt.action,receipt.key,receipt.requestHash,result]);
  }
  async audit(ctx:Context,action:string,targetId?:string,metadata:Record<string,unknown>={}) {
    await this.db.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ctx.workspaceId,ctx.userId,action,targetId||null,metadata]);
  }
  async assertMembership(ctx:Context,conn:Connection=this.db) {
    const result=await conn.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[ctx.workspaceId,ctx.userId]);
    invariant(result.rowCount,'WORKSPACE_FORBIDDEN','Workspace access was revoked.',403);
    if(ctx.connection){const c=ctx.connection;const permission=c.kind==='oauth'?await conn.query('SELECT id FROM oauth_grants WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND version=$4 AND scopes @> $5::text[] AND revoked_at IS NULL AND expires_at>now()',[c.id,ctx.userId,ctx.workspaceId,c.version,ctx.scopes]):await conn.query('SELECT id FROM api_tokens WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND scopes @> $4::text[] AND revoked_at IS NULL AND expires_at>now()',[c.id,ctx.userId,ctx.workspaceId,ctx.scopes]);invariant(permission.rowCount,'CONNECTION_REVOKED','This agent connection expired, changed, or was revoked.',403);}
  }
  async project(ctx:Context,id:string,conn:Connection=this.db) {
    uuid.parse(id); await this.assertMembership(ctx,conn);
    const result=await conn.query('SELECT * FROM projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL',[id,ctx.workspaceId]);
    invariant(result.rowCount,'PROJECT_NOT_FOUND','Project not found.',404);return row<any>(result.rows[0]);
  }
  async credits(workspaceId:string,conn:Connection=this.db) {
    const result=await conn.query(`SELECT COALESCE((SELECT sum(amount) FROM credit_ledger WHERE workspace_id=$1),0)::integer AS balance,
      COALESCE((SELECT sum(amount) FROM credit_reservations WHERE workspace_id=$1 AND status='reserved'),0)::integer AS reserved,
      COALESCE((SELECT sum(amount) FROM credit_ledger WHERE workspace_id=$1 AND amount>0),0)::integer AS granted`,[workspaceId]);
    const c=result.rows[0];return {available:c.balance-c.reserved,reserved:c.reserved,totalGranted:c.granted};
  }
  async session(ctx:Context) {
    invariant(ctx.authKind!=='mcp','BROWSER_SESSION_REQUIRED','Open AppScreen to manage your account.',403);
    await this.assertMembership(ctx);
    const [workspace,subscription,credits]=await Promise.all([this.db.query('SELECT * FROM workspaces WHERE id=$1',[ctx.workspaceId]),this.db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId]),this.credits(ctx.workspaceId)]);
    const sub=row<any>(subscription.rows[0]);
    const canGenerate=['trialing','active'].includes(sub.status);
    return {user:{id:ctx.userId,email:ctx.email},workspace:{...row(workspace.rows[0]),role:ctx.role},credits,subscription:sub,operator:canOperate(this.config,ctx),operatorMfaRequired:ctx.authKind==='web'&&ctx.role==='owner'&&!ctx.connection&&this.config.operatorUserIds.includes(ctx.userId)&&ctx.assuranceLevel!=='aal2',
      entitlements:{planId:sub.planId,status:sub.status,canGenerate,canExport:true,maxProjects:this.config.maxProjects,maxStorageBytes:this.config.maxStorageBytes,maxConcurrentJobs:this.config.maxConcurrentJobs}};
  }
  async listProjects(ctx:Context,_args:any={}) {
    requireScope(ctx,'projects:read');await this.assertMembership(ctx);
    const result=await this.db.query(`SELECT p.*, (SELECT count(*) FROM assets a WHERE a.project_id=p.id AND a.kind='source')::integer AS asset_count FROM projects p WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC`,[ctx.workspaceId]);
    return {projects:result.rows.map(r=>row(r))};
  }
  async updateProject(ctx:Context,projectId:string,args:any) {
    requireScope(ctx,'projects:write');await this.project(ctx,projectId);
    const brief=z.object({appName:z.string().max(120).optional(),promise:z.string().max(2000).optional(),audience:z.string().max(1000).optional(),style:z.string().max(2000).optional(),confirmedFacts:z.array(z.string().max(500)).max(40).optional(),brandColors:z.array(z.string().regex(/^#[a-f0-9]{6}$/i)).max(8).optional()}).strict().optional();
    const preferences=z.object({templateId:z.string().max(120).nullable().optional(),templateMode:z.enum(['auto','exact','inspiration']).optional(),locks:z.record(z.string().max(80),z.boolean()).optional(),screenCount:z.number().int().min(1).max(10).optional(),sourceIds:z.array(uuid).max(10).optional(),profile:z.object({id:z.literal('iphone-6.9'),width:z.literal(1320),height:z.literal(2868)}).optional(),locale:z.string().regex(/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/).optional()}).strict().optional();
    const input=z.object({brief,designPreferences:preferences,expectedUpdatedAt:z.string().datetime({offset:true})}).strict().parse(args);
    invariant(input.brief||input.designPreferences,'EMPTY_UPDATE','There is nothing to save.');
    // Preferences preserve historical choices even if the catalog changes.
    // Validate compatibility when starting work, not while saving a brief.
    const ids=input.designPreferences?.sourceIds;
    if(ids?.length){const assets=await this.db.query('SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND project_id=$2 AND workspace_id=$3 AND kind=\'source\'',[ids,projectId,ctx.workspaceId]);invariant(assets.rowCount===new Set(ids).size,'ASSET_FORBIDDEN','Use only uploaded assets in this project.',403);}
    return transaction(this.db,async client=>{
      await this.assertMembership(ctx,client);
      const r=await client.query('UPDATE projects SET brief=COALESCE($1::jsonb,brief),design_preferences=COALESCE($2::jsonb,design_preferences),updated_at=GREATEST(date_trunc(\'milliseconds\',clock_timestamp()),date_trunc(\'milliseconds\',updated_at)+interval \'1 millisecond\') WHERE id=$3 AND workspace_id=$4 AND date_trunc(\'milliseconds\',updated_at)=$5::timestamptz RETURNING *',[input.brief||null,input.designPreferences||null,projectId,ctx.workspaceId,input.expectedUpdatedAt]);
      if(!r.rowCount){const current=await this.project(ctx,projectId,client);throw new AppError('PROJECT_CONFLICT','This campaign changed in another tab. Reload the saved brief before continuing.',409,{project:current,updatedAt:current.updatedAt});}
      return {project:row(r.rows[0])};
    });
  }
  async createProject(ctx:Context,args:any) {
    requireScope(ctx,'projects:write');const name=z.string().trim().min(1).max(120).parse(args.name);
    const project=await transaction(this.db,async client=>{
      await this.assertMembership(ctx,client);await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);
      const receipt=await this.writeReceipt(client,ctx,'create-project',args);
      if(receipt?.result)return this.project(ctx,receipt.result.projectId,client);
      const count=await client.query('SELECT count(*)::integer AS count FROM projects WHERE workspace_id=$1 AND archived_at IS NULL',[ctx.workspaceId]);
      invariant(count.rows[0].count<this.config.maxProjects,'PROJECT_LIMIT','Your workspace has reached its project limit.',402);
      const r=await client.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3) RETURNING *',[randomUUID(),ctx.workspaceId,name]);await this.storeReceipt(client,ctx,receipt,{projectId:r.rows[0].id});return row(r.rows[0]);
    });return {project};
  }
  async signMedia(ctx:Context,assetId:string) {
    const key=new TextEncoder().encode(this.config.signingSecret);
    const token=await new SignJWT({assetId,workspaceId:ctx.workspaceId,userId:ctx.userId,...(ctx.connection?{connection:ctx.connection}:{})}).setProtectedHeader({alg:'HS256'}).setAudience('appscreen-media').setIssuedAt().setExpirationTime('10m').sign(key);
    return `${this.config.baseUrl}/api/media/${assetId}?token=${encodeURIComponent(token)}`;
  }
  async authorizeMedia(assetId:string,token:string) {
    try {
      const {payload}=await jwtVerify(token,new TextEncoder().encode(this.config.signingSecret),{audience:'appscreen-media',algorithms:['HS256']});
      invariant(payload.assetId===assetId,'MEDIA_FORBIDDEN','Download permission does not match this file.',403);
      if(payload.connection){const c=payload.connection as any;const permission=c.kind==='oauth'?await this.db.query('SELECT id FROM oauth_grants WHERE id::text=$1 AND user_id=$2 AND workspace_id::text=$3 AND version=$4 AND revoked_at IS NULL AND expires_at>now()',[c.id,payload.userId,payload.workspaceId,c.version]):await this.db.query('SELECT id FROM api_tokens WHERE id::text=$1 AND user_id=$2 AND workspace_id::text=$3 AND revoked_at IS NULL AND expires_at>now()',[c.id,payload.userId,payload.workspaceId]);invariant(permission.rowCount,'MEDIA_FORBIDDEN','The agent connection was revoked.',403);}
      const r=await this.db.query("SELECT a.* FROM assets a JOIN workspace_members m ON m.workspace_id=a.workspace_id WHERE a.id=$1 AND a.workspace_id=$2 AND m.user_id=$3 AND m.status='active'",[assetId,payload.workspaceId,payload.userId]);
      invariant(r.rowCount,'MEDIA_FORBIDDEN','Download permission expired or was revoked.',403);return r.rows[0];
    } catch { throw new AppError('MEDIA_FORBIDDEN','This download link expired. Reopen the project to get a new link.',403); }
  }
  async asset(ctx:Context,id:string) {
    uuid.parse(id);await this.assertMembership(ctx);
    const result=await this.db.query('SELECT * FROM assets WHERE id=$1 AND workspace_id=$2',[id,ctx.workspaceId]);
    invariant(result.rowCount,'ASSET_NOT_FOUND','Screenshot not found.',404);return row<any>(result.rows[0]);
  }
  async serializeAssets(ctx:Context,rows:any[]) {return Promise.all(rows.map(async r=>({...row<any>(r),storageKey:undefined,url:await this.signMedia(ctx,r.id)})));}
  async getProject(ctx:Context,args:any) {
    requireScope(ctx,'projects:read');const p=await this.project(ctx,args.projectId||args.id);
    const [a,j,r]=await Promise.all([this.db.query('SELECT * FROM assets WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at',[p.id,ctx.workspaceId]),this.db.query('SELECT * FROM agent_jobs WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 30',[p.id,ctx.workspaceId]),this.db.query('SELECT id,parent_revision_id,label,created_at FROM campaign_revisions WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 50',[p.id,ctx.workspaceId])]);
    return {project:p,revision:p.activeRevisionId?await this.getRevision(ctx,p.id,p.activeRevisionId):null,assets:await this.serializeAssets(ctx,a.rows),jobs:await Promise.all(j.rows.map(r=>this.jobResponse(ctx,r))),revisions:r.rows.map(r=>row(r)),pricing:{designCredits:this.config.designCredits,revisionCredits:this.config.revisionCredits}};
  }
  async getRevision(ctx:Context,projectId:string,revisionId:string) {
    requireScope(ctx,'projects:read');await this.project(ctx,projectId);uuid.parse(revisionId);
    const r=await this.db.query('SELECT * FROM campaign_revisions WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[revisionId,projectId,ctx.workspaceId]);
    invariant(r.rowCount,'REVISION_NOT_FOUND','Revision not found.',404);return row<any>(r.rows[0]);
  }
  async validateDocumentAssets(ctx:Context,projectId:string,document:any) {
    const {validateCampaign}=await import('../core/campaign.mjs');const validation=validateCampaign(document);invariant(validation.valid,'INVALID_CAMPAIGN','The design document is invalid.',400,validation.issues);
    invariant(document.id===projectId,'PROJECT_MISMATCH','The design belongs to a different project.');
    const assetIds=new Set<string>();
    for(const source of document.sources||[]) {if(source.assetId)assetIds.add(source.assetId);for(const v of Object.values(source.localizedAssets||{})){if(typeof v==='string')assetIds.add(v);else if((v as any)?.assetId)assetIds.add((v as any).assetId);}}
    for(const scene of document.scenes||[]){if(scene.background?.assetId)assetIds.add(scene.background.assetId);for(const element of scene.elements||[])if(element.assetId)assetIds.add(element.assetId);}
    // A campaign may not smuggle remote URLs or embedded image data into rendering.
    const scan=(value:any):void=>{if(!value||typeof value!=='object')return;for(const [key,val] of Object.entries(value)){if(['src','imageSrc','url'].includes(key)&&typeof val==='string'&&val.length)throw new AppError('UNSAFE_ASSET_REFERENCE','Use an uploaded asset reference instead of an image URL.');if(typeof val==='object')scan(val);}};scan(document);
    if(assetIds.size){const result=await this.db.query('SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND project_id=$2 AND workspace_id=$3 AND kind=\'source\'',[[...assetIds],projectId,ctx.workspaceId]);invariant(result.rowCount===assetIds.size,'ASSET_FORBIDDEN','Every source must be an uploaded asset in this project.',403);}
  }
  async saveRevision(ctx:Context,projectId:string,args:any,internal:{allowLockChanges?:boolean;newCampaign?:boolean;receiptAction?:string;receiptInput?:any}={}) {
    requireScope(ctx,'projects:write');await this.project(ctx,projectId);await this.validateDocumentAssets(ctx,projectId,args.document);
    const revision=await transaction(this.db,async client=>{
      const p=await client.query('SELECT * FROM projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,ctx.workspaceId]);
      const receipt=await this.writeReceipt(client,ctx,internal.receiptAction||'save-revision',{...(internal.receiptInput||args),projectId});
      if(receipt?.result){const prior=await client.query('SELECT * FROM campaign_revisions WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[receipt.result.revisionId,projectId,ctx.workspaceId]);invariant(prior.rowCount,'REVISION_NOT_FOUND','Saved revision is no longer available.',404);return row<any>(prior.rows[0]);}
      const expected=args.expectedRevisionId??null;
      if(args.apply && p.rows[0].active_revision_id!==expected)throw new AppError('REVISION_CONFLICT','This project changed while you were editing. Review the newer version before applying.',409,{activeRevisionId:p.rows[0].active_revision_id});
      await this.assertMembership(ctx,client);
      if(expected) {const parent=await client.query('SELECT document FROM campaign_revisions WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[expected,projectId,ctx.workspaceId]);invariant(parent.rowCount,'REVISION_NOT_FOUND','Base revision not found.',404);if(!internal.newCampaign){const {assertDocumentEditAllowed}=await import('../core/campaign.mjs');assertDocumentEditAllowed(parent.rows[0].document,args.document,{allowLockChanges:!!internal.allowLockChanges});}}
      const id=args.revisionId||randomUUID();const document={...args.document,revisionId:id};
      const result=await client.query('INSERT INTO campaign_revisions(id,workspace_id,project_id,parent_revision_id,document,qa,label,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING *',[id,ctx.workspaceId,projectId,expected,document,args.qa||{},args.label||'Saved design',ctx.userId]);
      await this.storeReceipt(client,ctx,receipt,{revisionId:id});
      if(args.apply)await client.query('UPDATE projects SET active_revision_id=$1,updated_at=GREATEST(date_trunc(\'milliseconds\',clock_timestamp()),date_trunc(\'milliseconds\',updated_at)+interval \'1 millisecond\') WHERE id=$2',[id,projectId]);
      if(!result.rowCount){const prior=await client.query('SELECT * FROM campaign_revisions WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[id,projectId,ctx.workspaceId]);invariant(prior.rowCount,'REVISION_CONFLICT','Revision identifier already exists.',409);return row<any>(prior.rows[0]);}
      return row<any>(result.rows[0]);
    });return {revision,project:await this.project(ctx,projectId)};
  }
  async applyRevision(ctx:Context,projectIdOrArgs:string|{projectId:string;revisionId:string;expectedRevisionId:string|null;idempotencyKey?:string},revisionArg?:string,expectedArg?:string|null) {
    const {projectId,revisionId,expectedRevisionId}=typeof projectIdOrArgs==='string'?{projectId:projectIdOrArgs,revisionId:revisionArg!,expectedRevisionId:expectedArg??null}:projectIdOrArgs;
    requireScope(ctx,'projects:write');await this.getRevision(ctx,projectId,revisionId);
    const project=await transaction(this.db,async client=>{
      const p=await client.query('SELECT * FROM projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,ctx.workspaceId]);await this.assertMembership(ctx,client);
      const receipt=await this.writeReceipt(client,ctx,'apply-revision',typeof projectIdOrArgs==='string'?{projectId,revisionId,expectedRevisionId}:projectIdOrArgs);
      if(receipt?.result)return row(p.rows[0]);
      invariant(p.rows[0].active_revision_id===expectedRevisionId,'REVISION_CONFLICT','This project has a newer revision. Review changes before applying.',409);
      const r=await client.query('UPDATE projects SET active_revision_id=$1,updated_at=GREATEST(date_trunc(\'milliseconds\',clock_timestamp()),date_trunc(\'milliseconds\',updated_at)+interval \'1 millisecond\') WHERE id=$2 AND workspace_id=$3 RETURNING *',[revisionId,projectId,ctx.workspaceId]);
      await this.storeReceipt(client,ctx,receipt,{revisionId});
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.workspaceId,ctx.userId,'revision.apply',revisionId]);return row(r.rows[0]);
    });return {project,revision:await this.getRevision(ctx,projectId,revisionId)};
  }
  async listTemplates(_ctx:Context,_args:any={}) {const {listTemplates}=await import('../core/templates.mjs');return {templates:listTemplates()};}
  async getTemplate(_ctx:Context,args:any) {const {getTemplate}=await import('../core/templates.mjs');const template=getTemplate(args.templateId);invariant(template,'TEMPLATE_NOT_FOUND','Template not found.',404);return {template};}
  async applyOperations(ctx:Context,args:any) {
    requireScope(ctx,'projects:write');args.baseRevisionId=args.baseRevisionId||args.expectedRevisionId;const revision=await this.getRevision(ctx,args.projectId,args.baseRevisionId);
    const {applyOperations}=await import('../core/campaign.mjs');const document=applyOperations(revision.document,args.operations,{respectLocks:true});
    return this.saveRevision(ctx,args.projectId,{document,expectedRevisionId:args.baseRevisionId,apply:false,label:'Agent edit'},{allowLockChanges:true,receiptAction:'apply-operations',receiptInput:args});
  }
  async createDraft(ctx:Context,args:any) {
    requireScope(ctx,'projects:write');const p=await this.project(ctx,args.projectId);const ids=z.array(uuid).min(1).max(10).parse(args.assetIds||args.sourceIds);
    const assets=await this.db.query('SELECT * FROM assets WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND project_id=$3 AND kind=\'source\'',[ids,ctx.workspaceId,p.id]);
    invariant(assets.rowCount===new Set(ids).size,'ASSET_FORBIDDEN','Use only uploaded assets in this project.',403);
    const {createCampaign}=await import('../core/campaign.mjs');
    invariant(new Set(ids).size===ids.length,'DUPLICATE_SOURCE','Choose each uploaded source once.');
    const profile=typeof args.profile==='string'?(z.literal('iphone-6.9').parse(args.profile),{id:'iphone-6.9',width:1320,height:2868}):args.profile;
    const document=(createCampaign as (options:any)=>any)({id:p.id,name:p.name,assets:ids.map(id=>{const a=assets.rows.find(a=>a.id===id);return {id,sourceId:id,name:a.name,width:a.width,height:a.height};}),brief:args.brief||{},templateId:args.templateId,templateMode:args.templateMode||'auto',screenCount:args.screenCount||Math.min(5,ids.length),profile,locale:args.locale||'en'});
    if(args.locks)document.locks=args.locks;
    return this.saveRevision(ctx,p.id,{document,expectedRevisionId:p.activeRevisionId,apply:!!args.apply,label:'New campaign'},{newCampaign:true,receiptAction:'create-draft',receiptInput:args});
  }
  async uploadAsset(ctx:Context,projectId:string,name:string,bytes:Buffer,assetId=randomUUID()) {
    requireScope(ctx,'assets:write');await this.project(ctx,projectId);
    invariant(bytes.length>0 && bytes.length<=this.config.uploadLimit,'UPLOAD_SIZE','This image exceeds the upload size limit.',413);
    const meta=await sharp(bytes,{limitInputPixels:this.config.maxPixels,failOn:'error'}).metadata().catch(()=>null);
    invariant(meta&&['png','jpeg'].includes(meta.format||'')&&meta.width&&meta.height,'INVALID_IMAGE','Upload a valid PNG or JPEG screenshot.');
    invariant((meta.pages||1)===1&&meta.width*meta.height<=this.config.maxPixels,'INVALID_IMAGE','Animated or oversized images are not supported.');
    const key=`${ctx.workspaceId}/sources/${assetId}.${meta.format==='jpeg'?'jpg':'png'}`;const mime=meta.format==='jpeg'?'image/jpeg':'image/png';
    // Serialize quota admission with workspace writes; never trust declared multipart size.
    await transaction(this.db,async client=>{
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);
      const usage=await client.query('SELECT COALESCE(sum(byte_size),0)::bigint AS used FROM assets WHERE workspace_id=$1',[ctx.workspaceId]);
      invariant(Number(usage.rows[0].used)+bytes.length<=this.config.maxStorageBytes,'STORAGE_LIMIT','Your workspace has reached its storage limit.',402);
      await recordMilestone(client,this.config,ctx.workspaceId,'first_upload');
      await this.storage.put(key,bytes,mime);
      try{await client.query('INSERT INTO assets(id,workspace_id,project_id,name,storage_key,mime_type,byte_size,width,height,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[assetId,ctx.workspaceId,projectId,name.replace(/[\x00-\x1f/\\]/g,'_').slice(0,180),key,mime,bytes.length,meta.width,meta.height,hash(bytes)]);}catch(error){await this.storage.remove(key);throw error;}
    });const asset=await this.asset(ctx,assetId);return {asset:{...asset,storageKey:undefined,url:await this.signMedia(ctx,assetId)}};
  }
  async requestAssetUpload(ctx:Context,args:any) {
    requireScope(ctx,'assets:write');await this.project(ctx,args.projectId);
    const mimeType=z.enum(['image/png','image/jpeg']).default('image/png').parse(args.mimeType);
    const byteLength=z.number().int().min(1).max(this.config.uploadLimit).optional().parse(args.byteLength);
    const checksum=z.string().regex(/^[a-f0-9]{64}$/i).optional().parse(args.checksum)?.toLowerCase();
    const ticket=await transaction(this.db,async client=>{
      await this.assertMembership(ctx,client);const receipt=await this.writeReceipt(client,ctx,'request-upload',args);
      if(receipt?.result){const prior=await client.query('SELECT * FROM upload_tickets WHERE id=$1 AND workspace_id=$2 AND user_id=$3',[receipt.result.uploadId,ctx.workspaceId,ctx.userId]);invariant(prior.rowCount&&new Date(prior.rows[0].expires_at).getTime()>Date.now(),'UPLOAD_EXPIRED','This upload request expired. Request another with a new request key.',409);return prior.rows[0];}
      const id=randomUUID();const token=createHmac('sha256',this.config.signingSecret).update(`upload:${id}`).digest('base64url');
      const r=await client.query('INSERT INTO upload_tickets(id,workspace_id,project_id,user_id,token_hash,name,expires_at,metadata) VALUES($1,$2,$3,$4,$5,$6,now()+interval \'10 minutes\',$7) RETURNING *',[id,ctx.workspaceId,args.projectId,ctx.userId,hash(token),z.string().min(1).max(180).parse(args.name||args.filename),{mimeType,byteLength,checksum,connection:ctx.connection||null}]);
      await this.storeReceipt(client,ctx,receipt,{uploadId:id});return r.rows[0];
    });
    const token=createHmac('sha256',this.config.signingSecret).update(`upload:${ticket.id}`).digest('base64url');
    return {uploadId:ticket.id,assetId:ticket.id,uploadUrl:`${this.config.baseUrl}/api/uploads/${ticket.id}?token=${token}`,method:'POST',headers:{'Content-Type':ticket.metadata.mimeType},expiresAt:new Date(ticket.expires_at).toISOString(),maxBytes:this.config.uploadLimit};
  }
  async completeAssetUpload(ctx:Context,args:any) {
    requireScope(ctx,'assets:write');await this.project(ctx,args.projectId);const asset=await this.asset(ctx,args.assetId);
    invariant(asset.projectId===args.projectId,'ASSET_NOT_FOUND','Screenshot not found in this project.',404);
    const ticket=await this.db.query('SELECT id FROM upload_tickets WHERE id=$1 AND project_id=$2 AND workspace_id=$3 AND user_id=$4 AND used_at IS NOT NULL',[asset.id,args.projectId,ctx.workspaceId,ctx.userId]);
    invariant(ticket.rowCount,'UPLOAD_NOT_COMPLETE','This upload has not been completed by your connection.',409);
    return {asset:{...asset,storageKey:undefined,url:await this.signMedia(ctx,asset.id)}};
  }
  async getQuote(ctx:Context,args:any) {await this.project(ctx,args.projectId);return {credits:args.kind==='design'?this.config.designCredits:args.kind==='revision'?this.config.revisionCredits:0};}
  private async assertJobCloudSupport(kind:string,input:any,revision?:any) {
    const {getTemplate}=await import('../core/templates.mjs');
    const {hasCampaignLocks}=await import('../core/campaign.mjs');
    const {getCloudRenderSupport,cloudSupportMessage}=await import('../core/cloud-support.mjs');
    const mode=input.templateMode||input.template?.mode||'auto';
    if(kind==='design'&&mode!=='auto') {
      const id=input.templateId||input.template?.id;
      invariant(id,'TEMPLATE_REQUIRED','Choose a template, or use automatic selection.');
      const template=getTemplate(id);
      invariant(template,'TEMPLATE_NOT_FOUND','Template not found.',404);
      invariant(template.cloudCompatible,'UNSUPPORTED_TEMPLATE',cloudSupportMessage(template),422,template.cloudLimitations);
    }
    if(revision&&(kind!=='design'||hasCampaignLocks(revision.document))) {
      const support=getCloudRenderSupport(revision.document);
      invariant(support.cloudCompatible,'UNSUPPORTED_DESIGN',cloudSupportMessage(support),422,support.cloudLimitations);
    }
  }
  async createJob(ctx:Context,args:any) {
    const kind=z.enum(['design','revision','export','render']).parse(args.kind);const input={...(args.input||args)};if(args.maxCredits!==undefined)input.maxCredits=args.maxCredits;delete input.kind;delete input.projectId;
    const projectId=uuid.parse(args.projectId);requireScope(ctx,['design','revision'].includes(kind)?'ai:run':'exports:write');
    await this.project(ctx,projectId);const ai=['design','revision'].includes(kind);
    invariant(!ai||(this.config.allowLiveAI&&this.config.openaiKey),'AI_NOT_CONFIGURED','AI generation is not enabled on this server yet.',503);
    const key=z.string().min(8).max(180).parse(args.idempotencyKey||input.idempotencyKey);delete input.idempotencyKey;
    let baseRevision:any=null,legacyAutoInput:any;
    if(kind==='design') {
      const existing=input.revisionId?await this.getRevision(ctx,projectId,input.revisionId):null;
      baseRevision=existing;
      input.sourceIds=z.array(z.string().min(1)).min(1).max(10).parse(input.sourceIds||existing?.document.sources.map((s:any)=>s.id));input.screenCount=z.number().int().min(1).max(10).default(5).parse(input.screenCount);
      if(!input.brief&&existing)input.brief=existing.document.brief;
      input.brief=z.union([z.string().trim().min(3).max(8000),z.record(z.string(),z.unknown())]).parse(input.brief);
      input.templateMode=z.enum(['auto','exact','inspiration']).default('auto').parse(input.templateMode||input.template?.mode);input.templateId=input.templateId||input.template?.id;
      if(input.templateMode==='auto') {
        // Preserve the precise pre-normalization key order for receipts accepted
        // before this change. A changed brief/source/count must still conflict.
        legacyAutoInput=structuredClone(input);
        // A saved gallery choice is not a selection in automatic mode.
        delete input.templateId;
        if(input.template)input.template={...input.template,id:undefined};
      }
      const assetIds=existing?input.sourceIds.map((id:string)=>{const source=existing.document.sources.find((s:any)=>s.id===id);invariant(source,'SOURCE_NOT_FOUND','Source is not part of this revision.');return source.assetId;}):input.sourceIds.map((id:string)=>uuid.parse(id));
      const sources=await this.db.query('SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND project_id=$3 AND kind=\'source\'',[assetIds,ctx.workspaceId,projectId]);invariant(sources.rowCount===new Set(assetIds).size,'ASSET_FORBIDDEN','One or more screenshots do not belong to this project.',403);
    } else {
      input.revisionId=input.revisionId||input.baseRevisionId;
      baseRevision=await this.getRevision(ctx,projectId,input.revisionId);
      if(kind==='revision')input.prompt=z.string().trim().min(3).max(4000).parse(input.prompt||input.instruction);
    }
    const amount=kind==='design'?this.config.designCredits:kind==='revision'?this.config.revisionCredits:0;
    if(ctx.authKind==='mcp'&&ai)invariant(Number.isFinite(input.maxCredits)&&input.maxCredits>=amount,'SPEND_APPROVAL_REQUIRED',`Authorize at most ${amount} credits to start this job.`,402,{requiredCredits:amount});
    const requestHash=hash(JSON.stringify({kind,projectId,input}));
    const legacyRequestHash=legacyAutoInput?hash(JSON.stringify({kind,projectId,input:legacyAutoInput})):null;
    const job=await transaction(this.db,async client=>{
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);await this.assertMembership(ctx,client);
      const existing=await client.query('SELECT * FROM agent_jobs WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,key]);
      if(existing.rowCount){invariant(existing.rows[0].request_hash===requestHash||(legacyRequestHash!==null&&existing.rows[0].request_hash===legacyRequestHash),'IDEMPOTENCY_CONFLICT','This request key was already used for different work.',409);return existing.rows[0];}
      // Existing receipts report prior work; only NEW work passes admission.
      await this.assertJobCloudSupport(kind,input,baseRevision);
      const sub=await client.query('SELECT status FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId]);invariant(!ai||['trialing','active'].includes(sub.rows[0].status),'SUBSCRIPTION_REQUIRED','Update your subscription before generating.',402);
      const active=await client.query('SELECT count(*)::integer AS count FROM agent_jobs WHERE workspace_id=$1 AND NOT(status=ANY($2::text[]))',[ctx.workspaceId,terminal]);invariant(active.rows[0].count<this.config.maxConcurrentJobs,'JOB_LIMIT','Wait for a current job to finish before starting another.',429);
      const credits=await this.credits(ctx.workspaceId,client);invariant(credits.available>=amount,'INSUFFICIENT_CREDITS',`This action needs ${amount} credits.`,402,{required:amount,available:credits.available});
      const id=randomUUID();const r=await client.query('INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,input,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,ctx.workspaceId,projectId,ctx.userId,kind,input,key,requestHash]);
      await client.query('INSERT INTO credit_reservations(job_id,workspace_id,amount) VALUES($1,$2,$3)',[id,ctx.workspaceId,amount]);return r.rows[0];
    });if(this.enqueue)await this.enqueue(job.id).catch(()=>{/* The durable database outbox is scanned by the worker. */});return {job:await this.jobResponse(ctx,job)};
  }
  async jobResponse(ctx:Context,r:any) {
    const job=row<any>(r);if(job.result){job.result=structuredClone(job.result);for(const p of job.result.previews||[])if(p.assetId)p.url=await this.signMedia(ctx,p.assetId);for(const p of job.result.artifacts||[])if(p.assetId)p.url=await this.signMedia(ctx,p.assetId);if(job.result.contactSheet?.assetId)job.result.contactSheet.url=await this.signMedia(ctx,job.result.contactSheet.assetId);}return job;
  }
  async getJob(ctx:Context,args:any) {requireScope(ctx,'projects:read');await this.assertMembership(ctx);const r=await this.db.query('SELECT * FROM agent_jobs WHERE id=$1 AND workspace_id=$2',[uuid.parse(args.jobId||args.id),ctx.workspaceId]);invariant(r.rowCount,'JOB_NOT_FOUND','Job not found.',404);return {job:await this.jobResponse(ctx,r.rows[0])};}
  async getResult(ctx:Context,args:any) {const {job}=await this.getJob(ctx,args);return {jobId:job.id,status:job.status,result:job.result};}
  async cancelJob(ctx:Context,args:any) {
    requireScope(ctx,'projects:write');const {job}=await this.getJob(ctx,args);if(terminal.includes(job.status))return {job};
    await this.db.query('UPDATE agent_jobs SET cancel_requested=true,updated_at=now() WHERE id=$1 AND workspace_id=$2',[job.id,ctx.workspaceId]);
    await this.audit(ctx,'job.cancel',job.id);return this.getJob(ctx,{jobId:job.id});
  }
  async retryJob(ctx:Context,args:any) {
    requireScope(ctx,'projects:write');const {job}=await this.getJob(ctx,args);
    requireScope(ctx,['design','revision'].includes(job.kind)?'ai:run':'exports:write');
    await transaction(this.db,async client=>{
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);await this.assertMembership(ctx,client);
      const current=await client.query('SELECT * FROM agent_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[job.id,ctx.workspaceId]);const stopped=current.rows[0];
      const receipt=await this.writeReceipt(client,ctx,'retry-job',args);if(receipt?.result)return;
      invariant(stopped&&['failed','cancelled','needs-input'].includes(stopped.status),'JOB_NOT_RETRYABLE','Only stopped jobs can be retried.',409);
      invariant(!stopped.result,'RESULT_ALREADY_DELIVERED','This job already delivered a draft. Open it or request a new refinement.',409);
      const ai=['design','revision'].includes(stopped.kind);
      invariant(!ai||(this.config.allowLiveAI&&this.config.openaiKey),'AI_NOT_CONFIGURED','AI generation is not enabled on this server yet.',503);
      let revisionId=stopped.input.revisionId||stopped.input.baseRevisionId;
      if(!revisionId)revisionId=(await client.query("SELECT data FROM agent_job_steps WHERE job_id=$1 AND stage='base_revision'",[job.id])).rows[0]?.data?.id;
      let revision;
      if(revisionId) {
        const found=await client.query('SELECT document FROM campaign_revisions WHERE id=$1 AND project_id=$2 AND workspace_id=$3',[uuid.parse(revisionId),stopped.project_id,ctx.workspaceId]);
        invariant(found.rowCount,'REVISION_NOT_FOUND','Revision not found.',404);revision=found.rows[0];
      }
      await this.assertJobCloudSupport(stopped.kind,stopped.input,revision);
      const staged=await client.query('SELECT data FROM agent_job_steps WHERE job_id=$1 AND stage=ANY($2::text[])',[job.id,['composing','designing','refining','repairing_1','repairing_2']]);
      for(const checkpoint of staged.rows) {
        invariant(Array.isArray(checkpoint.data?.scenes),'INVALID_CHECKPOINT','This saved design cannot be resumed. Start a new draft.',409);
        await this.assertJobCloudSupport('revision',{}, {document:checkpoint.data});
      }
      const sub=await client.query('SELECT status FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId]);invariant(!ai||['trialing','active'].includes(sub.rows[0]?.status),'SUBSCRIPTION_REQUIRED','Update your subscription before generating.',402);
      const active=await client.query('SELECT count(*)::integer AS count FROM agent_jobs WHERE workspace_id=$1 AND NOT(status=ANY($2::text[]))',[ctx.workspaceId,terminal]);invariant(active.rows[0].count<this.config.maxConcurrentJobs,'JOB_LIMIT','Wait for a current job to finish before retrying.',429);
      const reservation=await client.query('SELECT * FROM credit_reservations WHERE job_id=$1 FOR UPDATE',[job.id]);const r=reservation.rows[0];
      invariant(r,'RESERVATION_NOT_FOUND','The job reservation is missing. Contact support.',409);
      if(ctx.authKind==='mcp'&&ai)invariant(Number.isFinite(stopped.input.maxCredits)&&stopped.input.maxCredits>=r.amount,'SPEND_APPROVAL_REQUIRED','Start a new job with an approved credit limit.',402);
      if(r.status==='released'){const credit=await this.credits(ctx.workspaceId,client);invariant(credit.available>=r.amount,'INSUFFICIENT_CREDITS','Not enough credits to retry.',402);await client.query("UPDATE credit_reservations SET status='reserved',updated_at=now() WHERE job_id=$1",[job.id]);}
      await client.query("UPDATE agent_jobs SET status='queued',stage='queued',error=NULL,cancel_requested=false,updated_at=now(),heartbeat_at=NULL WHERE id=$1",[job.id]);
      await this.storeReceipt(client,ctx,receipt,{jobId:job.id});
    });
    if(this.enqueue)await this.enqueue(job.id).catch(()=>{});return this.getJob(ctx,{jobId:job.id});
  }
  async settleJob(jobId:string,success:boolean) {
    await transaction(this.db,async client=>{const result=await client.query('SELECT * FROM credit_reservations WHERE job_id=$1 FOR UPDATE',[jobId]);if(!result.rowCount||result.rows[0].status!=='reserved')return;const r=result.rows[0];if(success&&r.amount)await client.query('INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reference) DO NOTHING',[randomUUID(),r.workspace_id,-r.amount,'generation',`job:${jobId}`]);await client.query('UPDATE credit_reservations SET status=$1,updated_at=now() WHERE job_id=$2',[success?'settled':'released',jobId]);});
  }
  async finishJob(jobId:string,outcome:{status:string;result?:any;error?:any;success:boolean;expectedAttempt:number}) {
    invariant(terminal.includes(outcome.status),'INVALID_JOB_STATE','Invalid final job state.');
    return transaction(this.db,async client=>{
      const found=await client.query('SELECT * FROM agent_jobs WHERE id=$1 FOR UPDATE',[jobId]);const job=found.rows[0];
      if(!job||job.status!=='running'||job.attempts!==outcome.expectedAttempt)return false;
      const reservations=await client.query('SELECT * FROM credit_reservations WHERE job_id=$1 FOR UPDATE',[jobId]);const reservation=reservations.rows[0];
      invariant(reservation,'RESERVATION_NOT_FOUND','The job reservation is missing.',409);
      if(reservation.status==='reserved') {
        if(outcome.success&&reservation.amount)await client.query('INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reference) DO NOTHING',[randomUUID(),job.workspace_id,-reservation.amount,'generation',`job:${jobId}`]);
        await client.query('UPDATE credit_reservations SET status=$1,updated_at=now() WHERE job_id=$2',[outcome.success?'settled':'released',jobId]);
      }
      await client.query('UPDATE agent_jobs SET status=$1,stage=$1,result=$2,error=$3,updated_at=now() WHERE id=$4',[outcome.status,outcome.result||null,outcome.error||null,jobId]);
      await client.query('INSERT INTO job_events(job_id,workspace_id,event) VALUES($1,$2,$3)',[jobId,job.workspace_id,{stage:outcome.status,status:outcome.status,...(outcome.result?{revisionId:outcome.result.revisionId}:{}),...(outcome.error?{error:outcome.error}:{})}]);
      if(outcome.success&&outcome.result?.previews?.length) {
        if(outcome.status==='ready')await recordMilestone(client,this.config,job.workspace_id,'first_campaign');
        if(job.kind==='export'&&['png','zip'].includes(job.input.format||'zip')&&outcome.result?.artifacts?.length)await recordMilestone(client,this.config,job.workspace_id,'first_export');
      }
      const notice=outcome.status==='needs-input'?'needs-review':outcome.status==='failed'?'job-failed':outcome.status==='ready'?(job.kind==='export'||job.kind==='render'?'export-ready':'design-ready'):null;
      if(notice)await enqueueNotification(client,{kind:notice,workspaceId:job.workspace_id,recipientUserId:job.user_id,jobId,attempt:job.attempts},{emailEnabled:this.config.emailEnabled});
      return true;
    });
  }
}
