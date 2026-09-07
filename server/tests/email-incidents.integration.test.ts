import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { Webhook } from 'svix';
import { createDatabase,verifyMigrations } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { EmailIncidents } from '../email-incidents.js';
import { recipientHash } from '../email.js';
import { ALL_SCOPES,type Context } from '../auth.js';
import { emailHealth } from '../../deploy/email-health.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('staff email review preserves delivery truth with isolated PostgreSQL and signed local identities',{skip:!databaseUrl,timeout:60_000},async t=>{
  const target=new URL(databaseUrl!);assert.match(target.pathname,/(?:^|[_/-])test(?:[_/-]|$)/);assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  const db=createDatabase(databaseUrl!);t.after(()=>db.end());await verifyMigrations(db);
  const {publicKey,privateKey}=await generateKeyPair('RS256'),kid=randomUUID();
  const jwk={...await exportJWK(publicKey),kid,alg:'RS256'};
  const identity=createServer((req,res)=>{if(req.url==='/auth/v1/.well-known/jwks.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[jwk]}));}else{res.statusCode=404;res.end();}});
  await new Promise<void>(resolve=>identity.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{identity.closeAllConnections();await new Promise<void>(resolve=>identity.close(()=>resolve()));});
  const origin=`http://127.0.0.1:${(identity.address() as any).port}`;
  const originalFetch=globalThis.fetch;let externalCalls=0;
  globalThis.fetch=async(input,options)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(new URL(url).origin!==origin){externalCalls++;throw new Error('External network forbidden in fixture');}return originalFetch(input,options);};
  t.after(()=>{globalThis.fetch=originalFetch;assert.equal(externalCalls,0);});
  const operatorId=randomUUID(),customerId=randomUUID(),secret=`whsec_${randomBytes(32).toString('base64')}`;
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'synthetic-public-key',APP_BASE_URL:'http://127.0.0.1:8001',APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APPSCREEN_OPERATOR_USER_IDS:operatorId,RESEND_WEBHOOK_SECRET:secret});
  assert.equal(config.emailEnabled,false);assert.equal(config.allowLiveAI,false);assert.equal(config.enableBilling,false);
  const {app,auth,services,email}=await createApp(config,db);t.after(()=>app.close());await app.ready();
  const sign=(id:string,aal='aal2')=>new SignJWT({email:'PRIVATE_EMAIL@example.test',aal}).setProtectedHeader({alg:'RS256',kid}).setIssuer(`${origin}/auth/v1`).setAudience('authenticated').setSubject(id).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const staff=await sign(operatorId),weak=await sign(operatorId,'aal1'),customer=await sign(customerId);
  const request=(method:any,path:string,token=staff,payload?:any,headers:any={})=>app.inject({method,url:path,headers:{authorization:`Bearer ${token}`,...headers},...(payload===undefined?{}:{payload})});
  const checked=async(method:any,path:string,token=staff,payload?:any)=>{const response=await request(method,path,token,payload);assert.equal(response.statusCode,200,response.body);return response.json();};
  const staffSession=await checked('GET','/api/session'),customerSession=await checked('GET','/api/session',customer);
  const workspaceId=customerSession.workspace.id;
  const ctx:Context={...await auth.resolveContext(operatorId,'',staffSession.workspace.id,'web',[...ALL_SCOPES]),assuranceLevel:'aal2'};
  const incidents=new EmailIncidents(services);
  const fixture=async(status='review-needed',updatedAt=new Date().toISOString(),createdAt=new Date().toISOString())=>{
    const id=randomUUID(),notice=randomUUID(),message=randomUUID(),digest=recipientHash('PRIVATE_DESTINATION@example.test');
    await db.query("INSERT INTO notifications(id,workspace_id,recipient_user_id,kind,event_key) VALUES($1,$2,$3,'payment-needs-attention',$4)",[notice,workspaceId,customerId,randomBytes(32).toString('hex')]);
    await db.query(`INSERT INTO email_outbox(id,notification_id,workspace_id,recipient_user_id,preference_version,status,attempts,payload,recipient_hash,first_attempt_at,provider_message_id,error_code,created_at,updated_at,next_attempt_at)
      VALUES($1,$2,$3,$4,1,$5,2,$6,$7,clock_timestamp()-interval '26 hours',$8,'EMAIL_RETRY_REVIEW_REQUIRED',$9,$10,clock_timestamp()+interval '1 day')`,[id,notice,workspaceId,customerId,status,{subject:'PRIVATE_SUBJECT',to:['PRIVATE_DESTINATION@example.test'],text:'PRIVATE_BODY'},digest,message,createdAt,updatedAt]);
    return {id,notice,message,digest};
  };
  const record=async(id:string)=>(await db.query('SELECT * FROM email_outbox WHERE id=$1',[id])).rows[0];
  const evidence=async(id:string)=>(await db.query('SELECT * FROM email_incident_state WHERE id=$1',[id])).rows[0];
  const input=async(id:string,extra:any={})=>{const current=await evidence(id);return {disposition:'closed-no-resend',reason:'Synthetic investigation ended; no resend authorized.',expectedDeliveryVersion:current.delivery_version,expectedReviewVersion:current.review_version,idempotencyKey:randomUUID(),confirmation:'RECORD EMAIL REVIEW',...extra};};
  const post=(id:string,payload:any,token=staff,headers:any={})=>request('POST',`/api/operator/email/incidents/${id}/review`,token,payload,headers);
  const audits=(id:string)=>db.query("SELECT * FROM audit_events WHERE action='operator.email.review' AND target_id=$1",[id]);

  await t.test('real HTTP authorization denies customer, weak MFA, MCP and forged headers before reads/writes',async()=>{
    const f=await fixture(),body=await input(f.id),before=await record(f.id);
    const token=await auth.issueToken(ctx,'Synthetic email operator denial',[...ALL_SCOPES]);
    try{for(const bearer of [customer,weak,token.token]){
      assert.equal((await request('GET','/api/operator/email/incidents',bearer,undefined,{'x-operator':'true','x-assurance-level':'aal2'})).statusCode,403);
      assert.equal((await post(f.id,body,bearer)).statusCode,403);
    }}finally{await db.query('UPDATE api_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[token.id]);}
    assert.deepEqual(await record(f.id),before);assert.equal((await audits(f.id)).rowCount,0);
  });
  await t.test('metadata projection, audited reads, no-store and strict page input never expose recipient/provider/content',async()=>{
    const f=await fixture('failed');
    const response=await request('GET','/api/operator/email/incidents?state=open&limit=50');assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'private, no-store');
    const found=response.json().incidents.find((r:any)=>r.id===f.id);assert.ok(found);
    assert.deepEqual(Object.keys(found).sort(),['attempts','createdAt','deliveryVersion','errorCode','id','previousReviewStale','reviewState','reviewVersion','status','updatedAt','workspaceId']);
    for(const privateValue of ['PRIVATE_',f.digest,f.message,f.notice,customerId])assert.equal(JSON.stringify(found).includes(privateValue),false);
    assert.equal(found.reviewState,'open');assert.equal(found.reviewVersion,0);
    for(const query of ['state=bogus','limit=0','limit=51','recipient=x','cursor=%%%'])assert.equal((await request('GET',`/api/operator/email/incidents?${query}`)).statusCode,400);
    assert.ok((await db.query("SELECT 1 FROM audit_events WHERE actor_id=$1 AND action='operator.email.queue'",[operatorId])).rowCount);
  });
  await t.test('only active attention states qualify, including old acceptance but not ordinary queued or delivered mail',async()=>{
    for(const status of ['review-needed','failed','bounced','complained','suppressed','delayed','accepted','delivered','queued','retry','sending','skipped']){
      const f=await fixture(status);assert.equal(!!await evidence(f.id),['review-needed','failed','bounced','complained','suppressed','delayed'].includes(status),status);
      if(!await evidence(f.id))assert.equal((await post(f.id,{disposition:'closed-no-resend',reason:'Synthetic no-resend decision',expectedDeliveryVersion:1,expectedReviewVersion:0,idempotencyKey:randomUUID(),confirmation:'RECORD EMAIL REVIEW'})).json().error.code,'EMAIL_INCIDENT_NOT_ACTIVE');
      // Leave no claimable rows for the separate email-worker fixtures.
      if(['queued','retry','sending'].includes(status))await db.query("UPDATE email_outbox SET status='skipped' WHERE id=$1",[f.id]);
    }
    const old=await fixture('accepted',new Date(Date.now()-25*3600_000).toISOString());assert.ok(await evidence(old.id));
  });
  await t.test('origin, explicit confirmation, bounded reasons, exact versions and unknown fields precede writes',async()=>{
    const f=await fixture(),body=await input(f.id);
    for(const patch of [{confirmation:'RESEND'},{reason:'short'},{reason:'x'.repeat(1001)},{disposition:'delivered'},{expectedDeliveryVersion:0},{expectedReviewVersion:1.5},{email:'attacker@example.test'}])assert.equal((await post(f.id,{...body,...patch})).statusCode,400);
    assert.equal((await post(f.id,body,staff,{origin:'https://foreign.example.test'})).statusCode,403);
    assert.equal((await post(randomUUID(),body)).statusCode,404);
    const stale=await post(f.id,{...body,expectedDeliveryVersion:2});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'EMAIL_INCIDENT_CHANGED');
    assert.equal((await audits(f.id)).rowCount,0);assert.equal((await evidence(f.id)).review_version,0);
  });
  await t.test('same-key concurrent retries commit one review, receipt and private audit without delivery or notification mutation',async()=>{
    const f=await fixture('bounced');await db.query("INSERT INTO email_suppressions(recipient_hash,reason) VALUES($1,'bounced') ON CONFLICT DO NOTHING",[f.digest]);
    const before=await record(f.id),body=await input(f.id),notices=(await db.query('SELECT * FROM notifications WHERE id=$1',[f.notice])).rows;
    const results=await Promise.all(Array.from({length:6},()=>incidents.review(ctx,f.id,body)));
    for(const result of results)assert.deepEqual(result,results[0]);
    assert.equal(results[0].incident.reviewState,'closed-no-resend');assert.equal(results[0].incident.reviewVersion,1);assert.equal(results[0].incident.status,'bounced');
    assert.deepEqual(await record(f.id),before);assert.deepEqual((await db.query('SELECT * FROM notifications WHERE id=$1',[f.notice])).rows,notices);
    assert.ok((await db.query('SELECT 1 FROM email_suppressions WHERE recipient_hash=$1',[f.digest])).rowCount);
    const entries=await audits(f.id);assert.equal(entries.rowCount,1);assert.equal(entries.rows[0].metadata.reason,body.reason);assert.equal(entries.rows[0].actor_id,operatorId);assert.equal(entries.rows[0].workspace_id,workspaceId);
    assert.equal((await post(f.id,{...body,reason:'A different rationale must conflict.'})).json().error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await post(f.id,{...body,idempotencyKey:randomUUID()})).json().error.code,'EMAIL_INCIDENT_CHANGED');
    assert.deepEqual((await post(f.id,body)).json(),results[0]);
  });
  await t.test('new meaningful evidence reopens reviewed incidents; harmless repeated updates do not',async()=>{
    const f=await fixture(),body=await input(f.id),saved=await incidents.review(ctx,f.id,body);
    await db.query('UPDATE email_outbox SET status=status,delivery_version=999 WHERE id=$1',[f.id]);
    assert.equal((await evidence(f.id)).review_state,'closed-no-resend');assert.equal((await record(f.id)).delivery_version,1);
    await db.query("UPDATE email_outbox SET status='failed',error_code='EMAIL_PROVIDER_REJECTED' WHERE id=$1",[f.id]);
    const changed=await evidence(f.id);assert.equal(changed.delivery_version,2);assert.equal(changed.review_state,'open');assert.equal(changed.previous_review_stale,true);assert.equal(changed.review_version,1);
    assert.deepEqual(await incidents.review(ctx,f.id,body),saved);assert.equal((await evidence(f.id)).review_state,'open');
    const reopen=await input(f.id,{disposition:'investigating'});const next=await incidents.review(ctx,f.id,reopen);assert.equal(next.incident.reviewState,'investigating');assert.equal(next.incident.reviewVersion,2);assert.equal(next.incident.previousReviewStale,false);
    assert.equal((await audits(f.id)).rowCount,2);
  });
  await t.test('signed late delivery removes current incident without claiming the old staff review established delivery',async()=>{
    const f=await fixture(),body=await input(f.id),saved=await incidents.review(ctx,f.id,body);
    const date=new Date(),eventId=`msg_${randomUUID()}`;
    const raw=Buffer.from(JSON.stringify({type:'email.delivered',created_at:date.toISOString(),data:{email_id:f.message,to:['PRIVATE_DESTINATION@example.test']}}));
    await email.webhook(raw,{'svix-id':eventId,'svix-timestamp':`${Math.floor(date.getTime()/1000)}`,'svix-signature':new Webhook(secret).sign(eventId,date,raw)});
    assert.equal((await record(f.id)).status,'delivered');assert.equal(await evidence(f.id),undefined);
    assert.deepEqual(await incidents.review(ctx,f.id,body),saved);
    assert.equal((await post(f.id,{...body,idempotencyKey:randomUUID()})).json().error.code,'EMAIL_INCIDENT_NOT_ACTIVE');
    assert.equal((await audits(f.id)).rowCount,1);
  });
  await t.test('review waiting on an in-flight evidence update rechecks the committed version before saving',async()=>{
    const f=await fixture(),body=await input(f.id),gate=await db.connect();let locked=false,pending:Promise<unknown>|undefined;
    try{
      await gate.query('BEGIN');locked=true;
      const pid=(await gate.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      await gate.query('SELECT id FROM email_outbox WHERE id=$1 FOR UPDATE',[f.id]);
      pending=incidents.review(ctx,f.id,body);void pending.catch(()=>{});
      const deadline=Date.now()+2000;let blocked=0;
      do{blocked=(await db.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count;if(blocked)break;await new Promise<void>(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
      assert.ok(blocked,'review must wait on locked delivery evidence');
      await gate.query("UPDATE email_outbox SET status='failed' WHERE id=$1",[f.id]);
      await gate.query('COMMIT');locked=false;
      await assert.rejects(pending,{code:'EMAIL_INCIDENT_CHANGED'});assert.equal((await evidence(f.id)).review_version,0);assert.equal((await audits(f.id)).rowCount,0);
    }finally{if(locked)await gate.query('ROLLBACK');gate.release();await pending?.catch(()=>{});}
  });
  await t.test('concurrent distinct decisions cannot overwrite a newer review; failed receipt storage rolls everything back',async()=>{
    const f=await fixture(),a=await input(f.id),b={...a,disposition:'investigating',idempotencyKey:randomUUID()};
    const results=await Promise.allSettled([incidents.review(ctx,f.id,a),incidents.review(ctx,f.id,b)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'EMAIL_INCIDENT_CHANGED');
    const g=await fixture(),body=await input(g.id),original=services.storeReceipt;
    services.storeReceipt=async()=>{throw new Error('PRIVATE_INTERNAL_FAILURE');};
    try{const response=await post(g.id,body);assert.equal(response.statusCode,500);assert.doesNotMatch(response.body,/PRIVATE_INTERNAL_FAILURE/);}finally{services.storeReceipt=original;}
    assert.equal((await evidence(g.id)).review_version,0);assert.equal((await audits(g.id)).rowCount,0);
    assert.equal((await db.query("SELECT 1 FROM write_receipts WHERE action='operator.email.review' AND request_key=$1",[body.idempotencyKey])).rowCount,0);
    assert.equal((await post(g.id,body)).statusCode,200);
  });
  await t.test('cursor pagination preserves PostgreSQL microseconds and active filter binding',async()=>{
    const ids=[];
    const future=new Date(Date.now()+100*365.25*24*3600_000).toISOString().slice(0,-1);
    for(const suffix of ['003Z','002Z','001Z'])ids.push((await fixture('failed',new Date().toISOString(),future+suffix)).id);
    let page=await incidents.list(ctx,{limit:1,state:'open'});assert.equal(page.incidents[0].id,ids[0]);
    assert.ok(page.nextCursor);
    await assert.rejects(incidents.list(ctx,{limit:1,state:'reviewed',cursor:page.nextCursor}),{code:'EMAIL_CURSOR_INVALID'});
    const seen=[page.incidents[0].id];for(let i=0;i<2;i++){page=await incidents.list(ctx,{limit:1,state:'open',cursor:page.nextCursor!});seen.push(page.incidents[0].id);}assert.deepEqual(seen,ids);
    for(const id of ids)await incidents.review(ctx,id,await input(id));
    const reviewed=await incidents.list(ctx,{state:'reviewed',limit:3});assert.deepEqual(reviewed.incidents.map(r=>r.id),ids);
    const open=await incidents.list(ctx,{state:'open',limit:50});for(const id of ids)assert.equal(open.incidents.some(r=>r.id===id),false);
  });
  await t.test('report and monitor expose unresolved review count separately from unchanged delivery failures',async()=>{
    const f=await fixture('failed');
    const before=await emailHealth(db),report=await email.report(ctx);assert.ok(report.openIncidents>=1);assert.ok(before.open_incidents>=1);assert.equal(before.needsAttention,true);
    await incidents.review(ctx,f.id,await input(f.id));
    const after=await emailHealth(db);assert.ok(Number.isSafeInteger(after.open_incidents));assert.equal((await evidence(f.id)).review_state,'closed-no-resend');assert.equal((await record(f.id)).status,'failed');
  });
  await t.test('new table/view have no direct public or client access; review notes remain only in restricted audit',async()=>{
    const table=(await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.email_incident_reviews'::regclass")).rows[0];assert.equal(table.relrowsecurity,true);
    for(const name of ['email_incident_reviews','email_incident_state']){
      assert.equal((await db.query('SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2',['public',name])).rowCount,0);
      assert.equal((await db.query("SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1::regclass AND a.grantee=0",[`public.${name}`])).rowCount,0);
      for(const role of ['anon','authenticated'])if((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`public.${name}`,'SELECT,INSERT,UPDATE,DELETE'])).rows[0].allowed,false);
    }
  });
  await t.test('revoked or demoted staff membership blocks even old successful receipts',async()=>{
    const f=await fixture(),body=await input(f.id);await incidents.review(ctx,f.id,body);
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    await assert.rejects(incidents.review(ctx,f.id,body),{code:'OPERATOR_REQUIRED'});
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    assert.equal((await request('GET','/api/operator/email/incidents')).statusCode,403);assert.equal((await post(f.id,body)).statusCode,403);
    assert.equal((await audits(f.id)).rowCount,1);
  });
});
