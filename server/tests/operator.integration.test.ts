import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { loadConfig } from '../config.js';
import { createDatabase, migrate } from '../db.js';
import { createApp } from '../app.js';
import { ALL_SCOPES } from '../auth.js';
import { canOperate } from '../operator.js';

test('operator allowlist cannot be an email, arbitrary role or production development identity',()=>{
  const base={NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:'postgresql://unused/test',APPSCREEN_SIGNING_SECRET:'x'.repeat(48)};
  for(const id of ['owner','staff@example.com','*'])assert.throws(()=>loadConfig({...base,APPSCREEN_OPERATOR_USER_IDS:id}));
  const userId=randomUUID(),config=loadConfig({...base,APPSCREEN_OPERATOR_USER_IDS:userId});
  const ctx:any={userId,workspaceId:randomUUID(),role:'owner',authKind:'web',assuranceLevel:'aal2',scopes:ALL_SCOPES};
  assert.equal(canOperate(config,ctx),true);
  for(const patch of [{authKind:'mcp'},{userId:randomUUID()},{assuranceLevel:'aal1'},{role:'member'},{connection:{kind:'token',id:randomUUID()}}])assert.equal(canOperate(config,{...ctx,...patch}),false);
  assert.equal(canOperate({...config,production:true},{...ctx,authKind:'development'}),false);
});

const databaseUrl=process.env.TEST_DATABASE_URL;
test('restricted operations, verified MFA, privacy and atomic credit corrections',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!);await migrate(db);
  const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:randomUUID(),alg:'RS256'};
  const provider=createServer((req,res)=>{if(req.url==='/auth/v1/.well-known/jwks.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[jwk]}));}else{res.statusCode=404;res.end();}});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(provider.address() as any).port}`;
  const operatorId=randomUUID(),customerId=randomUUID();
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,SUPABASE_URL:url,SUPABASE_PUBLISHABLE_KEY:'isolated-public-key',APP_BASE_URL:'http://127.0.0.1:8001',APPSCREEN_OPERATOR_USER_IDS:operatorId,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APPSCREEN_STORAGE_PATH:await mkdtemp(join(tmpdir(),'appscreen-operator-')),TRIAL_CREDITS:'20'});
  const {app,auth,services}=await createApp(config,db);await app.ready();
  t.after(async()=>{await app.close();await db.end();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));});
  const sign=(user:string,aal='aal1',extra:any={})=>new SignJWT({email:'private@example.test',aal,...extra}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(`${url}/auth/v1`).setAudience('authenticated').setSubject(user).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const staff=await sign(operatorId,'aal2'),weakStaff=await sign(operatorId),customer=await sign(customerId,'aal2');
  const request=(method:any,path:string,token=staff,payload?:any,extraHeaders:any={})=>app.inject({method,url:path,headers:{authorization:`Bearer ${token}`,...extraHeaders},...(payload===undefined?{}:{payload})});
  const checked=async(method:any,path:string,token=staff,payload?:any)=>{const r=await request(method,path,token,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
  const staffSession=await checked('GET','/api/session'),customerSession=await checked('GET','/api/session',customer);
  const workspaceId=customerSession.workspace.id;
  const project=(await checked('POST','/api/projects',customer,{name:'PRIVATE_CAMPAIGN_TITLE'})).project;
  const jobId=randomUUID();
  await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,stage,input,result,error,idempotency_key,request_hash,attempts) VALUES($1,$2,$3,$4,'design','failed','checking_0',$5,$6,$7,$8,'isolated',2)",[jobId,workspaceId,project.id,customerId,{brief:'PRIVATE_PROMPT',asset:'PRIVATE_SIGNED_URL'},{private:'PRIVATE_OUTPUT'},{code:'MODEL_TIMEOUT',message:'PRIVATE_ERROR_MESSAGE'},randomUUID()]);
  await db.query('INSERT INTO job_events(job_id,workspace_id,event) VALUES($1,$2,$3),($1,$2,$4)',[jobId,workspaceId,{stage:'checking_0',private:'PRIVATE_EVENT'},{stage:'PRIVATE_UNTRUSTED_STAGE'}]);
  await db.query('INSERT INTO usage_events(id,workspace_id,job_id,data,reference) VALUES($1,$2,$3,$4,$5)',[randomUUID(),workspaceId,jobId,{stage:'checking_0',input_tokens:100,output_tokens:25,total_tokens:125,responseId:'PRIVATE_RESPONSE_ID',model:'PRIVATE_MODEL'},randomUUID()]);
  await db.query("INSERT INTO credit_reservations(job_id,workspace_id,amount) VALUES($1,$2,5)",[jobId,workspaceId]);
  await db.query("INSERT INTO account_requests(id,workspace_id,user_id,kind,details) VALUES($1,$2,$3,'support',$4)",[randomUUID(),workspaceId,customerId,{message:'PRIVATE_SUPPORT_MESSAGE'}]);

  await t.test('only the allowlisted, second-factor-verified browser session can operate',async()=>{
    assert.equal(staffSession.operator,true);assert.equal(staffSession.operatorMfaRequired,false);assert.equal(customerSession.operator,false);
    const weak=await checked('GET','/api/session',weakStaff);assert.equal(weak.operator,false);assert.equal(weak.operatorMfaRequired,true);
    for(const token of [weakStaff,customer])assert.equal((await request('GET','/api/operator/overview',token,undefined,{'x-operator':'true','x-assurance-level':'aal2'})).statusCode,403);
    const ctx=await auth.resolveContext(operatorId,'',staffSession.workspace.id,'web',[...ALL_SCOPES]);
    const connection=await auth.issueToken(ctx,'Must not become staff',[...ALL_SCOPES]);
    assert.equal((await request('GET','/api/operator/overview',connection.token)).statusCode,403);
    assert.equal((await request('GET','/api/operator/jobs/not-an-id',customer)).statusCode,403);
  });
  await t.test('overview and job responses select only safe operational metadata and record access',async()=>{
    const overview=await checked('GET','/api/operator/overview');assert.ok(overview.jobs.some((j:any)=>j.id===jobId));assert.doesNotMatch(JSON.stringify(overview),/PRIVATE_/);
    const details=await checked('GET',`/api/operator/jobs/${jobId}`);assert.equal(details.job.errorCode,'MODEL_TIMEOUT');assert.equal(details.job.attempts,2);assert.equal(details.job.stage,'checking_0');assert.equal(details.events[1].stage,'other');
    assert.deepEqual(details.usage,[{stage:'checking_0',inputTokens:100,outputTokens:25,totalTokens:125}]);assert.deepEqual(details.reservation,{amount:5,status:'reserved'});assert.doesNotMatch(JSON.stringify(details),/PRIVATE_/);
    const audits=await db.query("SELECT action FROM audit_events WHERE actor_id=$1 AND action LIKE 'operator.%'",[operatorId]);assert.ok(audits.rows.some(a=>a.action==='operator.job.view'));assert.ok(audits.rows.some(a=>a.action==='operator.overview'));
    assert.equal((await request('GET',`/api/operator/jobs/${randomUUID()}`)).statusCode,404);
  });
  const adjustment=(extra:any={})=>({workspaceId,amount:7,reason:'Documented isolated test correction',idempotencyKey:randomUUID(),confirmation:'ADJUST CREDITS',...extra});
  await t.test('confirmation, field validation, origin and staff authorization precede mutation',async()=>{
    const before=await services.credits(workspaceId);
    for(const input of [adjustment({confirmation:'adjust credits'}),adjustment({amount:0}),adjustment({amount:1001}),adjustment({amount:1.2}),adjustment({reason:'short'}),adjustment({unexpected:true})])assert.equal((await request('POST','/api/operator/credits',staff,input)).statusCode,400);
    assert.equal((await request('POST','/api/operator/credits',customer,adjustment())).statusCode,403);
    assert.equal((await request('POST','/api/operator/credits',staff,adjustment(),{origin:'https://untrusted.example'})).statusCode,403);
    assert.equal((await request('POST','/api/operator/credits',staff,adjustment({workspaceId:randomUUID()}))).statusCode,404);
    assert.deepEqual(await services.credits(workspaceId),before);
  });
  await t.test('same-key concurrent retries produce one atomic ledger entry, audit and receipt',async()=>{
    const input=adjustment();const before=await services.credits(workspaceId);
    // Call the shared service for the burst so transport rate limiting remains a
    // separate test rather than hiding the database concurrency invariant.
    const ctx:any={...await auth.resolveContext(operatorId,'',staffSession.workspace.id,'web',[...ALL_SCOPES]),assuranceLevel:'aal2'};
    const {Operations}=await import('../operator.js');const operations=new Operations(services);
    const results=await Promise.all(Array.from({length:8},()=>operations.adjustCredits(ctx,input)));
    for(const result of results)assert.deepEqual(result,results[0]);const receipt=results[0].receipt;
    assert.equal((await services.credits(workspaceId)).available,before.available+7);assert.equal(receipt.workspaceId,workspaceId);assert.equal(receipt.amount,7);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM audit_events WHERE action='operator.credit-adjustment' AND target_id=$1",[receipt.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM credit_ledger WHERE id=$1',[receipt.id])).rows[0].n,1);
    const replay=await checked('POST','/api/operator/credits',staff,input);assert.deepEqual(replay,results[0]);
    assert.equal((await request('POST','/api/operator/credits',staff,{...input,amount:8})).statusCode,409);
    assert.equal((await db.query('SELECT plan_id FROM subscriptions WHERE workspace_id=$1',[workspaceId])).rows[0].plan_id,'trial');
  });
  await t.test('debits cannot spend reserved credits and audit/storage failures roll back the correction',async()=>{
    const before=await services.credits(workspaceId);
    const rejected=await request('POST','/api/operator/credits',staff,adjustment({amount:-(before.available+1)}));assert.equal(rejected.statusCode,409);assert.equal(rejected.json().error.code,'CREDIT_ADJUSTMENT_RESERVED');
    const original=services.storeReceipt;services.storeReceipt=async()=>{throw new Error('INTERNAL_ISOLATED_FAILURE');};
    try{const failed=await request('POST','/api/operator/credits',staff,adjustment());assert.equal(failed.statusCode,500);assert.doesNotMatch(failed.body,/INTERNAL_ISOLATED_FAILURE/);}finally{services.storeReceipt=original;}
    assert.deepEqual(await services.credits(workspaceId),before);
    const debit=await checked('POST','/api/operator/credits',staff,adjustment({amount:-3}));assert.equal(debit.receipt.amount,-3);assert.equal((await services.credits(workspaceId)).available,before.available-3);
  });
  await t.test('revoking the operator membership blocks further access',async()=>{
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[staffSession.workspace.id,operatorId]);
    assert.equal((await request('GET','/api/operator/overview')).statusCode,403);
  });
});
