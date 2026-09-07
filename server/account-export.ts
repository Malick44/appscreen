import JSZip from 'jszip';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { row } from './db.js';
import { AppError, invariant } from './errors.js';

const MiB=1024*1024;
const MAX_EXPORTS=2;
// Thirteen data files plus README, manifest and the final integrity record.
const METADATA_FILES=16;
// Storage currently exposes buffered reads. Never read the whole workspace at
// once, and retain a process-local permit for an uncancellable provider read
// even if its HTTP download is cancelled in the meantime.
let pendingStorageReads=0;
const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','application/zip':'zip'};
const privateFields=new Set(['apikey','accesstoken','refreshtoken','idtoken','token','tokenhash','clientsecret','secret','secretkey','signingsecret','password','authorization','cookie','storagekey','signedurl','uploadurl','url','src','imagesrc']);

/** Keep editable content and stable asset IDs, never runtime URLs or credentials. */
function portable(value:any):any {
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(portable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!privateFields.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,portable(item)]));
  return value;
}
const failure=(error:unknown)=>error instanceof AppError?error:new AppError('ACCOUNT_EXPORT_FAILED','The backup could not be completed. No complete archive was produced.',503);
const cancelled=()=>new AppError('ACCOUNT_EXPORT_CANCELLED','The backup download was cancelled.',499);

export type AccountExportOptions={
  signal?:AbortSignal;
  /** Server-side resource limits, not client-supplied query parameters. */
  maxDurationMs?:number;
  maxAssetBytes?:number;
  maxArchiveBytes?:number;
  maxMetadataBytes?:number;
  maxFiles?:number;
};
export type AccountExportResult={
  stream:PassThrough;filename:string;contentType:'application/zip';exportId:string;
  completion:Promise<{exportId:string;byteSize:number;includedAssets:number}>;
  cancel:()=>void;
};

/**
 * Binary route integration:
 * const controller=new AbortController();
 * req.raw.once('aborted',()=>controller.abort());
 * const backup=await createAccountExport(services,ctx,{signal:controller.signal});
 * reply.raw.once('close',()=>{if(!reply.raw.writableFinished)backup.cancel();});
 * void backup.completion.catch(error=>logger.warn({code:error.code}));
 * return reply.header('Cache-Control','private, no-store')
 *   .header('Content-Disposition',`attachment; filename="${backup.filename}"`)
 *   .type(backup.contentType).send(backup.stream);
 *
 * Scope: current owner's personal workspace, not unrelated memberships.
 * PostgreSQL repeatable-read cursors keep all metadata in one snapshot; immutable
 * storage bytes are checked against that snapshot's lengths and SHA-256 hashes.
 * Sources are mandatory. Redundant ZIP artifacts and oversized derived files
 * are explicitly listed as omitted. This is portable data, not a restore API.
 */
export async function createAccountExport(services:AppServices,ctx:Context,options:AccountExportOptions={}):Promise<AccountExportResult> {
  invariant(ctx.authKind!=='mcp'&&ctx.role==='owner','OWNER_REQUIRED','Only the workspace owner can download an account backup.',403);
  const limits={duration:options.maxDurationMs??120_000,asset:options.maxAssetBytes??64*MiB,archive:options.maxArchiveBytes??2*1024*MiB,metadata:options.maxMetadataBytes??128*MiB,files:options.maxFiles??10_000};
  invariant(Object.values(limits).every(value=>Number.isSafeInteger(value)&&value>0)&&limits.duration<=300_000&&limits.asset<=256*MiB&&limits.archive<=3*1024*MiB&&limits.metadata<=256*MiB&&limits.files<=50_000,'ACCOUNT_EXPORT_LIMIT_INVALID','Invalid backup resource limits.',500);
  const assertOwner=async(conn:pg.Pool|pg.PoolClient=services.db)=>{
    await services.assertMembership(ctx,conn);
    const membership=await conn.query('SELECT role,status FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId]);
    invariant(membership.rows[0]?.status==='active','WORKSPACE_FORBIDDEN','Workspace access was revoked.',403);
    invariant(membership.rows[0]?.role==='owner','OWNER_REQUIRED','Workspace ownership changed. Sign in again before downloading a backup.',403);
  };
  await assertOwner();
  if(options.signal?.aborted)throw cancelled();
  const exportId=randomUUID(),controller=new AbortController();
  const abortFromRequest=()=>controller.abort(cancelled());
  options.signal?.addEventListener('abort',abortFromRequest,{once:true});
  let client:pg.PoolClient;
  try {client=await services.db.connect();}
  catch(error){options.signal?.removeEventListener('abort',abortFromRequest);throw failure(error);}
  const lockKeys:string[]=[];
  const inputs=new Set<Readable>();
  let transactionOpen=false,released=false,started=false,finalized=false,zipStream:any,output:PassThrough|undefined;
  let deadline:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined;
  let totalBytes=0,metadataBytes=0,includedAssets=0,checking=false;
  const check=()=>{if(controller.signal.aborted)throw failure(controller.signal.reason);};
  const audit=async(action:string,code?:string)=>services.audit(ctx,action,exportId,{scope:'current-workspace',...(code?{code}:{}),byteSize:totalBytes,includedAssets});
  const release=async()=>{
    if(released)return;released=true;
    let discard=false;
    try {
      if(transactionOpen){await client.query('ROLLBACK');transactionOpen=false;}
      for(const key of lockKeys.reverse())await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
    } catch {discard=true;}
    finally {client.release(discard);}
  };
  const stop=(error:AppError)=>{
    if(!controller.signal.aborted)controller.abort(error);
    zipStream?.pause();
    for(const input of inputs)input.destroy(error);
    output?.destroy(error);
  };
  const onAbort=()=>stop(failure(controller.signal.reason));
  controller.signal.addEventListener('abort',onAbort,{once:true});
  const clear=()=>{
    if(deadline)clearTimeout(deadline);if(poll)clearInterval(poll);
    options.signal?.removeEventListener('abort',abortFromRequest);
    controller.signal.removeEventListener('abort',onAbort);
  };
  try {
    deadline=setTimeout(()=>stop(new AppError('ACCOUNT_EXPORT_TIMEOUT','The backup exceeded its download time limit. Try again on a faster connection or contact support.',408)),limits.duration);deadline.unref();
    const workspaceKey=`account-export-workspace:${ctx.workspaceId}`;
    const acquired=await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[workspaceKey]);
    invariant(acquired.rows[0].acquired,'ACCOUNT_EXPORT_BUSY','A backup for this workspace is already downloading.',409);lockKeys.push(workspaceKey);
    for(let slot=0;slot<MAX_EXPORTS;slot++) {
      const key=`account-export-slot:${slot}`;
      if((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[key])).rows[0].acquired){lockKeys.push(key);break;}
    }
    invariant(lockKeys.length===2,'ACCOUNT_EXPORT_BUSY','Backup capacity is busy. Please try again shortly.',429);
    check();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transactionOpen=true;
    await client.query("SET LOCAL statement_timeout='20s'");
    await client.query("SELECT set_config('idle_in_transaction_session_timeout',$1,true)",[`${limits.duration+5000}ms`]);
    await assertOwner(client);
    const workspace=(await client.query('SELECT id,name,created_at,transaction_timestamp() AS snapshot_at FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    invariant(workspace,'WORKSPACE_FORBIDDEN','Workspace not found.',403);
    const counts=(await client.query(`SELECT
      (SELECT count(*)::integer FROM projects WHERE workspace_id=$1) AS projects,
      (SELECT count(*)::integer FROM campaign_revisions WHERE workspace_id=$1) AS revisions,
      (SELECT count(*)::integer FROM assets WHERE workspace_id=$1) AS assets,
      (SELECT count(*)::integer FROM assets WHERE workspace_id=$1 AND kind='source') AS sources,
      (SELECT count(*)::integer FROM account_requests WHERE workspace_id=$1 AND kind='support') AS support_cases,
      (SELECT count(*)::integer FROM support_messages m JOIN account_requests r ON r.id=m.request_id AND r.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND r.kind='support' AND m.visibility='customer') AS support_messages,
      (SELECT count(*)::integer FROM notifications WHERE workspace_id=$1 AND recipient_user_id=$2) AS notifications,
      (SELECT count(*)::integer FROM email_preferences WHERE workspace_id=$1 AND user_id=$2) AS email_preferences,
      (SELECT count(*)::integer FROM email_outbox WHERE workspace_id=$1 AND recipient_user_id=$2) AS email_deliveries,
      (SELECT count(*)::integer FROM product_milestones WHERE workspace_id=$1) AS product_milestones,
      (SELECT COALESCE(sum(octet_length(metadata::text)),0) FROM assets WHERE workspace_id=$1) AS asset_metadata_bytes,
      (SELECT COALESCE(max(octet_length(document::text)),0) FROM campaign_revisions WHERE workspace_id=$1) AS largest_document`,[ctx.workspaceId,ctx.userId])).rows[0];
    invariant(counts.assets+METADATA_FILES<=limits.files&&counts.largest_document<=8*MiB&&Number(counts.asset_metadata_bytes)<=Math.min(limits.metadata,16*MiB),'ACCOUNT_EXPORT_TOO_LARGE','This workspace needs a support-assisted backup because its file or document count exceeds the download limit.',413);
    const assetRows=(await client.query('SELECT id,project_id,name,storage_key,mime_type,byte_size,width,height,sha256,kind,metadata,created_at FROM assets WHERE workspace_id=$1 ORDER BY project_id,id',[ctx.workspaceId])).rows;
    const assets=assetRows.map(asset=>{
      invariant(/^[a-f0-9-]{36}$/.test(asset.id)&&/^[a-f0-9-]{36}$/.test(asset.project_id)&&asset.storage_key.startsWith(`${ctx.workspaceId}/`)&&!asset.storage_key.split('/').some((part:string)=>part==='.'||part==='..'),'ACCOUNT_EXPORT_ASSET_INVALID','A stored file has an invalid workspace reference.',409);
      const size=Number(asset.byte_size);
      invariant(Number.isSafeInteger(size)&&size>0&&/^[a-f0-9]{64}$/i.test(asset.sha256),'ACCOUNT_EXPORT_ASSET_INVALID','A stored file has invalid integrity metadata.',409);
      let omission:string|undefined;
      if(asset.kind!=='source'&&asset.mime_type==='application/zip')omission='Redundant derived ZIP archive; original sources and individual image artifacts are included separately.';
      else if(size>limits.asset) {
        invariant(asset.kind!=='source','ACCOUNT_EXPORT_TOO_LARGE','An original source exceeds the single-file backup limit. Contact support for a complete backup.',413);
        omission='Derived artifact exceeds the single-file streaming limit.';
      }
      const path=omission?null:`assets/${asset.project_id}/${asset.id}.${extensions[asset.mime_type]||'bin'}`;
      return {...asset,size,path,omission};
    });
    const included=assets.filter(asset=>asset.path);includedAssets=included.length;
    invariant(included.reduce((sum,asset)=>sum+asset.size,0)<limits.archive,'ACCOUNT_EXPORT_TOO_LARGE','The backup exceeds the downloadable archive limit. Contact support for a larger backup.',413);
    const snapshotAt=new Date(workspace.snapshot_at).toISOString();
    const manifest={format:'appscreen-workspace-backup',version:2,exportId,snapshotAt,scope:{type:'current-workspace',workspaceId:ctx.workspaceId,requestedBy:ctx.userId},counts:{projects:counts.projects,revisions:counts.revisions,assets:counts.assets,originalSources:counts.sources,includedAssets,omittedArtifacts:assets.length-included.length,supportCases:counts.support_cases,publicSupportMessages:counts.support_messages,notifications:counts.notifications,emailPreferences:counts.email_preferences,emailDeliveries:counts.email_deliveries,productMilestones:counts.product_milestones},records:{workspace:'data/workspace.json',members:'data/members.ndjson',projects:'data/projects.ndjson',revisions:'data/revisions.ndjson',assets:'data/assets.ndjson',subscription:'data/subscription.ndjson',credits:'data/credits.ndjson',supportCases:'data/support-cases.ndjson',supportMessages:'data/support-messages.ndjson',notifications:'data/notifications.ndjson',emailPreferences:'data/email-preferences.ndjson',emailDeliveries:'data/email-deliveries.ndjson',productMilestones:'data/product-milestones.ndjson'},assetIdentity:'Stable asset IDs map to archive-relative paths in data/assets.ndjson; there are no expiring download URLs.',consistency:'All metadata is from one PostgreSQL repeatable-read snapshot. Every included immutable blob is checked against its snapshot SHA-256 and byte length.',restore:{automated:false,note:'Portable source data and editable campaign documents; no automated restore/import workflow is currently provided.'},omissions:['Other workspaces and browser-only local projects are outside this backup scope.','Supabase identity-provider profile fields not stored in AppScreen are not included; AppScreen membership/profile identity is included.','Authentication credentials, API/OAuth connections, upload tickets, idempotency receipts, provider secrets and payment identifiers are intentionally excluded.','Raw payment/provider events, job execution checkpoints, operational logs, audit trails, deletion requests and live reservations are not included.','Support initial messages and public replies are workspace-visible; internal support notes and staff identities are excluded.','Only the requesting user’s notification metadata is included, not other workspace members’ inboxes. Product milestones contain no user content.','Only the requesting user’s current-workspace email preference and delivery metadata are included. Other recipients’ email preferences and delivery history are excluded.','Email message payloads, their recipient addresses and hashes, provider message/event identifiers, suppression records and internal delivery details are excluded. Existing AppScreen profile email remains in the profile and membership records.','Runtime URLs, storage locations and credential-shaped metadata fields are redacted; asset IDs remain stable.','Redundant derived ZIPs and over-limit derived artifacts are identified individually in data/assets.ndjson.'],limits:{maxSingleFileBytes:limits.asset,maxArchiveBytes:limits.archive}};
    const zip=new JSZip();
    const add=(path:string,data:string|Readable)=>zip.file(path,data,{date:new Date(snapshotAt),createFolders:false,compression:'STORE',unixPermissions:0o100600});
    const json=(value:any)=>JSON.stringify(portable(value));
    const source=(generator:AsyncGenerator<Buffer>)=>{
      const input=Readable.from(generator,{objectMode:false,highWaterMark:64*1024});inputs.add(input);
      input.once('end',()=>inputs.delete(input));input.on('error',error=>stop(failure(error)));return input;
    };
    async function* records(name:string,sql:string,params:any[]=[ctx.workspaceId]):AsyncGenerator<Buffer> {
      check();await assertOwner();check();
      await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`,params);
      try {
        for(;;) {
          check();await assertOwner();check();
          const batch=await client.query(`FETCH FORWARD 8 FROM ${name}`);
          if(!batch.rowCount)break;
          for(const record of batch.rows) {
            const bytes=Buffer.from(json(row(record))+'\n');metadataBytes+=bytes.length;
            invariant(bytes.length<=9*MiB&&metadataBytes<=limits.metadata,'ACCOUNT_EXPORT_TOO_LARGE','The backup metadata exceeds the streaming limit. Contact support for a larger backup.',413);
            check();yield bytes;
          }
        }
      } finally {if(!released)await client.query(`CLOSE ${name}`);}
    }
    async function* assetIndex():AsyncGenerator<Buffer> {
      for(const asset of assets) {
        check();const {storage_key,size,omission,path,...metadata}=asset;
        const bytes=Buffer.from(json({...row(metadata),byteSize:size,path,included:!!path,...(omission?{omission}: {})})+'\n');metadataBytes+=bytes.length;
        invariant(metadataBytes<=limits.metadata,'ACCOUNT_EXPORT_TOO_LARGE','The backup metadata exceeds the streaming limit.',413);yield bytes;
      }
    }
    async function* assetContent(asset:any):AsyncGenerator<Buffer> {
      check();await assertOwner();check();
      invariant(pendingStorageReads<MAX_EXPORTS,'ACCOUNT_EXPORT_BUSY','Earlier storage requests are still finishing. Try the backup again shortly.',503);
      pendingStorageReads++;
      const read=Promise.resolve().then(()=>services.storage.read(asset.storage_key)).finally(()=>{pendingStorageReads--;});
      let aborted:(()=>void)|undefined;
      try {
        const bytes=await Promise.race([read,new Promise<never>((_resolve,reject)=>{aborted=()=>reject(failure(controller.signal.reason));controller.signal.addEventListener('abort',aborted,{once:true});if(controller.signal.aborted)aborted();})]);
        check();
        invariant(bytes.length===asset.size&&bytes.length<=limits.asset&&createHash('sha256').update(bytes).digest('hex')===asset.sha256,'ACCOUNT_EXPORT_INTEGRITY_FAILED','A stored file did not match its recorded checksum. Contact support; this incomplete backup must not be used.',409);
        for(let offset=0;offset<bytes.length;offset+=64*1024){check();yield bytes.subarray(offset,offset+64*1024);}
      } finally {if(aborted)controller.signal.removeEventListener('abort',aborted);}
    }
    add('README.txt','AppScreen workspace backup\n\nStart with manifest.json. NDJSON files contain one JSON record per line.\nMatch campaign source assetId values with IDs and relative paths in data/assets.ndjson.\nOriginal asset names are metadata, not filesystem paths. Included bytes have verified SHA-256 hashes.\nArchived projects and every saved revision are included. No automated restore is provided.\nA cancelled or failed download is incomplete and must not be used as a backup.\n');
    add('manifest.json',JSON.stringify(manifest,null,2));
    add('data/workspace.json',json({workspace:{id:workspace.id,name:workspace.name,createdAt:workspace.created_at},owner:{id:ctx.userId,email:ctx.email}}));
    add('data/members.ndjson',source(records('export_members','SELECT workspace_id,user_id,email,role,status,created_at FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id')));
    add('data/projects.ndjson',source(records('export_projects','SELECT id,workspace_id,name,active_revision_id,brief,design_preferences,created_at,updated_at,archived_at FROM projects WHERE workspace_id=$1 ORDER BY id')));
    add('data/revisions.ndjson',source(records('export_revisions','SELECT id,workspace_id,project_id,parent_revision_id,document,qa,label,created_by,created_at FROM campaign_revisions WHERE workspace_id=$1 ORDER BY project_id,created_at,id')));
    add('data/assets.ndjson',source(assetIndex()));
    add('data/subscription.ndjson',source(records('export_subscription','SELECT workspace_id,plan_id,status,current_period_end,cancel_at_period_end,updated_at FROM subscriptions WHERE workspace_id=$1')));
    add('data/credits.ndjson',source(records('export_credits','SELECT id,workspace_id,amount,reason,created_at FROM credit_ledger WHERE workspace_id=$1 ORDER BY created_at,id')));
    add('data/support-cases.ndjson',source(records('export_support_cases',"SELECT id,workspace_id,CASE WHEN status IN ('pending','in-progress','waiting-on-customer','escalated','resolved') THEN status ELSE 'requires-review' END AS status,support_version AS version,created_at,COALESCE(support_updated_at,created_at) AS updated_at,CASE WHEN jsonb_typeof(details->'message')='string' THEN details->>'message' ELSE NULL END AS initial_message,CASE WHEN details->>'jobId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN details->>'jobId' ELSE NULL END AS job_id FROM account_requests WHERE workspace_id=$1 AND kind='support' ORDER BY created_at,id")));
    add('data/support-messages.ndjson',source(records('export_support_messages',"SELECT m.id,m.request_id,CASE WHEN m.author_kind='support' THEN 'support' ELSE 'customer' END AS author,m.body,m.created_at FROM support_messages m JOIN account_requests r ON r.id=m.request_id AND r.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND r.kind='support' AND m.visibility='customer' ORDER BY m.created_at,m.id")));
    add('data/notifications.ndjson',source(records('export_notifications','SELECT id,kind,project_id,job_id,request_id,message_id,created_at,read_at FROM notifications WHERE workspace_id=$1 AND recipient_user_id=$2 ORDER BY created_at,id',[ctx.workspaceId,ctx.userId])));
    add('data/email-preferences.ndjson',source(records('export_email_preferences','SELECT enabled,version,updated_at FROM email_preferences WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId])));
    add('data/email-deliveries.ndjson',source(records('export_email_deliveries','SELECT id,notification_id,status,attempts,created_at,updated_at FROM email_outbox WHERE workspace_id=$1 AND recipient_user_id=$2 ORDER BY created_at,id',[ctx.workspaceId,ctx.userId])));
    add('data/product-milestones.ndjson',source(records('export_product_milestones','SELECT milestone,environment,occurred_at FROM product_milestones WHERE workspace_id=$1 ORDER BY occurred_at,milestone')));
    for(const asset of included)add(asset.path!,source(assetContent(asset)));
    // The final entry is emitted only after every mandatory blob has passed its
    // checksum; a failed stream never receives a valid ZIP central directory.
    add('integrity.json',source((async function*(){check();await assertOwner();yield Buffer.from(JSON.stringify({exportId,verifiedAssets:includedAssets,algorithm:'sha256',complete:true}));})()));
    await audit('account.export.started');started=true;check();
    output=new PassThrough({highWaterMark:64*1024});
    output.on('data',chunk=>{totalBytes+=chunk.length;if(totalBytes>limits.archive)stop(new AppError('ACCOUNT_EXPORT_TOO_LARGE','The generated backup exceeded the archive limit.',413));});
    // Do not consume an output stream until the HTTP response/test is ready.
    output.pause();
    zipStream=zip.generateNodeStream({streamFiles:true,compression:'STORE',platform:'UNIX'});
    zipStream.on('error',(error:unknown)=>stop(failure(error)));
    const completion=finished(output).then(()=>check()).then(async()=>{
      finalized=true;clear();await release();await audit('account.export.completed');return {exportId,byteSize:totalBytes,includedAssets};
    },async(error:unknown)=>{
      finalized=true;const safe=failure(controller.signal.aborted?controller.signal.reason:error);stop(safe);clear();await release();await audit(safe.code==='ACCOUNT_EXPORT_CANCELLED'?'account.export.cancelled':'account.export.failed',safe.code).catch(()=>{});throw safe;
    });
    void completion.catch(()=>{});
    poll=setInterval(()=>{
      if(checking||finalized)return;checking=true;
      void assertOwner().catch(error=>stop(failure(error))).finally(()=>{checking=false;});
    },1000);poll.unref();
    zipStream.pipe(output);
    return {stream:output,filename:`appscreen-workspace-${ctx.workspaceId}-${snapshotAt.slice(0,10)}.zip`,contentType:'application/zip',exportId,completion,cancel:()=>{if(!finalized)stop(cancelled());}};
  } catch(error) {
    const safe=failure(controller.signal.aborted?controller.signal.reason:error);stop(safe);clear();await release();
    if(started)await audit('account.export.failed',safe.code).catch(()=>{});
    throw safe;
  }
}
