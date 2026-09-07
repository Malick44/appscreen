import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { hash, ALL_SCOPES, type Context } from '../auth.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('account lifecycle Fastify route boundary',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!),directory=await mkdtemp(join(tmpdir(),'appscreen-lifecycle-route-test-'));
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APP_BASE_URL:'http://localhost',APPSCREEN_STORAGE_PATH:directory,APPSCREEN_ENABLE_AI:'false'});
  let application:Awaited<ReturnType<typeof createApp>>;
  t.after(async()=>{await application?.app.close();await db.end();});await migrate(db);application=await createApp(config,db);
  const {app,auth,services}=application;await app.ready();
  const run=randomUUID();
  const login=async(label:string)=>{const email=`lifecycle-route-${label}-${run}@integration.appscreen.test`,{token}=await auth.developmentSession(email),ctx=await auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',[...ALL_SCOPES]);return {token,ctx};};
  const owner=await login('owner'),stranger=await login('stranger'),member=await login('member');
  const send=(method:'GET'|'POST',path:string,token?:string,payload?:any,origin?:string)=>app.inject({method,url:path,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),...(origin?{origin}:{})},...(payload===undefined?{}:{payload})});
  const ok=async(method:'GET'|'POST',path:string,token:string,payload?:any)=>{const response=await send(method,path,token,payload,'http://localhost');assert.equal(response.statusCode,200,response.body);return response.json();};
  const deletion='/api/account/deletion-request',cancellation=`${deletion}/cancel`;

  await t.test('GET/request/cancel and old retry preserve the newer pending request through real routes',async()=>{
    assert.equal((await ok('GET',deletion,owner.token)).status,'none');
    const input={confirmation:'DELETE',idempotencyKey:randomUUID()},first=await ok('POST',deletion,owner.token,input),again=await ok('POST',deletion,owner.token,input);
    assert.equal(first.status,'pending');assert.equal(first.requestId,again.requestId);assert.equal(again.replayed,true);assert.equal(first.fulfillment.automaticDeletion,false);
    const cancelInput={requestId:first.requestId,confirmation:'KEEP DATA',idempotencyKey:randomUUID()};
    const cancelled=await ok('POST',cancellation,owner.token,cancelInput);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.pendingCount,0);
    const newer=await ok('POST',deletion,owner.token,{confirmation:'DELETE',idempotencyKey:randomUUID()});
    const replay=await ok('POST',cancellation,owner.token,cancelInput);assert.equal(replay.replayed,true);assert.equal(replay.activeRequest.requestId,newer.requestId);assert.equal(replay.activeRequest.status,'pending');assert.equal(replay.pendingCount,1);
    const status=await ok('GET',deletion,owner.token);assert.equal(status.requestId,newer.requestId);assert.equal(status.status,'pending');
    assert.equal((await send('POST',cancellation,stranger.token,{...cancelInput,idempotencyKey:randomUUID()})).statusCode,404);
  });

  await t.test('HTTP bodies require exact typed confirmation, a retry key, and same-origin writes',async()=>{
    for(const payload of [{},{confirmation:'DELETE'},{confirmation:'delete',idempotencyKey:randomUUID()},{confirmation:'DELETE',idempotencyKey:randomUUID(),eraseImmediately:true}]) {
      const response=await send('POST',deletion,stranger.token,payload);assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'INVALID_INPUT');
    }
    const active=(await ok('GET',deletion,owner.token)).activeRequest;
    for(const payload of [{requestId:active.requestId,confirmation:'DELETE',idempotencyKey:randomUUID()},{requestId:active.requestId,confirmation:'KEEP DATA'}])assert.equal((await send('POST',cancellation,owner.token,payload)).statusCode,400);
    for(const path of [deletion,cancellation]) {
      const response=await send('POST',path,owner.token,path===deletion?{confirmation:'DELETE',idempotencyKey:randomUUID()}:{requestId:active.requestId,confirmation:'KEEP DATA',idempotencyKey:randomUUID()},'https://untrusted.example');
      assert.equal(response.statusCode,403);assert.equal(response.json().error.code,'ORIGIN_FORBIDDEN');
    }
    assert.equal((await ok('GET',deletion,stranger.token)).status,'none');assert.equal((await ok('GET',deletion,owner.token)).pendingCount,1);
  });

  await t.test('anonymous, member, MCP and revoked sessions cannot manage deletion',async()=>{
    assert.equal((await send('GET',deletion)).statusCode,401);
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[member.ctx.workspaceId,member.ctx.userId]);
    const connection=await auth.issueToken(owner.ctx,'Account-management denied',['projects:read','projects:write']);
    for(const token of [member.token,connection.token]) {
      assert.equal((await send('GET',deletion,token)).statusCode,403);
      assert.equal((await send('POST',deletion,token,{confirmation:'DELETE',idempotencyKey:randomUUID()})).statusCode,403);
      assert.equal((await send('POST',cancellation,token,{requestId:randomUUID(),confirmation:'KEEP DATA',idempotencyKey:randomUUID()})).statusCode,403);
    }
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[member.ctx.workspaceId,member.ctx.userId]);
    const revoked=await send('GET',deletion,member.token);assert.equal(revoked.statusCode,403);assert.equal(revoked.json().error.code,'WORKSPACE_FORBIDDEN');
  });

  await t.test('support route accepts only active browser members and workspace-owned job references',async()=>{
    const makeJob=async(ctx:Context)=>{const p=(await services.createProject(ctx,{name:'Support route campaign'})).project,id=randomUUID();await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,input,idempotency_key,request_hash) VALUES($1,$2,$3,$4,'design','{}',$5,$6)",[id,ctx.workspaceId,p.id,ctx.userId,randomUUID(),hash(id)]);return id;};
    const ownJob=await makeJob(owner.ctx),foreignJob=await makeJob(stranger.ctx);
    const foreign=await send('POST','/api/support',owner.token,{message:'Please investigate this job safely.',jobId:foreignJob});assert.equal(foreign.statusCode,404);assert.equal(foreign.json().error.code,'JOB_NOT_FOUND');
    const input={message:'Please investigate the job in my workspace.',jobId:ownJob,idempotencyKey:randomUUID()};
    const first=await ok('POST','/api/support',owner.token,input),again=await ok('POST','/api/support',owner.token,input);assert.equal(first.status,'received');assert.equal(first.requestId,again.requestId);assert.equal(again.replayed,true);
    assert.equal((await send('POST','/api/support',owner.token,{...input,message:'A different support message cannot reuse its key.'})).statusCode,409);
    const connection=await auth.issueToken(owner.ctx,'Support denied',['projects:read']);
    assert.equal((await send('POST','/api/support',connection.token,{message:'Agent tokens cannot impersonate support requests.'})).statusCode,403);
    assert.equal((await send('POST','/api/support',member.token,{message:'Revoked members cannot open support requests.'})).statusCode,403);
  });
});
