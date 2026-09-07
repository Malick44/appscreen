import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { createAuth, hash, ALL_SCOPES, type Context } from '../auth.js';
import { AccountLifecycle } from '../account-lifecycle.js';
import { SupportCases } from '../support.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const write=(expectedVersion:number)=>({expectedVersion,idempotencyKey:randomUUID()});
test('support cases preserve privacy and serialize audited staff/customer work',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const run=randomUUID(),staffEmail=`support-staff-${run}@integration.appscreen.test`,staffId=`dev:${hash(staffEmail)}`;
  const db=createDatabase(databaseUrl!);const directory=await mkdtemp(join(tmpdir(),'appscreen-support-test-'));
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APP_BASE_URL:'http://localhost',APPSCREEN_STORAGE_PATH:directory,APPSCREEN_OPERATOR_USER_IDS:staffId,APPSCREEN_ENABLE_AI:'false'});
  const services=new AppServices(db,config,createStorage(config)),auth=createAuth(db,config),lifecycle=new AccountLifecycle(services),support=new SupportCases(services);
  t.after(()=>db.end());await migrate(db);
  const login=async(label:string)=>{const email=`support-${label}-${run}@integration.appscreen.test`;await auth.developmentSession(email);return auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',[...ALL_SCOPES]);};
  const customer=await login('customer'),foreign=await login('foreign'),staff=await login('staff');
  const newCase=async(ctx=customer,body='Please help with my original campaign.')=>(await lifecycle.requestSupport(ctx,{message:body,idempotencyKey:randomUUID()})).requestId;
  const raw=async(id:string)=>(await db.query('SELECT * FROM account_requests WHERE id=$1',[id])).rows[0];
  const messages=async(id:string)=>(await db.query('SELECT * FROM support_messages WHERE request_id=$1 ORDER BY created_at,id',[id])).rows;

  await t.test('customer history/detail preserve initial legacy text but metadata lists contain no private bodies',async()=>{
    const id=await newCase(customer,'PRIVATE_INITIAL_MESSAGE retained verbatim.'),other=await newCase(foreign,'FOREIGN_PRIVATE_MESSAGE');
    await db.query('UPDATE account_requests SET details=details||$2::jsonb WHERE id=$1',[id,{privateProviderSecret:'PRIVATE_SECRET',url:'https://private.invalid/?token=PRIVATE_TOKEN'}]);
    const history=await support.customerList(customer);assert.ok(history.cases.some(item=>item.id===id));assert.equal(history.cases.some(item=>item.id===other),false);assert.doesNotMatch(JSON.stringify(history),/PRIVATE_/);
    const detail=await support.customerDetail(customer,id);assert.equal(detail.case.version,1);assert.equal(detail.case.status,'pending');assert.equal(detail.initialMessageAvailable,true);assert.equal(detail.messages[0].id,`${id}:initial`);assert.equal(detail.messages[0].body,'PRIVATE_INITIAL_MESSAGE retained verbatim.');assert.equal(detail.messages[0].author,'customer');
    assert.equal('requester' in detail,false);assert.equal('internalNotes' in detail,false);assert.equal('workspaceId' in detail.case,false);assert.doesNotMatch(JSON.stringify(detail),/PRIVATE_SECRET|PRIVATE_TOKEN/);
    await assert.rejects(support.customerDetail(foreign,id),{code:'SUPPORT_NOT_FOUND'});
  });

  await t.test('paginated histories have stable cursors bound to view, workspace and status',async()=>{
    const ctx=await login('pages');const expected:string[]=[];for(let i=0;i<4;i++)expected.push(await newCase(ctx,`Pagination case number ${i}.`));
    const found:string[]=[];let cursor:string|undefined;
    do{const page=await support.customerList(ctx,{limit:1,...(cursor?{cursor}:{})});found.push(...page.cases.map(item=>item.id));cursor=page.nextCursor||undefined;}while(cursor);
    assert.deepEqual(new Set(found),new Set(expected));assert.equal(found.length,4);
    const first=await support.customerList(ctx,{limit:1});assert.ok(first.nextCursor);
    await assert.rejects(support.customerList(foreign,{cursor:first.nextCursor}),{code:'SUPPORT_CURSOR_INVALID'});
    await assert.rejects(support.customerList(ctx,{cursor:first.nextCursor,status:'resolved'}),{code:'SUPPORT_CURSOR_INVALID'});
    await assert.rejects(support.customerList(ctx,{cursor:'not-valid-json'}),{code:'SUPPORT_CURSOR_INVALID'});
    const badDate=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8')),at:'2026-02-30 12:00:00+00'})).toString('base64url');
    await assert.rejects(support.customerList(ctx,{cursor:badDate}),{code:'SUPPORT_CURSOR_INVALID'});
    await assert.rejects(support.customerList(ctx,{limit:1000}));
  });

  await t.test('customer follow-ups are versioned, replay-safe and cannot edit another workspace',async()=>{
    const id=await newCase(),input={...write(1),message:'Here are the additional steps to reproduce it.'};
    const first=await support.customerFollowUp(customer,id,input),again=await support.customerFollowUp(customer,id,input);
    assert.equal(first.case.version,2);assert.equal(again.replayed,true);assert.equal(first.messageId,again.messageId);assert.equal((await messages(id)).length,1);
    await assert.rejects(support.customerFollowUp(customer,id,{...input,message:'Changed content under the same retry key.'}),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(support.customerFollowUp(customer,id,{...write(1),message:'This stale edit must not overwrite the thread.'}),{code:'SUPPORT_VERSION_CONFLICT'});
    await assert.rejects(support.customerFollowUp(foreign,id,{...write(2),message:'Foreign write'}),{code:'SUPPORT_NOT_FOUND'});
    assert.equal((await messages(id)).length,1);
  });

  await t.test('active teammates share workspace support access but not staff-only content',async()=>{
    const id=await newCase(),teammate=await login('teammate');
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,'member')",[customer.workspaceId,teammate.userId,teammate.email]);
    const ctx=await auth.resolveContext(teammate.userId,teammate.email,customer.workspaceId,'development',[...ALL_SCOPES]);
    assert.ok((await support.customerList(ctx)).cases.some(item=>item.id===id));assert.equal((await support.customerDetail(ctx,id)).messages[0].author,'customer');
    const response=await support.customerFollowUp(ctx,id,{...write(1),message:'Adding details as a teammate in the same workspace.'});assert.equal(response.case.version,2);assert.equal('requester' in response,false);assert.equal('internalNotes' in response,false);
  });

  await t.test('two competing customer writers admit exactly one version and message',async()=>{
    const id=await newCase();const results=await Promise.allSettled(['First response','Second response'].map(body=>support.customerFollowUp(customer,id,{...write(1),message:body})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'SUPPORT_VERSION_CONFLICT');assert.equal((await messages(id)).length,1);assert.equal((await raw(id)).support_version,2);
  });

  await t.test('operator queue is metadata-only and private detail requires a reason and durable audit',async()=>{
    const id=await newCase(customer,'PRIVATE_CASE for audited staff access.');
    const queue=await support.operatorList(staff,{limit:100});assert.ok(queue.cases.some(item=>item.id===id));assert.doesNotMatch(JSON.stringify(queue),/PRIVATE_CASE|integration.appscreen.test/);
    await assert.rejects(support.operatorDetail(staff,id,{reason:'short'}));
    const before=(await db.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='operator.support.private-view'",[id])).rowCount;
    const detail:any=await support.operatorDetail(staff,id,{reason:'Investigating this customer-reported issue.'});assert.equal(detail.requester.userId,customer.userId);assert.equal(detail.requester.email,customer.email);assert.equal(detail.messages[0].body,'PRIVATE_CASE for audited staff access.');assert.ok(detail.allowedTransitions.includes('in-progress'));
    const audits=await db.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='operator.support.private-view'",[id]);assert.equal(audits.rowCount,before!+1);assert.equal(audits.rows.at(-1).actor_id,staff.userId);assert.equal(audits.rows.at(-1).workspace_id,customer.workspaceId);
    const original=(support as any).audit;(support as any).audit=async()=>{throw new Error('Simulated audit write outage');};
    try{await assert.rejects(support.operatorDetail(staff,id,{reason:'Private reads must fail if auditing fails.'}),/audit write outage/);}finally{(support as any).audit=original;}
  });

  await t.test('staff public replies reach the customer but expose neither staff identity nor internal notes',async()=>{
    const id=await newCase(),note='INTERNAL_ONLY account investigation details.';
    const escalated=await support.operatorTransition(staff,id,{...write(1),status:'escalated',internalNote:note});assert.equal(escalated.case.version,2);
    const replied=await support.operatorReply(staff,id,{...write(2),status:'waiting-on-customer',message:'Please try exporting the campaign again.'});assert.equal(replied.case.version,3);assert.equal('messages' in replied,false);assert.equal('requester' in replied,false);
    const detail=await support.customerDetail(customer,id);assert.equal(detail.case.status,'waiting-on-customer');assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].author,'support');assert.equal(detail.messages[1].body,'Please try exporting the campaign again.');assert.doesNotMatch(JSON.stringify(detail),/INTERNAL_ONLY/);assert.equal(JSON.stringify(detail).includes(staff.userId),false);
    const privateDetail:any=await support.operatorDetail(staff,id,{reason:'Reviewing escalation context before continuing.'});assert.equal(privateDetail.internalNotes.length,1);assert.equal(privateDetail.internalNotes[0].body,note);assert.equal(privateDetail.internalNotes[0].staffUserId,staff.userId);
    const followed=await support.customerFollowUp(customer,id,{...write(3),message:'I tried again and can still reproduce it.'});assert.equal(followed.case.status,'pending');assert.equal(followed.case.version,4);
  });

  await t.test('status transitions and escalation notes are explicit; resolved cases can be reopened',async()=>{
    const id=await newCase();await assert.rejects(support.operatorTransition(staff,id,{...write(1),status:'escalated'}),{code:'SUPPORT_NOTE_REQUIRED'});
    await assert.rejects(support.operatorReply(staff,id,{...write(1),status:'escalated',message:'Escalation cannot bypass an internal reason.'}),{code:'SUPPORT_TRANSITION_INVALID'});
    await assert.rejects(support.operatorTransition(staff,id,{...write(1),status:'deleted'}));
    const resolved=await support.operatorTransition(staff,id,{...write(1),status:'resolved'});assert.equal(resolved.case.status,'resolved');
    await assert.rejects(support.operatorTransition(staff,id,{...write(2),status:'pending'}),{code:'SUPPORT_TRANSITION_INVALID'});
    await assert.rejects(support.operatorReply(staff,id,{...write(1),message:'Stale response after someone resolved it.'}),{code:'SUPPORT_VERSION_CONFLICT'});
    const reopened=await support.customerFollowUp(customer,id,{...write(2),message:'The problem has returned.'});assert.equal(reopened.case.status,'pending');
    const legacy=await newCase();await db.query("UPDATE account_requests SET status='old-open-state' WHERE id=$1",[legacy]);
    const customerView=await support.customerDetail(customer,legacy);assert.equal(customerView.case.status,'requires-review');assert.equal(customerView.allowedActions.followUp,false);
    await assert.rejects(support.operatorTransition(staff,legacy,{...write(1),status:'in-progress'}),{code:'SUPPORT_NOTE_REQUIRED'});
    const fixed=await support.operatorTransition(staff,legacy,{...write(1),status:'in-progress',internalNote:'Recovered an unsupported legacy status after review.'});assert.equal(fixed.case.status,'in-progress');
  });

  await t.test('staff reply receipts and notification intents commit once in the same transaction',async()=>{
    const id=await newCase();let calls=0;
    const hooked=new SupportCases(services,{onStaffReply:async(client,input)=>{
      calls++;assert.equal(input.workspaceId,customer.workspaceId);assert.equal(input.recipientUserId,customer.userId);assert.equal(input.requestId,id);
      assert.equal((await client.query('SELECT author_kind,visibility FROM support_messages WHERE id=$1',[input.messageId])).rows[0].author_kind,'support');
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.workspaceId,'test-hook','test.support-notification',input.messageId,{requestId:id}]);
    }});
    const input={...write(1),message:'The issue has been corrected. Please confirm.'};
    const results=await Promise.all(Array.from({length:4},()=>hooked.operatorReply(staff,id,input)));assert.equal(new Set(results.map(item=>item.messageId)).size,1);assert.equal(calls,1);assert.equal((await messages(id)).length,1);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='test.support-notification'",[results[0].messageId])).rowCount,1);
    await assert.rejects(hooked.operatorReply(staff,id,{...input,message:'A changed message cannot reuse the same key.'}),{code:'IDEMPOTENCY_CONFLICT'});
  });

  await t.test('failed notification enqueue rolls back reply, version, audit and receipt together',async()=>{
    const id=await newCase(),input={...write(1),message:'This reply must be atomic with its notification intent.'};
    const hooked=new SupportCases(services,{onStaffReply:async()=>{throw new Error('Simulated notification database failure');}});
    await assert.rejects(hooked.operatorReply(staff,id,input),/notification database failure/);
    assert.equal((await raw(id)).support_version,1);assert.equal((await raw(id)).status,'pending');assert.equal((await messages(id)).length,0);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE target_id=$1 AND action='operator.support.reply'",[id])).rowCount,0);
    assert.equal((await db.query("SELECT * FROM write_receipts WHERE workspace_id=$1 AND request_key=$2 AND action='support.operator-reply'",[staff.workspaceId,input.idempotencyKey])).rowCount,0);
    assert.equal((await support.operatorReply(staff,id,input)).case.version,2);
  });

  await t.test('status retry never repeats private notes or overwrites a later customer response',async()=>{
    const id=await newCase(),input={...write(1),status:'resolved',internalNote:'Resolution documented after a controlled reproduction.'};
    const first=await support.operatorTransition(staff,id,input);assert.equal(first.case.version,2);
    await support.customerFollowUp(customer,id,{...write(2),message:'I need this case reopened.'});
    const replay=await support.operatorTransition(staff,id,input);assert.equal(replay.replayed,true);assert.equal(replay.case.status,'pending');assert.equal(replay.case.version,3);
    assert.equal((await messages(id)).filter(item=>item.visibility==='internal').length,1);
  });

  await t.test('MCP/OAuth, unconfigured staff, weak MFA and revoked staff cannot use privileged case actions',async()=>{
    const id=await newCase();
    for(const ctx of [{...staff,authKind:'mcp' as const},{...staff,connection:{kind:'oauth' as const,id:randomUUID(),version:1}},{...staff,authKind:'web' as const,assuranceLevel:'aal1' as const},customer]) {
      await assert.rejects(support.operatorList(ctx));await assert.rejects(support.operatorDetail(ctx,id,{reason:'Attempted private access must be denied.'}));await assert.rejects(support.operatorReply(ctx,id,{...write(1),message:'Unauthorized reply'}));await assert.rejects(support.operatorTransition(ctx,id,{...write(1),status:'resolved'}));
    }
    const mcp={...customer,authKind:'mcp' as const};await assert.rejects(support.customerList(mcp),{code:'BROWSER_SESSION_REQUIRED'});await assert.rejects(support.customerDetail(mcp,id),{code:'BROWSER_SESSION_REQUIRED'});await assert.rejects(support.customerFollowUp(mcp,id,{...write(1),message:'No agent support impersonation'}),{code:'BROWSER_SESSION_REQUIRED'});
    assert.equal((await messages(id)).length,0);
  });

  await t.test('support message storage has tenant foreign keys and no direct browser RLS policy',async()=>{
    const id=await newCase();
    await assert.rejects(db.query("INSERT INTO support_messages(id,request_id,workspace_id,author_id,author_kind,visibility,body) VALUES($1,$2,$3,$4,'customer','customer','Cross-tenant pointer')",[randomUUID(),id,foreign.workspaceId,foreign.userId]),{code:'23503'});
    await assert.rejects(db.query("INSERT INTO support_messages(id,request_id,workspace_id,author_id,author_kind,visibility,body) VALUES($1,$2,$3,$4,'customer','internal','Forbidden internal note')",[randomUUID(),id,customer.workspaceId,customer.userId]),{code:'23514'});
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.support_messages'::regclass")).rows[0].relrowsecurity,true);
    assert.equal((await db.query("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='support_messages'")).rowCount,0);
  });

  await t.test('revoked customer and staff membership deny subsequent reads and mutations',async()=>{
    const ctx=await login('revoked'),id=await newCase(ctx);await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    await assert.rejects(support.customerDetail(ctx,id),{code:'WORKSPACE_FORBIDDEN'});await assert.rejects(support.customerFollowUp(ctx,id,{...write(1),message:'A revoked member cannot reply.'}),{code:'WORKSPACE_FORBIDDEN'});
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[staff.workspaceId,staff.userId]);
    await assert.rejects(support.operatorList(staff));await assert.rejects(support.operatorReply(staff,id,{...write(1),message:'Staff permission was revoked.'}));assert.equal((await messages(id)).length,0);
  });
});
