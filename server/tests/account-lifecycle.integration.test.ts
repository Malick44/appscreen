import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { createAuth, hash, ALL_SCOPES, type Context } from '../auth.js';
import { AccountLifecycle } from '../account-lifecycle.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const key=()=>randomUUID();
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

test('owner-only account request lifecycle with real transactions, receipts and audits',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/,'Only a dedicated test database may be used');
  const db=createDatabase(databaseUrl!);
  const directory=await mkdtemp(join(tmpdir(),'appscreen-lifecycle-test-'));
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APP_BASE_URL:'http://localhost',APPSCREEN_STORAGE_PATH:directory,APPSCREEN_ENABLE_AI:'false',TRIAL_CREDITS:'5'});
  const services=new AppServices(db,config,createStorage(config)),auth=createAuth(db,config),lifecycle=new AccountLifecycle(services);
  t.after(()=>db.end());await migrate(db);
  const run=randomUUID();
  const owner=async(label:string)=>{const email=`lifecycle-${label}-${run}@integration.appscreen.test`;await auth.developmentSession(email);return auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',[...ALL_SCOPES]);};
  const request=(ctx:Context,idempotencyKey=key())=>lifecycle.requestDeletion(ctx,{confirmation:'DELETE',idempotencyKey});
  const cancel=(ctx:Context,requestId:string,idempotencyKey=key())=>lifecycle.cancelDeletion(ctx,{requestId,confirmation:'KEEP DATA',idempotencyKey});
  const rows=async(ctx:Context)=>(await db.query("SELECT * FROM account_requests WHERE workspace_id=$1 AND kind='deletion' ORDER BY created_at,id",[ctx.workspaceId])).rows;
  const audits=async(ctx:Context)=>(await db.query("SELECT action,target_id,metadata FROM audit_events WHERE workspace_id=$1 AND action LIKE 'account.deletion%' ORDER BY action,target_id",[ctx.workspaceId])).rows;
  const legacy=async(ctx:Context,status='pending',details:any={confirmation:null})=>{const id=randomUUID();await db.query("INSERT INTO account_requests(id,workspace_id,user_id,kind,status,details) VALUES($1,$2,$3,'deletion',$4,$5)",[id,ctx.workspaceId,ctx.userId,status,details]);return id;};
  const job=async(ctx:Context)=>{const p=(await services.createProject(ctx,{name:'Support job campaign'})).project,id=randomUUID();await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,input,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'design','{}',$5,$6)",[id,ctx.workspaceId,p.id,ctx.userId,key(),hash(id)]);return id;};

  await t.test('new request records exact confirmation, pending status, safe timestamps and atomic audit',async()=>{
    const ctx=await owner('request');const empty=await lifecycle.deletionStatus(ctx);assert.equal(empty.status,'none');assert.equal(empty.pendingCount,0);assert.equal(empty.request,null);
    const result=await request(ctx);assert.equal(result.status,'pending');assert.equal(result.pendingCount,1);assert.equal(result.request!.confirmationVerified,true);assert.equal(result.request!.legacy,false);assert.equal(result.request!.canCancel,true);
    assert.ok(result.request!.requestedAt);assert.equal(result.request!.updatedAt,result.request!.requestedAt);assert.equal(result.request!.cancelledAt,null);
    assert.deepEqual(result.fulfillment,{configured:false,automaticDeletion:false,billingCancellation:false});assert.match(result.message,/has not been deleted/);assert.match(result.message,/manual setup/);
    const stored=await rows(ctx);assert.equal(stored.length,1);assert.deepEqual(stored[0].details,{lifecycleVersion:2,confirmation:'DELETE'});
    assert.equal((await audits(ctx)).length,1);assert.equal((await audits(ctx))[0].action,'account.deletion-request');
  });

  await t.test('missing or incorrect confirmation and idempotency key never admit a deletion request',async()=>{
    const ctx=await owner('confirmation');
    for(const payload of [{},{confirmation:'delete',idempotencyKey:key()},{confirmation:' DELETE ',idempotencyKey:key()},{confirmation:'DELETE'},{confirmation:'DELETE',idempotencyKey:'short'},{confirmation:'DELETE',idempotencyKey:key(),eraseNow:true}])await assert.rejects(lifecycle.requestDeletion(ctx,payload));
    assert.equal((await rows(ctx)).length,0);assert.equal((await audits(ctx)).length,0);
  });

  await t.test('concurrent requests and distinct retry keys coalesce to one pending request',async()=>{
    const ctx=await owner('concurrent'),results=await Promise.all(Array.from({length:5},()=>request(ctx)));
    assert.equal(new Set(results.map(result=>result.requestId)).size,1);assert.equal((await rows(ctx)).length,1);assert.equal((await audits(ctx)).length,1);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM write_receipts WHERE workspace_id=$1 AND action='account.request-deletion'",[ctx.workspaceId])).rows[0].count,5);
  });

  await t.test('same-key request replay returns the same identity without a new audit or pending request',async()=>{
    const ctx=await owner('replay'),idempotencyKey=key();const first=await request(ctx,idempotencyKey),again=await request(ctx,idempotencyKey);
    assert.equal(first.requestId,again.requestId);assert.equal(again.replayed,true);assert.equal(again.status,'pending');assert.equal((await audits(ctx)).length,1);
    await cancel(ctx,first.requestId!);
    const afterCancellation=await request(ctx,idempotencyKey);assert.equal(afterCancellation.requestId,first.requestId);assert.equal(afterCancellation.status,'cancelled');assert.equal(afterCancellation.pendingCount,0);
    assert.equal((await rows(ctx)).length,1,'a delayed retry must not reopen a cancelled request');
  });

  await t.test('KEEP DATA cancels all pending legacy duplicates but neither support cases nor data',async()=>{
    const ctx=await owner('legacy'),one=await legacy(ctx),two=await legacy(ctx,'pending',{confirmation:'wrong',privateOperationalField:'must-not-be-returned'});
    const support=await lifecycle.requestSupport(ctx,{message:'Please help me understand this campaign.'});
    const before=await lifecycle.deletionStatus(ctx);assert.equal(before.pendingCount,2);assert.ok(before.requests.every(item=>item?.legacy));assert.equal(JSON.stringify(before).includes('must-not-be-returned'),false);
    const reused=await request(ctx);assert.equal(reused.reusedPendingRequest,true);assert.equal((await rows(ctx)).length,2);
    const cancelled=await cancel(ctx,one);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.pendingCount,0);assert.equal(cancelled.activeRequest,null);assert.deepEqual(new Set(cancelled.cancelledRequestIds),new Set([one,two]));
    assert.ok(cancelled.request!.cancelledAt);assert.equal(cancelled.request!.legacy,true);assert.equal(cancelled.request!.canCancel,false);assert.match(cancelled.message,/data is being kept/);
    assert.ok((await rows(ctx)).every(item=>item.status==='cancelled'));
    assert.equal((await db.query('SELECT status FROM account_requests WHERE id=$1',[support.requestId])).rows[0].status,'pending');
    assert.equal((await audits(ctx)).length,1);assert.equal((await audits(ctx))[0].action,'account.deletion-cancel');
  });

  await t.test('cancellation confirmation is strict and foreign/support request IDs cannot be used',async()=>{
    const ctx=await owner('cancel-validation'),foreign=await owner('cancel-other'),own=await request(ctx),other=await request(foreign);
    for(const payload of [{requestId:own.requestId,confirmation:'DELETE',idempotencyKey:key()},{requestId:own.requestId,confirmation:'KEEP DATA'},{requestId:own.requestId,confirmation:'keep data',idempotencyKey:key()}])await assert.rejects(lifecycle.cancelDeletion(ctx,payload));
    await assert.rejects(cancel(ctx,other.requestId!),{code:'DELETION_REQUEST_NOT_FOUND'});
    const support=await lifecycle.requestSupport(ctx,{message:'A support request is not a deletion request.'});await assert.rejects(cancel(ctx,support.requestId),{code:'DELETION_REQUEST_NOT_FOUND'});
    assert.equal((await lifecycle.deletionStatus(ctx)).pendingCount,1);assert.equal((await lifecycle.deletionStatus(foreign)).pendingCount,1);
  });

  await t.test('replayed cancellation cannot touch a later new deletion request',async()=>{
    const ctx=await owner('cancel-replay'),first=await request(ctx),idempotencyKey=key();
    const cancelled=await cancel(ctx,first.requestId!,idempotencyKey);const next=await request(ctx);
    const replay=await cancel(ctx,first.requestId!,idempotencyKey);assert.equal(replay.replayed,true);assert.deepEqual(replay.cancelledRequestIds,cancelled.cancelledRequestIds);assert.equal(replay.activeRequest!.requestId,next.requestId);assert.equal(replay.pendingCount,1);
    assert.equal((await db.query('SELECT status FROM account_requests WHERE id=$1',[next.requestId])).rows[0].status,'pending');
    await assert.rejects(cancel(ctx,next.requestId!,idempotencyKey),{code:'IDEMPOTENCY_CONFLICT'});
    const oldWithNewKey=await cancel(ctx,first.requestId!);assert.equal(oldWithNewKey.pendingCount,1);assert.deepEqual(oldWithNewKey.cancelledRequestIds,[]);
    assert.equal((await audits(ctx)).filter(item=>item.action==='account.deletion-cancel').length,1);
  });

  await t.test('parallel cancellation requests produce one state change and one audit',async()=>{
    const ctx=await owner('parallel-cancel'),pending=await request(ctx);
    const results=await Promise.all(Array.from({length:4},()=>cancel(ctx,pending.requestId!)));
    assert.ok(results.every(result=>result.status==='cancelled'&&result.pendingCount===0));
    assert.equal((await audits(ctx)).filter(item=>item.action==='account.deletion-cancel').length,1);
  });

  await t.test('request, audit and receipt roll back together after a database-step failure',async()=>{
    const ctx=await owner('rollback'),idempotencyKey=key(),original=services.storeReceipt.bind(services);let fail=true;
    services.storeReceipt=async(...args:any[])=>{if(fail){fail=false;throw new Error('Simulated failed commit step');}return (original as any)(...args);};
    try{await assert.rejects(request(ctx,idempotencyKey),/failed commit step/);}finally{services.storeReceipt=original;}
    assert.equal((await rows(ctx)).length,0);assert.equal((await audits(ctx)).length,0);
    assert.equal((await db.query('SELECT * FROM write_receipts WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
    await request(ctx,idempotencyKey);assert.equal((await rows(ctx)).length,1);assert.equal((await audits(ctx)).length,1);
  });

  await t.test('cancellation, audit and receipt roll back together on failure',async()=>{
    const ctx=await owner('cancel-rollback'),pending=await request(ctx),idempotencyKey=key(),original=services.storeReceipt.bind(services);
    services.storeReceipt=async()=>{throw new Error('Simulated cancellation commit failure');};
    try{await assert.rejects(cancel(ctx,pending.requestId!,idempotencyKey),/commit failure/);}finally{services.storeReceipt=original;}
    assert.equal((await lifecycle.deletionStatus(ctx)).pendingCount,1);assert.equal((await audits(ctx)).length,1);
    await cancel(ctx,pending.requestId!,idempotencyKey);assert.equal((await lifecycle.deletionStatus(ctx)).pendingCount,0);assert.equal((await audits(ctx)).length,2);
  });

  await t.test('stale role, revoked membership, MCP and another workspace all fail closed',async()=>{
    const ctx=await owner('authority'),other=await owner('authority-other');
    for(const invalid of [{...ctx,authKind:'mcp' as const},{...ctx,role:'member'},{...ctx,workspaceId:other.workspaceId}]) {
      await assert.rejects(request(invalid));await assert.rejects(lifecycle.deletionStatus(invalid));await assert.rejects(cancel(invalid,randomUUID()));
    }
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);await assert.rejects(request(ctx),{code:'OWNER_REQUIRED'});
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);await assert.rejects(request(ctx),{code:'WORKSPACE_FORBIDDEN'});
    assert.equal((await rows(ctx)).length,0);
  });

  await t.test('membership is held through commit so revocation cannot race the admitted write',async()=>{
    const ctx=await owner('membership-lock'),entered=gate(),resume=gate(),original=services.storeReceipt.bind(services);
    services.storeReceipt=async(...args:any[])=>{entered.resolve();await resume.promise;return (original as any)(...args);};
    const requesting=request(ctx);await entered.promise;let revoked=false;
    const revocation=db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]).then(()=>{revoked=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(revoked,false);
    resume.resolve();try{await requesting;await revocation;}finally{services.storeReceipt=original;}
    assert.equal((await rows(ctx)).length,1);await assert.rejects(lifecycle.deletionStatus(ctx),{code:'WORKSPACE_FORBIDDEN'});
  });

  await t.test('unexpected legacy completion labels require review and never claim verified erasure',async()=>{
    const ctx=await owner('unknown-status'),id=await legacy(ctx,'completed');
    const result=await lifecycle.deletionStatus(ctx);assert.equal(result.status,'requires-review');assert.equal(result.reviewRequiredCount,1);assert.equal(result.request!.canCancel,false);assert.equal(result.fulfillment.automaticDeletion,false);assert.match(result.message,/cannot confirm/);
    await assert.rejects(request(ctx),{code:'DELETION_REVIEW_REQUIRED'});await assert.rejects(cancel(ctx,id),{code:'DELETION_REVIEW_REQUIRED'});
    assert.equal((await rows(ctx)).length,1);assert.equal((await rows(ctx))[0].status,'completed','the lifecycle must not invent a new historical state');
  });

  await t.test('support requires active browser membership and a job in that workspace',async()=>{
    const ctx=await owner('support'),foreign=await owner('support-other'),ownJob=await job(ctx),foreignJob=await job(foreign);
    await assert.rejects(lifecycle.requestSupport({...ctx,authKind:'mcp'},{message:'Agent may not open owner support requests.'}),{code:'BROWSER_SESSION_REQUIRED'});
    await assert.rejects(lifecycle.requestSupport(ctx,{message:'Wrong workspace job must not be accepted.',jobId:foreignJob}),{code:'JOB_NOT_FOUND'});
    await assert.rejects(lifecycle.requestSupport(ctx,{message:'Short'}));await assert.rejects(lifecycle.requestSupport(ctx,{message:'Valid message but an extra privileged field.',operator:true}));
    const result=await lifecycle.requestSupport(ctx,{message:'Please inspect the failed job in this workspace.',jobId:ownJob});assert.equal(result.status,'received');assert.equal(result.caseStatus,'pending');assert.ok(result.createdAt);
    const stored=(await db.query('SELECT * FROM account_requests WHERE id=$1',[result.requestId])).rows[0];assert.equal(stored.workspace_id,ctx.workspaceId);assert.equal(stored.details.jobId,ownJob);
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);assert.equal((await lifecycle.requestSupport({...ctx,role:'member'},{message:'Active members may request support too.'})).status,'received');
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);await assert.rejects(lifecycle.requestSupport(ctx,{message:'A revoked member may not request support.'}),{code:'WORKSPACE_FORBIDDEN'});
  });

  await t.test('support retry keys deduplicate message and audit, with changed-payload conflicts',async()=>{
    const ctx=await owner('support-replay'),idempotencyKey=key(),args={message:'Please help me with the campaign editor.',idempotencyKey};
    const one=await lifecycle.requestSupport(ctx,args),again=await lifecycle.requestSupport(ctx,args);assert.equal(one.requestId,again.requestId);assert.equal(again.replayed,true);
    await assert.rejects(lifecycle.requestSupport(ctx,{...args,message:'This is a different request with the same key.'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal((await db.query("SELECT * FROM account_requests WHERE workspace_id=$1 AND kind='support'",[ctx.workspaceId])).rowCount,1);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE workspace_id=$1 AND action='account.support-request'",[ctx.workspaceId])).rowCount,1);
  });

  await t.test('request and cancellation never erase projects/assets, change credits, or alter billing',async()=>{
    const ctx=await owner('no-erasure'),p=(await services.createProject(ctx,{name:'Keep this original project'})).project;
    const bytes=await sharp({create:{width:128,height:256,channels:4,background:'#bfdcef'}}).png().toBuffer();
    const asset=(await services.uploadAsset(ctx,p.id,'original.png',bytes)).asset;
    await db.query("UPDATE subscriptions SET status='active',plan_id='pro' WHERE workspace_id=$1",[ctx.workspaceId]);
    const before=(await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],credits=await services.credits(ctx.workspaceId);
    const pending=await request(ctx);await cancel(ctx,pending.requestId!);
    assert.equal((await services.project(ctx,p.id)).name,'Keep this original project');
    assert.deepEqual(await services.storage.read((await services.asset(ctx,asset.id)).storageKey),bytes);
    assert.deepEqual((await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],before);assert.deepEqual(await services.credits(ctx.workspaceId),credits);
  });
});
