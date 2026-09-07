import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createStorage } from '../storage.js';
import { AppServices } from '../services.js';
import { createAuth, hash, ALL_SCOPES, type Context } from '../auth.js';
import { createAccountExport, type AccountExportResult } from '../account-export.js';
import { AccountLifecycle } from '../account-lifecycle.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const collected=async(backup:AccountExportResult)=>{
  const parts:Buffer[]=[];
  for await(const chunk of backup.stream)parts.push(Buffer.from(chunk));
  const result=await backup.completion;
  const bytes=Buffer.concat(parts);assert.equal(result.byteSize,bytes.length);
  return {zip:await JSZip.loadAsync(bytes,{checkCRC32:true}),bytes,result};
};
const records=async(zip:JSZip,path:string)=>(await zip.file(path)!.async('string')).split('\n').filter(Boolean).map(line=>JSON.parse(line));

test('portable workspace export uses real database snapshots and private original bytes',{skip:!databaseUrl,timeout:90_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/,'Only a dedicated test database may be used');
  const db=createDatabase(databaseUrl!);
  const directory=await mkdtemp(join(tmpdir(),'appscreen-account-export-test-'));
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APP_BASE_URL:'http://localhost',APPSCREEN_STORAGE_PATH:directory,APPSCREEN_ENABLE_AI:'false',TRIAL_CREDITS:'5'});
  const storage=createStorage(config),services=new AppServices(db,config,storage),auth=createAuth(db,config);
  t.after(()=>db.end());await migrate(db);
  const run=randomUUID();
  const owner=async(label:string)=>{
    const email=`backup-${label}-${run}@integration.appscreen.test`;await auth.developmentSession(email);
    return auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',[...ALL_SCOPES]);
  };
  const png=await sharp({create:{width:128,height:256,channels:4,background:'#9bccbc'}}).png().toBuffer();
  const jpeg=await sharp({create:{width:128,height:256,channels:4,background:'#452952'}}).jpeg().toBuffer();
  const project=async(ctx:Context,name='Campaign')=>(await services.createProject(ctx,{name})).project;
  const uploaded=async(ctx:Context,projectId:string,name='original.png',bytes=png)=>(await services.uploadAsset(ctx,projectId,name,bytes)).asset;
  const artifact=async(ctx:Context,projectId:string,mimeType:string,bytes:Buffer,metadata:any={})=>{
    const id=randomUUID(),key=`${ctx.workspaceId}/exports/${randomUUID()}/artifact.bin`;
    await storage.put(key,bytes,mimeType);
    await db.query('INSERT INTO assets(id,workspace_id,project_id,name,storage_key,mime_type,byte_size,width,height,sha256,kind,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,128,256,$8,$9,$10)',[id,ctx.workspaceId,projectId,'../../unsafe-artifact-name',key,mimeType,bytes.length,hash(bytes),'export',metadata]);
    return {id,key};
  };
  const audits=async(ctx:Context,exportId:string)=>(await db.query("SELECT action,metadata FROM audit_events WHERE workspace_id=$1 AND target_id=$2 AND action LIKE 'account.export.%' ORDER BY action",[ctx.workspaceId,exportId])).rows;

  await t.test('archive contains active and archived campaigns, every revision and byte-identical originals',async()=>{
    const ctx=await owner('complete'),foreign=await owner('foreign');
    const active=await project(ctx,'My active campaign'),archived=await project(ctx,'My archived campaign'),other=await project(foreign,'Other tenant secret campaign');
    const source=await uploaded(ctx,active.id,'phone.png'),localized=await uploaded(ctx,active.id,'phone_fr.jpg',jpeg),archiveSource=await uploaded(ctx,archived.id);
    const foreignSource=await uploaded(foreign,other.id,'other-tenant-secret.png');
    const first=await services.createDraft(ctx,{projectId:active.id,assetIds:[source.id,localized.id],templateId:'tidal-relay',templateMode:'exact',screenCount:3,apply:true});
    const changed=structuredClone(first.revision.document);changed.sources[0].localizedAssets.fr=localized.id;changed.scenes[0].text.headlines.en='Editable headline';
    const second=await services.saveRevision(ctx,active.id,{document:changed,expectedRevisionId:first.revision.id,apply:true});
    const archivedDraft=await services.createDraft(ctx,{projectId:archived.id,assetIds:[archiveSource.id],screenCount:1,apply:true});
    await db.query('UPDATE projects SET archived_at=now() WHERE id=$1',[archived.id]);
    await db.query('UPDATE projects SET brief=$2,design_preferences=$3 WHERE id=$1',[active.id,{appName:'Useful app',promise:'Remember things'},{templateId:'tidal-relay',templateMode:'exact',screenCount:3}]);
    const image=await artifact(ctx,active.id,'image/png',png,{sceneId:changed.scenes[0].id,revisionId:second.revision.id});
    const duplicateZip=await artifact(ctx,active.id,'application/zip',Buffer.from('redundant generated ZIP'));
    const backup=await createAccountExport(services,ctx),{zip,result}=await collected(backup);
    assert.match(backup.filename,new RegExp(`^appscreen-workspace-${ctx.workspaceId}-\\d{4}-\\d{2}-\\d{2}\\.zip$`));
    const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(manifest.version,2);assert.equal(manifest.scope.workspaceId,ctx.workspaceId);assert.equal(manifest.restore.automated,false);
    for(const [key,value] of Object.entries({projects:2,revisions:3,assets:5,originalSources:3,includedAssets:4,omittedArtifacts:1}))assert.equal(manifest.counts[key],value,key);
    const projects=await records(zip,'data/projects.ndjson'),revisions=await records(zip,'data/revisions.ndjson'),assets=await records(zip,'data/assets.ndjson');
    assert.deepEqual(new Set(projects.map(item=>item.id)),new Set([active.id,archived.id]));
    assert.equal(projects.find(item=>item.id===active.id).activeRevisionId,second.revision.id);
    assert.ok(projects.find(item=>item.id===archived.id).archivedAt);
    assert.deepEqual(projects.find(item=>item.id===active.id).brief,{appName:'Useful app',promise:'Remember things'});
    assert.deepEqual(new Set(revisions.map(item=>item.id)),new Set([first.revision.id,second.revision.id,archivedDraft.revision.id]));
    assert.deepEqual(revisions.find(item=>item.id===second.revision.id).document,second.revision.document);
    for(const [id,expected] of [[source.id,png],[localized.id,jpeg],[archiveSource.id,png],[image.id,png]] as Array<[string,Buffer]>) {
      const item=assets.find(asset=>asset.id===id);assert.equal(item.included,true);assert.deepEqual(await zip.file(item.path)!.async('nodebuffer'),expected);assert.equal(hash(expected),item.sha256);
    }
    assert.equal(assets.find(item=>item.id===duplicateZip.id).path,null);assert.match(assets.find(item=>item.id===duplicateZip.id).omission,/Redundant/);
    assert.equal(assets.some(item=>item.id===foreignSource.id),false);
    for(const path of Object.keys(zip.files)){assert.equal(path.includes('..'),false);assert.equal(path.startsWith('/'),false);assert.equal(path.includes('\\'),false);}
    assert.equal(JSON.parse(await zip.file('integrity.json')!.async('string')).verifiedAssets,4);
    assert.equal(result.includedAssets,4);
    assert.deepEqual((await audits(ctx,backup.exportId)).map(item=>item.action),['account.export.completed','account.export.started']);
  });

  await t.test('safe profile, subscription and credit records exclude credentials, payment IDs and expiring URLs',async()=>{
    const ctx=await owner('redaction'),p=await project(ctx),source=await uploaded(ctx,p.id);
    await services.createDraft(ctx,{projectId:p.id,assetIds:[source.id],apply:true});
    await auth.issueToken(ctx,'Token must not be exported',['projects:read']);
    await db.query('UPDATE subscriptions SET customer_id=$1,subscription_id=$2,customer_request_payload=$3 WHERE workspace_id=$4',[`cus_SECRET_${randomUUID()}`,`sub_SECRET_${randomUUID()}`,{apiKey:'secret-do-not-export'},ctx.workspaceId]);
    await db.query('UPDATE assets SET metadata=$2 WHERE id=$1',[source.id,{locale:'fr',sourceId:'source-stable',url:'https://example.invalid/file?token=secret-link',apiKey:'secret-api-key',nested:{refresh_token:'secret-refresh',sceneId:'scene-stable'}}]);
    const {zip}=await collected(await createAccountExport(services,ctx));
    const members=await records(zip,'data/members.ndjson'),subscription=await records(zip,'data/subscription.ndjson'),credits=await records(zip,'data/credits.ndjson');
    assert.equal(members[0].userId,ctx.userId);assert.equal(members[0].email,ctx.email);assert.equal(members[0].role,'owner');
    assert.equal(subscription[0].planId,'trial');assert.equal(subscription[0].customerId,undefined);assert.equal(subscription[0].subscriptionId,undefined);assert.equal(credits[0].amount,5);assert.equal(credits[0].reference,undefined);
    const assets=await records(zip,'data/assets.ndjson');assert.deepEqual(assets[0].metadata,{locale:'fr',sourceId:'source-stable',nested:{sceneId:'scene-stable'}});
    const text=(await Promise.all(Object.entries(zip.files).filter(([path])=>!path.startsWith('assets/')).map(([,file])=>file.async('string')))).join('\n');
    assert.equal(text.includes('secret-do-not-export'),false);assert.equal(text.includes('secret-api-key'),false);assert.equal(text.includes('secret-refresh'),false);assert.equal(text.includes('secret-link'),false);assert.equal(text.includes('cus_SECRET_'),false);assert.equal(text.includes(config.signingSecret),false);assert.equal(text.includes('storageKey'),false);
  });

  await t.test('all metadata retains its initial snapshot while another request saves a newer revision',async()=>{
    const ctx=await owner('snapshot'),p=await project(ctx),asset=await uploaded(ctx,p.id);
    const initial=await services.createDraft(ctx,{projectId:p.id,assetIds:[asset.id],apply:true});
    const backup=await createAccountExport(services,ctx);
    const changed=structuredClone(initial.revision.document);changed.scenes[0].text.headlines.en='Saved after backup snapshot';
    const newer=await services.saveRevision(ctx,p.id,{document:changed,expectedRevisionId:initial.revision.id,apply:true});
    const {zip}=await collected(backup),projects=await records(zip,'data/projects.ndjson'),revisions=await records(zip,'data/revisions.ndjson');
    assert.equal(projects[0].activeRevisionId,initial.revision.id);assert.equal(revisions.length,1);assert.equal(revisions[0].id,initial.revision.id);assert.notEqual(revisions[0].id,newer.revision.id);
    assert.equal((await services.project(ctx,p.id)).activeRevisionId,newer.revision.id);
  });

  await t.test('support export includes public workspace conversations but excludes staff notes and other users’ inboxes',async()=>{
    const ctx=await owner('support-export'),teammate=await owner('support-teammate'),staff=await owner('support-staff'),foreign=await owner('support-foreign');
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,'member')",[ctx.workspaceId,teammate.userId,teammate.email]);
    const lifecycle=new AccountLifecycle(services);
    const initial=await lifecycle.requestSupport(ctx,{message:'OWNER_INITIAL_PUBLIC_SUPPORT_MESSAGE'});
    const team=await lifecycle.requestSupport({...teammate,workspaceId:ctx.workspaceId,role:'member'},{message:'TEAM_INITIAL_PUBLIC_SUPPORT_MESSAGE'});
    const hidden=await lifecycle.requestSupport(foreign,{message:'FOREIGN_PRIVATE_SUPPORT_MESSAGE'});
    const message=async(requestId:string,workspaceId:string,body:string,visibility='customer')=>{
      const id=randomUUID();await db.query("INSERT INTO support_messages(id,request_id,workspace_id,author_id,author_kind,visibility,body) VALUES($1,$2,$3,$4,'support',$5,$6)",[id,requestId,workspaceId,staff.userId,visibility,body]);return id;
    };
    const publicId=await message(initial.requestId,ctx.workspaceId,'OWNER_PUBLIC_STAFF_REPLY'),teamId=await message(team.requestId,ctx.workspaceId,'TEAM_PUBLIC_STAFF_REPLY');
    await message(initial.requestId,ctx.workspaceId,'INTERNAL_STAFF_NOTE_MUST_NEVER_EXPORT','internal');
    await message(hidden.requestId,foreign.workspaceId,'FOREIGN_PUBLIC_REPLY_MUST_NOT_EXPORT');
    const notification=async(recipient:string,requestId:string,messageId:string)=>{
      const id=randomUUID();await db.query("INSERT INTO notifications(id,workspace_id,recipient_user_id,kind,event_key,request_id,message_id,read_at) VALUES($1,$2,$3,'support-reply',$4,$5,$6,now())",[id,ctx.workspaceId,recipient,hash(id),requestId,messageId]);return id;
    };
    const ownNotice=await notification(ctx.userId,initial.requestId,publicId),teamNotice=await notification(teammate.userId,team.requestId,teamId);
    await db.query("INSERT INTO product_milestones(workspace_id,milestone,environment) VALUES($1,'first_campaign','nonproduction') ON CONFLICT DO NOTHING",[ctx.workspaceId]);
    await db.query("INSERT INTO product_milestones(workspace_id,milestone,environment) VALUES($1,'paid_conversion','nonproduction') ON CONFLICT DO NOTHING",[foreign.workspaceId]);
    const backup=await createAccountExport(services,ctx);
    // Late staff work must not leak into earlier snapshot records or counts.
    const lateMessage=await message(initial.requestId,ctx.workspaceId,'LATE_REPLY_AFTER_EXPORT_SNAPSHOT');
    await notification(ctx.userId,initial.requestId,lateMessage);
    await db.query("UPDATE account_requests SET status='resolved',support_version=2,support_updated_at=now() WHERE id=$1",[initial.requestId]);
    const {zip}=await collected(backup),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(manifest.records.supportCases,'data/support-cases.ndjson');assert.equal(manifest.records.supportMessages,'data/support-messages.ndjson');assert.equal(manifest.records.notifications,'data/notifications.ndjson');assert.equal(manifest.records.productMilestones,'data/product-milestones.ndjson');
    assert.equal(manifest.counts.supportCases,2);assert.equal(manifest.counts.publicSupportMessages,2);assert.equal(manifest.counts.notifications,1);
    const cases=await records(zip,'data/support-cases.ndjson'),replies=await records(zip,'data/support-messages.ndjson'),notices=await records(zip,'data/notifications.ndjson'),milestones=await records(zip,'data/product-milestones.ndjson');
    assert.deepEqual(new Set(cases.map(item=>item.id)),new Set([initial.requestId,team.requestId]));assert.equal(cases.find(item=>item.id===initial.requestId).initialMessage,'OWNER_INITIAL_PUBLIC_SUPPORT_MESSAGE');assert.equal(cases.find(item=>item.id===initial.requestId).status,'pending');assert.equal(cases.find(item=>item.id===initial.requestId).version,1);
    assert.deepEqual(new Set(replies.map(item=>item.body)),new Set(['OWNER_PUBLIC_STAFF_REPLY','TEAM_PUBLIC_STAFF_REPLY']));assert.ok(replies.every(item=>item.author==='support'&&item.authorId===undefined&&item.staffUserId===undefined));
    assert.deepEqual(notices.map(item=>item.id),[ownNotice]);assert.equal(notices.some(item=>item.id===teamNotice),false);assert.equal(notices[0].eventKey,undefined);assert.equal(notices[0].recipientUserId,undefined);assert.equal(notices[0].url,undefined);
    assert.ok(milestones.some(item=>item.milestone==='first_campaign'));assert.equal(milestones.some(item=>item.milestone==='paid_conversion'),false);assert.ok(milestones.every(item=>Object.keys(item).sort().join(',')==='environment,milestone,occurredAt'));
    const text=(await Promise.all(Object.entries(zip.files).filter(([path])=>!path.startsWith('assets/')).map(([,file])=>file.async('string')))).join('\n');
    assert.doesNotMatch(text,/INTERNAL_STAFF_NOTE_MUST_NEVER_EXPORT|FOREIGN_PRIVATE_SUPPORT_MESSAGE|FOREIGN_PUBLIC_REPLY_MUST_NOT_EXPORT|LATE_REPLY_AFTER_EXPORT_SNAPSHOT/);assert.equal(text.includes(staff.userId),false);assert.equal(text.includes(foreign.workspaceId),false);assert.equal(text.includes(teamNotice),false);
  });

  await t.test('email export includes only the requester’s workspace snapshot and safe personal metadata',async()=>{
    const ctx=await owner('email-export'),teammate=await owner('email-teammate'),foreign=await owner('email-foreign');
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,'member'),($4,$5,$6,'member')",[ctx.workspaceId,teammate.userId,teammate.email,foreign.workspaceId,ctx.userId,ctx.email]);
    const before='2026-01-02T03:04:05.000Z',after='2026-02-03T04:05:06.000Z';
    await db.query('INSERT INTO email_preferences(workspace_id,user_id,enabled,version,updated_at) VALUES($1,$2,true,3,$5),($1,$3,false,93,$5),($4,$2,true,87,$5)',[ctx.workspaceId,ctx.userId,teammate.userId,foreign.workspaceId,before]);
    const privateRecipient=`private-export-payload-${run}@integration.appscreen.test`;
    const delivery=async(workspaceId:string,recipient:string)=>{
      const notificationId=randomUUID(),id=randomUUID(),providerId=randomUUID(),recipientHash=hash(`private-recipient-${id}`);
      await db.query("INSERT INTO notifications(id,workspace_id,recipient_user_id,kind,event_key,created_at) VALUES($1,$2,$3,'payment-needs-attention',$4,$5)",[notificationId,workspaceId,recipient,hash(notificationId),before]);
      await db.query(`INSERT INTO email_outbox(id,notification_id,workspace_id,recipient_user_id,preference_version,status,attempts,payload,recipient_hash,provider_message_id,error_code,first_attempt_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,3,'accepted',2,$5,$6,$7,'EMAIL_PRIVATE_EXPORT_MARKER',$8,$8,$8)`,[id,notificationId,workspaceId,recipient,{from:'PRIVATE_EXPORT_EMAIL_SENDER',to:[privateRecipient],subject:'PRIVATE_EXPORT_EMAIL_SUBJECT',html:'PRIVATE_EXPORT_EMAIL_BODY',text:'PRIVATE_EXPORT_EMAIL_TEXT'},recipientHash,providerId,before]);
      return {id,notificationId,providerId,recipientHash};
    };
    const own=await delivery(ctx.workspaceId,ctx.userId),team=await delivery(ctx.workspaceId,teammate.userId),otherWorkspace=await delivery(foreign.workspaceId,ctx.userId);
    const eventId=`msg_private_export_${randomUUID()}`,payloadHash=hash(`private-event-payload-${run}`);
    await db.query("INSERT INTO email_events(event_id,provider_message_id,type,recipient_hash,payload_hash,occurred_at) VALUES($1,$2,'email.bounced',$3,$4,$5)",[eventId,own.providerId,own.recipientHash,payloadHash,before]);
    await db.query("INSERT INTO email_suppressions(recipient_hash,reason) VALUES($1,'bounced')",[own.recipientHash]);
    await db.query("INSERT INTO email_incident_reviews(outbox_id,delivery_version,version,disposition) VALUES($1,1,73,'closed-no-resend')",[own.id]);
    await db.query("INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,'operator.email.review',$4,$5)",[randomUUID(),ctx.workspaceId,'PRIVATE_EXPORT_EMAIL_STAFF',own.id,{reason:'PRIVATE_EXPORT_EMAIL_REVIEW_REASON'}]);
    const backup=await createAccountExport(services,ctx);
    // Preferences, delivery updates, inserts and their counts share the earlier snapshot.
    await db.query('UPDATE email_preferences SET enabled=false,version=4,updated_at=$3 WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId,after]);
    await db.query("UPDATE email_outbox SET status='delivered',attempts=3,updated_at=$2 WHERE id=$1",[own.id,after]);
    const late=await delivery(ctx.workspaceId,ctx.userId);
    const {zip}=await collected(backup),manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(manifest.records.emailPreferences,'data/email-preferences.ndjson');
    assert.equal(manifest.records.emailDeliveries,'data/email-deliveries.ndjson');
    assert.equal(manifest.counts.emailPreferences,1);assert.equal(manifest.counts.emailDeliveries,1);
    const preferences=await records(zip,'data/email-preferences.ndjson'),deliveries=await records(zip,'data/email-deliveries.ndjson');
    assert.deepEqual(preferences,[{enabled:true,version:3,updatedAt:before}]);
    assert.deepEqual(deliveries,[{id:own.id,notificationId:own.notificationId,status:'accepted',attempts:2,createdAt:before,updatedAt:before}]);
    assert.deepEqual((await db.query('SELECT enabled,version FROM email_preferences WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,ctx.userId])).rows,[{enabled:false,version:4}]);
    assert.deepEqual((await db.query('SELECT status,attempts FROM email_outbox WHERE id=$1',[own.id])).rows,[{status:'delivered',attempts:3}]);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM email_outbox WHERE workspace_id=$1 AND recipient_user_id=$2',[ctx.workspaceId,ctx.userId])).rows[0].count,2);
    assert.deepEqual((await records(zip,'data/notifications.ndjson')).map(item=>item.id),[own.notificationId]);
    assert.match(manifest.omissions.join('\n'),/requesting user’s current-workspace email preference and delivery metadata/);
    assert.match(manifest.omissions.join('\n'),/provider message\/event identifiers, suppression records/);
    const text=(await Promise.all(Object.entries(zip.files).filter(([path])=>!path.startsWith('assets/')).map(([,file])=>file.async('string')))).join('\n');
    assert.doesNotMatch(text,/PRIVATE_EXPORT_EMAIL_|EMAIL_PRIVATE_EXPORT_MARKER/);
    for(const value of [privateRecipient,own.providerId,own.recipientHash,eventId,payloadHash,team.id,team.notificationId,otherWorkspace.id,otherWorkspace.notificationId,foreign.workspaceId,late.id,late.notificationId])assert.equal(text.includes(value),false);
    assert.ok((await records(zip,'data/members.ndjson')).some(member=>member.userId===ctx.userId&&member.email===ctx.email));
    assert.equal(zip.file('data/email-events.ndjson'),null);assert.equal(zip.file('data/email-suppressions.ndjson'),null);assert.equal(zip.file('data/email-incident-reviews.ndjson'),null);
  });

  await t.test('email metadata files stay present when empty and count toward the exact fixed archive overhead',async()=>{
    const ctx=await owner('email-empty-export');
    await assert.rejects(createAccountExport(services,ctx,{maxFiles:15}),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    const {zip}=await collected(await createAccountExport(services,ctx,{maxFiles:16}));
    const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
    assert.equal(Object.keys(zip.files).length,16);
    assert.equal(manifest.counts.emailPreferences,0);assert.equal(manifest.counts.emailDeliveries,0);
    assert.deepEqual(await records(zip,'data/email-preferences.ndjson'),[]);
    assert.deepEqual(await records(zip,'data/email-deliveries.ndjson'),[]);
    const p=await project(ctx);await uploaded(ctx,p.id);
    await assert.rejects(createAccountExport(services,ctx,{maxFiles:16}),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    const withSource=await collected(await createAccountExport(services,ctx,{maxFiles:17}));
    assert.equal(Object.keys(withSource.zip.files).length,17);
  });

  await t.test('only a current owner browser session can start an export',async()=>{
    const ctx=await owner('permissions'),foreign=await owner('permissions-other');
    await assert.rejects(createAccountExport(services,{...ctx,authKind:'mcp'}),{code:'OWNER_REQUIRED'});
    await assert.rejects(createAccountExport(services,{...ctx,role:'member'}),{code:'OWNER_REQUIRED'});
    await assert.rejects(createAccountExport(services,{...ctx,workspaceId:foreign.workspaceId}),{code:'WORKSPACE_FORBIDDEN'});
    await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    await assert.rejects(createAccountExport(services,ctx),{code:'OWNER_REQUIRED'});
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    await assert.rejects(createAccountExport(services,ctx),{code:'WORKSPACE_FORBIDDEN'});
  });

  await t.test('one workspace and two global database slots limit concurrent long-lived exports',async()=>{
    const one=await owner('slot-one'),two=await owner('slot-two'),three=await owner('slot-three');
    const first=await createAccountExport(services,one),second=await createAccountExport(services,two);
    await assert.rejects(createAccountExport(services,one),{code:'ACCOUNT_EXPORT_BUSY',statusCode:409});
    await assert.rejects(createAccountExport(services,three),{code:'ACCOUNT_EXPORT_BUSY',statusCode:429});
    first.cancel();await assert.rejects(first.completion,{code:'ACCOUNT_EXPORT_CANCELLED'});
    const third=await createAccountExport(services,three);await collected(third);
    second.cancel();await assert.rejects(second.completion,{code:'ACCOUNT_EXPORT_CANCELLED'});
    assert.deepEqual((await audits(one,first.exportId)).map(item=>item.action),['account.export.cancelled','account.export.started']);
  });

  await t.test('storage is read sequentially with no eager whole-workspace buffering',async()=>{
    const ctx=await owner('sequential'),p=await project(ctx);
    for(let n=0;n<4;n++)await uploaded(ctx,p.id,`capture-${n}.png`);
    let active=0,maximum=0,count=0;
    const wrapped=new AppServices(db,config,{...storage,read:async(key)=>{active++;maximum=Math.max(maximum,active);count++;try{return await storage.read(key);}finally{active--;}}});
    await collected(await createAccountExport(wrapped,ctx));assert.equal(count,4);assert.equal(maximum,1);
  });

  await t.test('originals cannot be silently omitted for size, and derived size omissions are explicit',async()=>{
    const ctx=await owner('size'),p=await project(ctx),source=await uploaded(ctx,p.id);
    await assert.rejects(createAccountExport(services,ctx,{maxAssetBytes:png.length-1}),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    const derived=await artifact(ctx,p.id,'image/png',Buffer.alloc(png.length+64,1));
    const {zip}=await collected(await createAccountExport(services,ctx,{maxAssetBytes:png.length}));
    const assets=await records(zip,'data/assets.ndjson');assert.equal(assets.find(item=>item.id===source.id).included,true);assert.equal(assets.find(item=>item.id===derived.id).included,false);assert.match(assets.find(item=>item.id===derived.id).omission,/single-file/);
    await assert.rejects(createAccountExport(services,ctx,{maxFiles:1}),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    await assert.rejects(createAccountExport(services,ctx,{maxArchiveBytes:100}),{code:'ACCOUNT_EXPORT_TOO_LARGE'});
  });

  await t.test('foreign storage pointers fail before any blob is read',async()=>{
    const ctx=await owner('bad-pointer'),foreign=await owner('pointer-other'),p=await project(ctx),asset=await uploaded(ctx,p.id);
    await db.query('UPDATE assets SET storage_key=$2 WHERE id=$1',[asset.id,`${foreign.workspaceId}/sources/private.png`]);
    let reads=0;const wrapped=new AppServices(db,config,{...storage,read:async(key)=>{reads++;return storage.read(key);}});
    await assert.rejects(createAccountExport(wrapped,ctx),{code:'ACCOUNT_EXPORT_ASSET_INVALID'});assert.equal(reads,0);
  });

  await t.test('checksum failure rejects the stream, records failure and frees its export lock',async()=>{
    const ctx=await owner('checksum'),p=await project(ctx),asset=await uploaded(ctx,p.id);
    await db.query('UPDATE assets SET sha256=$2 WHERE id=$1',[asset.id,'0'.repeat(64)]);
    const backup=await createAccountExport(services,ctx);
    await assert.rejects(collected(backup),{code:'ACCOUNT_EXPORT_INTEGRITY_FAILED'});await assert.rejects(backup.completion,{code:'ACCOUNT_EXPORT_INTEGRITY_FAILED'});
    assert.deepEqual((await audits(ctx,backup.exportId)).map(item=>item.action),['account.export.failed','account.export.started']);
    await db.query('UPDATE assets SET sha256=$2 WHERE id=$1',[asset.id,hash(png)]);
    await collected(await createAccountExport(services,ctx));
  });

  await t.test('private storage failures expose only safe errors and cannot produce a complete archive',async()=>{
    const ctx=await owner('missing-file'),p=await project(ctx);await uploaded(ctx,p.id);
    const wrapped=new AppServices(db,config,{...storage,read:async()=>{throw new Error('Private path /secret/internal/account.png; provider credential should stay private');}});
    const backup=await createAccountExport(wrapped,ctx);
    await assert.rejects(collected(backup),{code:'ACCOUNT_EXPORT_FAILED'});
    await assert.rejects(backup.completion,(error:any)=>error.code==='ACCOUNT_EXPORT_FAILED'&&!error.message.includes('/secret/'));
    assert.equal((await audits(ctx,backup.exportId)).find(item=>item.action==='account.export.failed')?.metadata.code,'ACCOUNT_EXPORT_FAILED');
    await collected(await createAccountExport(services,ctx));
  });

  await t.test('archive and metadata growth are bounded during generation, not only by file preflight',async()=>{
    const ctx=await owner('stream-limits');await project(ctx,'Some metadata');
    const smallArchive=await createAccountExport(services,ctx,{maxArchiveBytes:600});
    await assert.rejects(collected(smallArchive),{code:'ACCOUNT_EXPORT_TOO_LARGE'});await assert.rejects(smallArchive.completion,{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    const smallMetadata=await createAccountExport(services,ctx,{maxMetadataBytes:1});
    await assert.rejects(collected(smallMetadata),{code:'ACCOUNT_EXPORT_TOO_LARGE'});await assert.rejects(smallMetadata.completion,{code:'ACCOUNT_EXPORT_TOO_LARGE'});
    await collected(await createAccountExport(services,ctx));
  });

  await t.test('client cancellation during a pending private read stops output and releases the database snapshot',async()=>{
    const ctx=await owner('cancel-read'),p=await project(ctx);await uploaded(ctx,p.id);
    const entered=gate(),resume=gate(),controller=new AbortController();
    const wrapped=new AppServices(db,config,{...storage,read:async(key)=>{entered.resolve();await resume.promise;return storage.read(key);}});
    const backup=await createAccountExport(wrapped,ctx,{signal:controller.signal});
    const collecting=collected(backup);void collecting.catch(()=>{});
    await entered.promise;controller.abort();
    await assert.rejects(collecting,{code:'ACCOUNT_EXPORT_CANCELLED'});await assert.rejects(backup.completion,{code:'ACCOUNT_EXPORT_CANCELLED'});
    resume.resolve();await collected(await createAccountExport(services,ctx));
  });

  await t.test('deadline closes an unconsumed snapshot and does not permanently consume an export slot',async()=>{
    const ctx=await owner('timeout');const backup=await createAccountExport(services,ctx,{maxDurationMs:40});
    await assert.rejects(backup.completion,{code:'ACCOUNT_EXPORT_TIMEOUT'});
    assert.equal(backup.stream.destroyed,true);await collected(await createAccountExport(services,ctx));
    const history=await audits(ctx,backup.exportId);assert.equal(history.find(item=>item.action==='account.export.failed')?.metadata.code,'ACCOUNT_EXPORT_TIMEOUT');
  });

  await t.test('cancelled unabortable provider reads keep memory permits until those reads settle',async()=>{
    const first=await owner('pending-one'),second=await owner('pending-two'),third=await owner('pending-three');
    for(const ctx of [first,second,third]){const p=await project(ctx);await uploaded(ctx,p.id);}
    const release=gate(),settled=gate();let count=0,finishedReads=0;
    const block=async(ctx:Context)=>{
      const entered=gate();
      const wrapped=new AppServices(db,config,{...storage,read:async(key)=>{count++;entered.resolve();try{await release.promise;return await storage.read(key);}finally{finishedReads++;if(finishedReads===2)settled.resolve();}}});
      const backup=await createAccountExport(wrapped,ctx),collecting=collected(backup);void collecting.catch(()=>{});
      await entered.promise;backup.cancel();await assert.rejects(collecting,{code:'ACCOUNT_EXPORT_CANCELLED'});await assert.rejects(backup.completion,{code:'ACCOUNT_EXPORT_CANCELLED'});
    };
    try {
      await block(first);await block(second);assert.equal(count,2);
      const blocked=await createAccountExport(services,third);
      await assert.rejects(collected(blocked),{code:'ACCOUNT_EXPORT_BUSY'});await assert.rejects(blocked.completion,{code:'ACCOUNT_EXPORT_BUSY'});
    } finally {release.resolve();}
    // A real asynchronous storage read can finish after the HTTP stream closes.
    // Waiting for its bytes here does not create another provider read permit.
    await settled.promise;
    await collected(await createAccountExport(services,third));
  });

  await t.test('ownership revocation after snapshot creation prevents the remaining asset bytes from being sent',async()=>{
    const ctx=await owner('revoke'),p=await project(ctx);await uploaded(ctx,p.id);
    const backup=await createAccountExport(services,ctx);
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    await assert.rejects(collected(backup),{code:'WORKSPACE_FORBIDDEN'});await assert.rejects(backup.completion,{code:'WORKSPACE_FORBIDDEN'});
  });
});
