import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Webhook } from 'svix';
import { createDatabase, transaction, verifyMigrations } from '../db.js';
import { loadConfig } from '../config.js';
import { AppServices } from '../services.js';
import { createStorage } from '../storage.js';
import { createApp } from '../app.js';
import { ALL_SCOPES, type Context } from '../auth.js';
import { enqueueNotification } from '../notifications.js';
import { EmailDelivery, recipientHash } from '../email.js';
import { EmailDeliveryError, type EmailPayload } from '../email-provider.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('durable opt-in email outbox with synthetic recipients and providers only',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!);t.after(()=>db.end());await verifyMigrations(db);
  const secret=`whsec_${randomBytes(32).toString('base64')}`;
  const base=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,APPSCREEN_DEV_AUTH:'true',APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex')});
  const fixture=async()=>{
    const workspaceId=randomUUID(),userId=randomUUID(),email=`synthetic-${userId}@example.test`;
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspaceId,'Synthetic email delivery test']);
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,$4)',[workspaceId,userId,'stale-unverified@example.test','owner']);
    // Only this isolated fixture bypasses deployment config validation. The
    // injected resolver and provider never contact Supabase or Resend.
    const config={...base,emailEnabled:true,emailFrom:'notices@example.test',resendWebhookSecret:secret};
    const services=new AppServices(db,config,createStorage(config));
    const ctx:Context={workspaceId,userId,email,role:'owner',authKind:'development',scopes:[...ALL_SCOPES]};
    const calls:Array<{payload:EmailPayload;key:string}>=[];
    const provider={send:async(payload:EmailPayload,key:string)=>{calls.push({payload:structuredClone(payload),key});return {id:randomUUID()};}};
    const mail=new EmailDelivery(services,{provider,resolveEmail:async()=>email});
    const source=async()=>{
      const jobId=randomUUID(),projectId=randomUUID(),key=randomUUID();
      await db.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)',[projectId,workspaceId,'PRIVATE CAMPAIGN NAME']);
      await db.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,input,idempotency_key,request_hash,attempts) VALUES($1,$2,$3,$4,'design','ready',$5,$6,$6,1)",[jobId,workspaceId,projectId,userId,{private:'PRIVATE SCREENSHOT'},key]);
      return {kind:'design-ready' as const,workspaceId,recipientUserId:userId,jobId,attempt:1};
    };
    const enqueue=async()=>{const input=await source();return transaction(db,client=>enqueueNotification(client,input,{emailEnabled:true}));};
    const enable=()=>mail.savePreferences(ctx,{enabled:true,expectedVersion:0});
    const rows=async()=> (await db.query('SELECT * FROM email_outbox WHERE workspace_id=$1 ORDER BY created_at,id',[workspaceId])).rows;
    const due=()=>db.query("UPDATE email_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND status='retry'",[workspaceId]);
    const close=()=>db.query("UPDATE email_outbox SET status='skipped',lease_id=NULL,lease_until=NULL WHERE workspace_id=$1 AND status IN ('queued','retry','sending')",[workspaceId]);
    return {workspaceId,userId,email,config,services,ctx,calls,provider,mail,source,enqueue,enable,rows,due,close};
  };
  const event=(messageId:string,email:string,type='email.delivered',eventId=`msg_${randomUUID()}`)=>{
    const raw=Buffer.from(JSON.stringify({type,created_at:new Date().toISOString(),data:{email_id:messageId,to:[email],subject:'PRIVATE SUBJECT',bounce:{message:'PRIVATE BOUNCE'}}}));
    const date=new Date();return {raw,headers:{'svix-id':eventId,'svix-timestamp':`${Math.floor(date.getTime()/1000)}`,'svix-signature':new Webhook(secret).sign(eventId,date,raw)}};
  };

  await t.test('preferences default off, have optimistic versions, and never accept MCP or recipient overrides',async()=>{
    const f=await fixture();
    assert.deepEqual(await f.mail.preferences(f.ctx),{enabled:false,version:0,updatedAt:null,sendingAvailable:true});
    const saved=await f.enable();assert.equal(saved.enabled,true);assert.equal(saved.version,1);
    assert.deepEqual(await f.enable(),saved);
    await assert.rejects(f.mail.savePreferences(f.ctx,{enabled:false,expectedVersion:0}),{code:'EMAIL_PREFERENCES_CHANGED'});
    await assert.rejects(f.mail.savePreferences(f.ctx,{enabled:true,expectedVersion:1,email:'attacker@example.test'}));
    await assert.rejects(f.mail.preferences({...f.ctx,authKind:'mcp'}),{code:'BROWSER_SESSION_REQUIRED'});
    const disabled=new EmailDelivery(new AppServices(db,{...f.config,emailEnabled:false},createStorage(base)));
    assert.equal((await disabled.savePreferences(f.ctx,{enabled:false,expectedVersion:1})).version,2);
    await assert.rejects(disabled.savePreferences(f.ctx,{enabled:true,expectedVersion:2}),{code:'EMAIL_SENDING_UNAVAILABLE'});
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId]);
    await assert.rejects(f.mail.preferences(f.ctx),{code:'WORKSPACE_FORBIDDEN'});
  });
  await t.test('admission is opt-in, future-only, atomic, and duplicate-safe',async()=>{
    const f=await fixture();await f.enqueue();assert.equal((await f.rows()).length,0);await f.enable();
    const source=await f.source();
    await assert.rejects(transaction(db,async client=>{await enqueueNotification(client,source,{emailEnabled:true});throw new Error('synthetic rollback');}));
    assert.equal((await f.rows()).length,0);
    await Promise.all(Array.from({length:4},()=>transaction(db,client=>enqueueNotification(client,source,{emailEnabled:true}))));
    assert.equal((await f.rows()).length,1);
    const another=await f.source();await transaction(db,client=>enqueueNotification(client,another,{emailEnabled:false}));
    await transaction(db,client=>enqueueNotification(client,another,{emailEnabled:true}));assert.equal((await f.rows()).length,1);
    await f.close();
  });
  await t.test('disabled delivery performs neither recipient lookup nor sending',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();
    const mail=new EmailDelivery(new AppServices(db,{...f.config,emailEnabled:false},createStorage(base)),{provider:{send:async()=>{throw new Error('must not send');}},resolveEmail:async()=>{throw new Error('must not resolve');}});
    assert.equal(await mail.runOne(),false);assert.equal((await f.rows())[0].status,'queued');await f.close();
  });
  await t.test('verified current email replaces stale membership email; acceptance is not delivery',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();assert.equal(await f.mail.runOne(),true);
    const row=(await f.rows())[0];assert.equal(row.status,'accepted');assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0].payload.to,[f.email]);assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE|stale-unverified/);
    const sent=event(row.provider_message_id,f.email,'email.sent');await f.mail.webhook(sent.raw,sent.headers);
    assert.equal((await f.rows())[0].status,'accepted');
    const delivered=event(row.provider_message_id,f.email);await f.mail.webhook(delivered.raw,delivered.headers);await f.mail.webhook(delivered.raw,delivered.headers);
    assert.equal((await f.rows())[0].status,'delivered');
    await f.mail.webhook(sent.raw,sent.headers);assert.equal((await f.rows())[0].status,'delivered');
    const events=(await db.query('SELECT * FROM email_events WHERE provider_message_id=$1',[row.provider_message_id])).rows;
    assert.equal(events.length,2);assert.doesNotMatch(JSON.stringify(events),/PRIVATE|@example/);
    assert.equal(await f.mail.runOne(),false);
  });
  await t.test('retries and crashed leases preserve exact payload, destination and provider key',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();let tries=0;
    const calls:Array<{payload:EmailPayload;key:string}>=[];
    const provider={send:async(payload:EmailPayload,key:string)=>{calls.push({payload:structuredClone(payload),key});if(++tries===1)throw new EmailDeliveryError('EMAIL_PROVIDER_TIMEOUT',true);return {id:randomUUID()};}};
    const mail=new EmailDelivery(f.services,{provider,resolveEmail:async()=>f.email});await mail.runOne();assert.equal((await f.rows())[0].status,'retry');
    await db.query("UPDATE email_outbox SET status='sending',lease_id=$2,lease_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[f.workspaceId,randomUUID()]);
    const changed=new EmailDelivery(new AppServices(db,{...f.config,baseUrl:'https://changed.example.test',emailFrom:'changed@example.test'},createStorage(base)),{provider,resolveEmail:async()=>f.email});
    await changed.runOne();assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal((await f.rows())[0].attempts,2);assert.equal((await f.rows())[0].status,'accepted');
  });
  await t.test('changed or unverified recipient and changed opt-in version prevent further sends',async()=>{
    for(const variant of ['unverified','address','preferences','membership']){
      const f=await fixture();await f.enable();await f.enqueue();let calls=0;
      const provider={send:async()=>{calls++;throw new EmailDeliveryError('EMAIL_PROVIDER_TIMEOUT',true);}};
      const initial=new EmailDelivery(f.services,{provider,resolveEmail:async()=>f.email});await initial.runOne();await f.due();
      if(variant==='preferences'){await f.mail.savePreferences(f.ctx,{enabled:false,expectedVersion:1});await f.mail.savePreferences(f.ctx,{enabled:true,expectedVersion:2});}
      if(variant==='membership')await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1",[f.workspaceId]);
      const mail=new EmailDelivery(f.services,{provider,resolveEmail:async()=>variant==='unverified'?null:variant==='address'?'new@example.test':f.email});
      await mail.runOne();assert.equal(calls,1);assert.equal((await f.rows())[0].status,'skipped');
    }
  });
  await t.test('ambiguous intent outside provider idempotency window requires review, never a fresh send',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();let calls=0;
    const mail=new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>{calls++;throw new EmailDeliveryError('EMAIL_PROVIDER_TIMEOUT',true);}}});
    await mail.runOne();await f.due();await db.query("UPDATE email_outbox SET first_attempt_at=clock_timestamp()-interval '25 hours' WHERE workspace_id=$1",[f.workspaceId]);
    await mail.runOne();assert.equal(calls,1);assert.equal((await f.rows())[0].status,'review-needed');
  });
  await t.test('permanent rejection is terminal; unattempted stale notices expire without sending',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();
    await new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>{throw new EmailDeliveryError('EMAIL_PROVIDER_REJECTED',false);}}}).runOne();
    assert.equal((await f.rows())[0].status,'failed');await f.enqueue();
    await db.query("UPDATE email_outbox SET created_at=clock_timestamp()-interval '25 hours' WHERE workspace_id=$1 AND status='queued'",[f.workspaceId]);
    await f.mail.runOne();assert.equal(f.calls.length,0);assert.equal((await f.rows()).filter(row=>row.status==='skipped').length,1);
  });
  await t.test('permanent rejection after an ambiguous send requires review instead of asserting delivery failed',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();let calls=0;
    const mail=new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>{
      calls++;throw new EmailDeliveryError(calls===1?'EMAIL_PROVIDER_TIMEOUT':'EMAIL_PROVIDER_REJECTED',calls===1);
    }}});
    await mail.runOne();const attempted=(await f.rows())[0];
    assert.equal(attempted.status,'retry');assert.ok(attempted.first_attempt_at);await f.due();
    await mail.runOne();const rejected=(await f.rows())[0];
    assert.equal(rejected.status,'review-needed');assert.equal(rejected.error_code,'EMAIL_PROVIDER_REJECTED');
    assert.equal(rejected.attempts,2);assert.equal(rejected.provider_message_id,null);
    assert.equal(rejected.first_attempt_at.getTime(),attempted.first_attempt_at.getTime());
    assert.equal(await mail.runOne(),false);assert.equal(calls,2);
  });
  await t.test('late acceptance repairs a historical local failure and reconciles delivery on either side of the response',async()=>{
    for(const eventBeforeResponse of [true,false]){
      const f=await fixture();await f.enable();await f.enqueue();const messageId=randomUUID();
      let entered!:()=>void,respond!:(value:{id:string})=>void;
      const sending=new Promise<void>(resolve=>{entered=resolve;});
      const response=new Promise<{id:string}>(resolve=>{respond=resolve;});
      const mail=new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>{entered();return response;}}});
      const pending=mail.runOne();
      try{
        await sending;
        // Model a persisted local failure from an older worker while a stale
        // attempt still has a response in flight. No signed failure exists.
        await db.query("UPDATE email_outbox SET status='failed',error_code='EMAIL_PROVIDER_REJECTED',lease_id=NULL,lease_until=NULL WHERE workspace_id=$1",[f.workspaceId]);
        const delivered=event(messageId,f.email);
        if(eventBeforeResponse)await f.mail.webhook(delivered.raw,delivered.headers);
        assert.equal((await f.rows())[0].status,'failed');
        respond({id:messageId});await pending;
        if(!eventBeforeResponse){assert.equal((await f.rows())[0].status,'accepted');await f.mail.webhook(delivered.raw,delivered.headers);}
        const row=(await f.rows())[0];assert.equal(row.status,'delivered');assert.equal(row.provider_message_id,messageId);assert.equal(row.error_code,null);
      }finally{respond({id:messageId});await pending;await f.close();}
    }
  });
  await t.test('webhook and send finalization both wait on the same message lock before either write',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();const messageId=randomUUID();
    const gate=await db.connect();let pending:Promise<unknown>|undefined,finished=0,gateHeld=false;
    try{
      await gate.query('BEGIN');gateHeld=true;
      const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`appscreen-email:${messageId}`]);
      const mail=new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>({id:messageId})}});
      const bounced=event(messageId,f.email,'email.bounced');
      pending=Promise.all([mail.runOne().finally(()=>{finished++;}),f.mail.webhook(bounced.raw,bounced.headers).finally(()=>{finished++;})]);
      let blocked=0;const deadline=Date.now()+1000;
      do{
        blocked=(await db.query(`SELECT count(*)::integer AS count FROM pg_locks waiting JOIN pg_locks held
          ON held.locktype=waiting.locktype AND held.database=waiting.database AND held.classid=waiting.classid
          AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiting.granted`,[pid])).rows[0].count;
        if(blocked===2||finished>0)break;
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }while(Date.now()<deadline);
      assert.equal(blocked,2,'both transactions must block on the held message advisory lock');
      assert.equal(finished,0);
      assert.equal((await f.rows())[0].provider_message_id,null);
      assert.equal((await db.query('SELECT 1 FROM email_events WHERE provider_message_id=$1',[messageId])).rowCount,0);
      await gate.query('COMMIT');gateHeld=false;await pending;
      const row=(await f.rows())[0];assert.equal(row.status,'bounced');assert.equal(row.provider_message_id,messageId);
      assert.equal((await db.query('SELECT reason FROM email_suppressions WHERE recipient_hash=$1',[recipientHash(f.email)])).rows[0].reason,'bounced');
    }finally{if(gateHeld)await gate.query('ROLLBACK');gate.release();await pending;await f.close();}
  });
  await t.test('concurrent workers claim one intent; early and out-of-order negative events remain authoritative',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();const messageId=randomUUID();let calls=0;
    const mail=new EmailDelivery(f.services,{resolveEmail:async()=>f.email,provider:{send:async()=>{
      calls++;const bounced=event(messageId,f.email,'email.bounced');await f.mail.webhook(bounced.raw,bounced.headers);return {id:messageId};
    }}});
    await Promise.all([mail.runOne(),mail.runOne(),mail.runOne()]);assert.equal(calls,1);assert.equal((await f.rows())[0].status,'bounced');
    const delivered=event(messageId,f.email);await f.mail.webhook(delivered.raw,delivered.headers);assert.equal((await f.rows())[0].status,'bounced');
    const complained=event(messageId,f.email,'email.complained');await f.mail.webhook(complained.raw,complained.headers);assert.equal((await f.rows())[0].status,'complained');
    await f.enqueue();await f.mail.runOne();assert.equal(f.calls.length,0);assert.equal((await f.rows())[1].error_code,'EMAIL_RECIPIENT_SUPPRESSED');
  });
  await t.test('forged, wrong-recipient, and conflicting event IDs cannot alter a delivery',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();await f.mail.runOne();const row=(await f.rows())[0];
    const wrong=event(row.provider_message_id,'wrong@example.test','email.complained');await f.mail.webhook(wrong.raw,wrong.headers);assert.equal((await f.rows())[0].status,'accepted');
    const right=event(row.provider_message_id,f.email);
    await assert.rejects(f.mail.webhook(Buffer.from(right.raw.toString().replace('delivered','complained')),right.headers),{code:'EMAIL_WEBHOOK_INVALID'});
    await f.mail.webhook(right.raw,right.headers);
    const conflict=event(row.provider_message_id,f.email,'email.bounced',right.headers['svix-id']);
    await assert.rejects(f.mail.webhook(conflict.raw,conflict.headers),{code:'EMAIL_EVENT_CONFLICT'});assert.equal((await f.rows())[0].status,'delivered');
    assert.equal((await db.query('SELECT 1 FROM email_suppressions WHERE recipient_hash=$1',[recipientHash(f.email)])).rowCount,0);
  });
  await t.test('webhooks retain raw-byte verification while sending is paused; API rejects cross-origin and MCP preferences',async()=>{
    const config={...base,resendWebhookSecret:secret};const runtime=await createApp(config,db);t.after(()=>runtime.app.close());
    const session=await runtime.auth.developmentSession(`email-api-${randomUUID()}@example.test`);
    const headers={authorization:`Bearer ${session.token}`};
    assert.equal((await runtime.app.inject({method:'GET',url:'/api/notifications/email-preferences',headers})).statusCode,200);
    const account=(await runtime.app.inject({url:'/api/session',headers})).json();
    const ctx=await runtime.auth.resolveContext(account.user.id,'',account.workspace.id,'development',[...ALL_SCOPES]);
    const connection=await runtime.auth.issueToken(ctx,'Synthetic email preference denial',[...ALL_SCOPES]);
    try{
      assert.equal((await runtime.app.inject({url:'/api/notifications/email-preferences',headers:{authorization:`Bearer ${connection.token}`}})).statusCode,403);
      assert.equal((await runtime.app.inject({method:'POST',url:'/api/notifications/email-preferences',headers:{authorization:`Bearer ${connection.token}`},payload:{enabled:false,expectedVersion:0}})).statusCode,403);
    }finally{await db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[connection.id]);}
    assert.equal((await runtime.app.inject({method:'POST',url:'/api/notifications/email-preferences',headers:{...headers,origin:'https://evil.example.test'},payload:{enabled:false,expectedVersion:0}})).statusCode,403);
    const signed=event(randomUUID(),'synthetic@example.test');
    assert.equal((await runtime.app.inject({method:'POST',url:'/api/webhooks/email',headers:{...signed.headers,'content-type':'application/json'},payload:signed.raw})).statusCode,200);
    assert.equal((await runtime.app.inject({method:'POST',url:'/api/webhooks/email',headers:{'content-type':'application/json'},payload:signed.raw})).statusCode,400);
    assert.equal((await runtime.app.inject({method:'GET',url:'/api/operator/email',headers})).statusCode,403);
    const publicConfig=(await runtime.app.inject('/api/config')).body;assert.doesNotMatch(publicConfig,/whsec_|RESEND|resendWebhookSecret/);
  });
  await t.test('operator email report requires current allowlisted ownership, returns only aggregates, and audits access',async()=>{
    const f=await fixture();await f.enable();await f.enqueue();await f.mail.runOne();
    const delivery=(await f.rows())[0],ctx:Context={...f.ctx,authKind:'web',assuranceLevel:'aal2'};
    const config={...f.config,operatorUserIds:[f.userId]};
    const mail=new EmailDelivery(new AppServices(db,config,createStorage(config)),{provider:f.provider,resolveEmail:async()=>f.email});
    const audits=async()=>(await db.query("SELECT actor_id,metadata FROM audit_events WHERE workspace_id=$1 AND action='operator.email.report'",[f.workspaceId])).rows;
    await assert.rejects(f.mail.report(ctx),{code:'OPERATOR_REQUIRED'});
    await assert.rejects(mail.report({...ctx,authKind:'mcp'}),{code:'OPERATOR_REQUIRED'});
    await assert.rejects(mail.report({...ctx,assuranceLevel:'aal1'}),{code:'OPERATOR_REQUIRED'});
    assert.equal((await audits()).length,0);
    const report=await mail.report(ctx);
    assert.deepEqual(Object.keys(report).sort(),['counts','oldestPendingSeconds','openIncidents','reviewRequired','sendingEnabled']);
    assert.equal(report.sendingEnabled,true);assert.ok(Number.isSafeInteger(report.oldestPendingSeconds));assert.ok(Number.isSafeInteger(report.reviewRequired));
    assert.ok(report.counts.some(row=>row.status==='accepted'&&row.count>=1));
    for(const row of report.counts){assert.deepEqual(Object.keys(row).sort(),['count','status']);assert.ok(Number.isSafeInteger(row.count));}
    const serialized=JSON.stringify(report);
    for(const privateValue of [f.email,f.config.emailFrom,delivery.id,delivery.notification_id,delivery.provider_message_id,delivery.recipient_hash])assert.equal(serialized.includes(privateValue),false);
    assert.doesNotMatch(serialized,/recipient|payload|provider|subject|PRIVATE/i);
    assert.deepEqual(await audits(),[{actor_id:f.userId,metadata:{}}]);
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId]);
    await assert.rejects(mail.report(ctx),{code:'OPERATOR_REQUIRED'});
    assert.equal((await audits()).length,1);
  });
  await t.test('email tables have no public/client database access',async()=>{
    for(const table of ['email_preferences','email_outbox','email_events','email_suppressions']){
      const result=(await db.query("SELECT relrowsecurity,coalesce(relacl,acldefault('r',relowner)) AS acl FROM pg_class WHERE oid=$1::regclass",[`public.${table}`])).rows[0];assert.equal(result.relrowsecurity,true);
      const policies=(await db.query('SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2',['public',table])).rows;assert.equal(policies.length,0);
      const grants=(await db.query("SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=$1::regclass AND a.grantee=0",[`public.${table}`])).rows;assert.equal(grants.length,0);
      for(const role of ['anon','authenticated'])if((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`public.${table}`,'SELECT,INSERT,UPDATE,DELETE'])).rows[0].allowed,false);
    }
  });
});
