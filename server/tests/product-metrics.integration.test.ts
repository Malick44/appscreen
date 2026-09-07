import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { createDatabase,migrate,transaction } from '../db.js';
import { loadConfig } from '../config.js';
import { ALL_SCOPES,hash } from '../auth.js';
import { ProductMetrics,recordMilestone } from '../product-metrics.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('content-free milestones, aggregate report and operational signals',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!);await migrate(db);
  const staffEmail=`metrics-staff-${randomUUID()}@example.test`,staffId=`dev:${hash(staffEmail)}`;
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',APPSCREEN_OPERATOR_USER_IDS:staffId,DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APPSCREEN_STORAGE_PATH:await mkdtemp(join(tmpdir(),'appscreen-metrics-')),APP_BASE_URL:'http://localhost'});
  const {app,services,auth}=await createApp(config,db);await app.ready();
  t.after(async()=>{await app.close();await db.end();});
  const account=async(email=`metrics-customer-${randomUUID()}@example.test`)=>{
    const {token}=await auth.developmentSession(email);const ctx=await auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',[...ALL_SCOPES]);return {token,ctx};
  };
  const staff=await account(staffEmail),customer=await account();
  const query=(token:string,url='/api/operator/report?days=30')=>app.inject({url,headers:{authorization:`Bearer ${token}`}});
  const milestones=async(workspaceId:string)=>(await db.query('SELECT milestone,occurred_at FROM product_milestones WHERE workspace_id=$1 ORDER BY milestone',[workspaceId])).rows;

  await t.test('new workspace signup is recorded once, never on repeated sign-in',async()=>{
    const before=await milestones(customer.ctx.workspaceId);assert.deepEqual(before.map(x=>x.milestone),['signup']);
    await auth.developmentSession(customer.ctx.email);assert.deepEqual(await milestones(customer.ctx.workspaceId),before);
    const fields=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='product_milestones' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
    assert.deepEqual(fields,['workspace_id','milestone','environment','occurred_at']);
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='product_milestones'::regclass")).rows[0].relrowsecurity,true);
  });
  await t.test('validated stored originals count; rejected uploads and tickets do not',async()=>{
    const own=await account(),project=(await services.createProject(own.ctx,{name:'PRIVATE_CAMPAIGN'})).project;
    await assert.rejects(services.uploadAsset(own.ctx,project.id,'PRIVATE_FILENAME',Buffer.from('not an image')));
    await services.requestAssetUpload(own.ctx,{projectId:project.id,filename:'PRIVATE_TICKET.png'});
    assert.deepEqual((await milestones(own.ctx.workspaceId)).map(x=>x.milestone),['signup']);
    const bytes=await sharp({create:{width:40,height:80,channels:3,background:'#333333'}}).png().toBuffer();
    await services.uploadAsset(own.ctx,project.id,'PRIVATE_SOURCE.png',bytes);
    await services.uploadAsset(own.ctx,project.id,'PRIVATE_SOURCE2.png',bytes);
    assert.deepEqual((await milestones(own.ctx.workspaceId)).map(x=>x.milestone),['first_upload','signup']);
  });
  await t.test('job milestone commits are attempt-fenced, repeated once and distinguish review/export',async()=>{
    const own=await account(),project=(await services.createProject(own.ctx,{name:'PRIVATE_PROJECT'})).project;
    const job=async(kind='export',format='zip')=>{
      const id=randomUUID();await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,attempts,idempotency_key,request_hash) VALUES($1::uuid,$2,$3,$4,$5,'running','rendering',$6,1,$1::text,$1::text)",[id,own.ctx.workspaceId,project.id,own.ctx.userId,kind,{format}]);
      await db.query('INSERT INTO credit_reservations(job_id,workspace_id,amount) VALUES($1,$2,0)',[id,own.ctx.workspaceId]);return id;
    };
    const render=await job('render','preview');
    const result={previews:[{assetId:randomUUID()}],artifacts:[{assetId:randomUUID()}]};
    assert.equal(await services.finishJob(render,{status:'ready',success:true,result,expectedAttempt:0}),false);
    assert.deepEqual((await milestones(own.ctx.workspaceId)).map(x=>x.milestone),['signup']);
    const warning=await job();await services.finishJob(warning,{status:'needs-input',success:true,result,expectedAttempt:1});
    assert.deepEqual((await milestones(own.ctx.workspaceId)).map(x=>x.milestone),['first_export','signup']);
    await services.finishJob(render,{status:'ready',success:true,result,expectedAttempt:1});
    const recorded=await milestones(own.ctx.workspaceId);assert.deepEqual(recorded.map(x=>x.milestone),['first_campaign','first_export','signup']);
    await services.finishJob(render,{status:'failed',success:false,expectedAttempt:1});assert.deepEqual(await milestones(own.ctx.workspaceId),recorded);
  });
  await t.test('milestones roll back with the source transaction and deduplicate concurrent writes',async()=>{
    const own=await account();
    await assert.rejects(transaction(db,async client=>{await recordMilestone(client,config,own.ctx.workspaceId,'first_upload');throw new Error('isolated rollback');}),/isolated rollback/);
    assert.deepEqual((await milestones(own.ctx.workspaceId)).map(x=>x.milestone),['signup']);
    await Promise.all(Array.from({length:5},()=>transaction(db,client=>recordMilestone(client,config,own.ctx.workspaceId,'first_upload'))));
    assert.equal((await milestones(own.ctx.workspaceId)).filter(x=>x.milestone==='first_upload').length,1);
    await assert.rejects(transaction(db,client=>recordMilestone(client,config,own.ctx.workspaceId,'PRIVATE_PROMPT' as any)));
  });
  await t.test('report is staff-only, safe and auditable with bounded input',async()=>{
    assert.equal((await query(customer.token)).statusCode,403);
    const token=await auth.issueToken(staff.ctx,'No reports over MCP',[...ALL_SCOPES]);
    assert.equal((await query(token.token)).statusCode,403);
    for(const value of ['0','91','100000','abc'])assert.equal((await query(staff.token,`/api/operator/report?days=${value}`)).statusCode,400);
    assert.equal((await query(staff.token,'/api/operator/report?days=30&workspaceId=private')).statusCode,400);
    const response=await query(staff.token);assert.equal(response.statusCode,200,response.body);const report=response.json();
    assert.equal(report.environment,'nonproduction');assert.equal(report.window.days,30);assert.ok(report.captureStartedAt);assert.ok(report.cohort.signups>=1);
    assert.doesNotMatch(response.body,/PRIVATE_|@example|storageKey|responseId|billingEventId/);
    assert.ok((await db.query("SELECT 1 FROM audit_events WHERE workspace_id=$1 AND action='operator.report.view'",[staff.ctx.workspaceId])).rowCount);
  });
  await t.test('cohort bounds and environment isolation exclude older, future and other-environment milestones',async()=>{
    // A controlled future clock isolates this cohort from other parallel suites.
    const report=new ProductMetrics(services,()=>new Date('2042-06-30T12:00:00Z'));
    const baseline=(await report.report(staff.ctx,{days:7})).cohort;
    for(const [stamp,environment,event] of [
      ['2042-06-28T12:00:00Z','nonproduction','first_upload'],
      ['2042-06-01T12:00:00Z','nonproduction','first_campaign'],
      ['2042-07-01T12:00:00Z','nonproduction','first_export'],
      ['2042-06-28T12:00:00Z','production','paid_conversion'],
    ]) {
      const own=await account();
      await db.query('UPDATE product_milestones SET occurred_at=$2,environment=$3 WHERE workspace_id=$1',[own.ctx.workspaceId,stamp,environment]);
      await db.query('INSERT INTO product_milestones(workspace_id,milestone,environment,occurred_at) VALUES($1,$2,$3,$4)',[own.ctx.workspaceId,event,environment,stamp]);
    }
    const after=(await report.report(staff.ctx,{days:7})).cohort;
    assert.equal(after.signups-baseline.signups,1);assert.equal(after.firstUpload-baseline.firstUpload,1);
    for(const key of ['firstCampaign','firstExport','paidConversion'])assert.equal(after[key],baseline[key]);
  });
  await t.test('safe operational alerts derive from actual unresolved state and usage rejects malformed counts',async()=>{
    const own=await account(),project=(await services.createProject(own.ctx,{name:'PRIVATE_ALERT_PROJECT'})).project,id=randomUUID();
    await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,heartbeat_at,idempotency_key,request_hash) VALUES($1::uuid,$2,$3,$4,'design','running','PRIVATE_STAGE',$5,now()-interval '10 minutes',$1::text,$1::text)",[id,own.ctx.workspaceId,project.id,own.ctx.userId,{prompt:'PRIVATE_PROMPT'}]);
    await db.query('INSERT INTO usage_events(id,workspace_id,job_id,data,reference) VALUES($1::uuid,$2,$3,$4,$1::text)',[randomUUID(),own.ctx.workspaceId,id,{input_tokens:'PRIVATE_TOKEN',output_tokens:-4,responseId:'PRIVATE_PROVIDER'}]);
    const report=await new ProductMetrics(services).report(staff.ctx);assert.ok(report.alerts.some(x=>x.code==='WORKER_HEARTBEAT_STALE'&&x.count>=1));assert.ok(report.activity.unmeteredUsageEvents>=1);assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
    await db.query("UPDATE agent_jobs SET status='ready' WHERE id=$1",[id]);
    // The individual stale job no longer meets the live alert predicate.
    assert.equal((await db.query("SELECT 1 FROM agent_jobs WHERE id=$1 AND status='running'",[id])).rowCount,0);
  });
  await t.test('revoked or demoted staff cannot obtain reports',async()=>{
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[staff.ctx.workspaceId,staff.ctx.userId]);
    assert.equal((await query(staff.token)).statusCode,403);
  });
});
