import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { type Config, rootDirectory } from './config.js';
import { type DB, row, transaction } from './db.js';
import { createAuth, hash, requireScope, type Context } from './auth.js';
import { createStorage } from './storage.js';
import { AppServices } from './services.js';
import { Billing } from './billing.js';
import { invariant } from './errors.js';
import { registerMcp } from './mcp/index.mjs';
import { templatePreview } from './template-preview.js';
import { OAuthConnections } from './oauth.js';
import { Operations } from './operator.js';
import { createAccountExport } from './account-export.js';
import { AccountLifecycle } from './account-lifecycle.js';
import { ProductMetrics } from './product-metrics.js';
import { SupportCases } from './support.js';
import { Notifications,enqueueNotification } from './notifications.js';
import { EmailDelivery } from './email.js';
import { EmailIncidents } from './email-incidents.js';
import { importProjectBackup, PROJECT_IMPORT_LIMITS } from './project-import.js';

const publicFiles=new Set(['app.js','styles.css','ui-redesign.css','three-renderer.js','language-utils.js','magical-titles.js','llm.js','ai-image-gen.js','lucide-icons.js','templates.js','favicon.ico']);
function publicResource(path:string):string|null {
  if(path==='/saas/vendor/supabase.js')return 'node_modules/@supabase/supabase-js/dist/umd/supabase.js';
  if(path==='/third-party/supabase-license.txt')return 'node_modules/@supabase/supabase-js/LICENSE';
  if(path==='/editor'||path==='/editor/'||path==='/index.html')return 'index.html';
  if(path==='/'||/^\/(app|auth|oauth|login|signup|recover|reset-password|pricing|help|privacy|terms|third-party-notices)(\/|$)/.test(path))return 'saas/index.html';
  const relative=path.slice(1);
  if(!(publicFiles.has(relative)||/^(saas|core|render|img|models)\/[a-zA-Z0-9_./ -]+$/.test(relative)))return null;
  if(relative.split('/').some(p=>p.startsWith('.')||p==='tests'||p==='__tests__')||/\.(test|spec)\./.test(relative))return null;
  return relative;
}

export async function createApp(config:Config,db:DB){
  const app=Fastify({logger:false,bodyLimit:3*1024*1024,trustProxy:false});
  await app.register(rateLimit,{max:180,timeWindow:'1 minute',allowList:request=>{
    // App documents/modules must remain loadable after API throttling. Match
    // the actual public fallback route and its serving allowlist, not a caller
    // header or a prefix that could exempt an API/MCP request.
    if(!['GET','HEAD'].includes(request.method)||request.routeOptions.url!=='/*')return false;
    try{return publicResource(decodeURIComponent(request.url.split('?')[0]))!==null;}catch{return false;}
  }});
  await app.register(multipart,{limits:{fileSize:config.uploadLimit,files:1,fields:5}});
  app.addContentTypeParser(['image/png','image/jpeg','application/octet-stream'],{parseAs:'buffer',bodyLimit:config.uploadLimit},(_req,body,done)=>done(null,body));
  app.addHook('onSend',async(_req,reply)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','SAMEORIGIN');if(config.production)reply.header('Strict-Transport-Security','max-age=31536000');});
  app.setErrorHandler((error:any,_request,reply)=>{
    const status=error instanceof z.ZodError?400:error.statusCode||error.status||500;
    const code=error instanceof z.ZodError?'INVALID_INPUT':(/^[A-Z_]{2,60}$/.test(error.code||'')?error.code:'REQUEST_FAILED');
    const message=status>=500&&code==='REQUEST_FAILED'?'The service could not complete this request. Try again or contact support.':error instanceof z.ZodError?'Check the highlighted input values.':error.message;
    reply.code(status).send({error:{code,message,details:error instanceof z.ZodError?error.issues.map(i=>({path:i.path,message:i.message})):error.details}});
  });
  const auth=createAuth(db,config),services=new AppServices(db,config,createStorage(config)),billing=new Billing(services),oauth=new OAuthConnections(services),operations=new Operations(services),accountLifecycle=new AccountLifecycle(services);
  const notifications=new Notifications(services),email=new EmailDelivery(services),support=new SupportCases(services,{onStaffReply:(client,input)=>enqueueNotification(client,{kind:'support-reply',...input},{emailEnabled:config.emailEnabled})});
  const ctx=(req:any)=>auth.authenticate(req);const body=(req:any)=>req.body||{};const p=(req:any)=>req.params as any;
  const sameOrigin=(req:any)=>invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to perform this action.',403);
  app.get('/api/config',async()=>({auth:{provider:config.developmentAuth?'development':'supabase',url:config.supabaseUrl,publishableKey:config.supabasePublishableKey},billingEnabled:config.enableBilling,aiEnabled:config.allowLiveAI&&!!config.openaiKey,plans:[{id:'pro',name:'Pro',priceAmount:config.priceAmount,currency:config.currency,interval:'month',credits:config.monthlyCredits,available:config.enableBilling}],trial:{credits:config.trialCredits},pricing:{designCredits:config.designCredits,revisionCredits:config.revisionCredits},limits:{maxUploadBytes:config.uploadLimit,maxSourceImages:10},mcp:{url:config.mcpResource,authentication:config.mcpOAuthEnabled?'oauth_or_token':'token',oauthEnabled:config.mcpOAuthEnabled}}));
  app.get('/health',async()=>{await db.query('SELECT 1');return {status:'ok'};});
  app.post('/api/dev/session',async req=>auth.developmentSession(z.string().email().parse(body(req).email)));
  app.get('/api/session',async req=>services.session(await ctx(req)));
  app.get('/api/usage',async req=>{const context=await ctx(req);const session=await services.session(context);const usage=await db.query('SELECT amount,reason,created_at FROM credit_ledger WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[context.workspaceId]);return {...session,events:usage.rows.map(r=>row(r))};});
  app.get('/api/operator/overview',async req=>operations.overview(await ctx(req)));
  app.get('/api/operator/report',async req=>new ProductMetrics(services).report(await ctx(req),req.query));
  app.get('/api/operator/jobs/:id',async req=>operations.job(await ctx(req),p(req).id));
  app.post('/api/operator/credits',{config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async req=>{invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to confirm this adjustment.',403);return operations.adjustCredits(await ctx(req),body(req));});
  app.get('/api/projects',async req=>services.listProjects(await ctx(req)));
  app.post('/api/projects',async req=>services.createProject(await ctx(req),body(req)));
  let activeProjectImports=0;
  app.post('/api/projects/import',{bodyLimit:PROJECT_IMPORT_LIMITS.compressedBytes+4096,config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async req=>{
    sameOrigin(req);const context=await ctx(req);requireScope(context,'projects:write');requireScope(context,'assets:write');await services.assertMembership(context);
    invariant(activeProjectImports<2,'IMPORT_BUSY','Two backups are already being imported. Wait a moment, then retry this same backup.',503);
    activeProjectImports++;
    try {
    const fields:Record<string,string>={};let bytes:Buffer|undefined;
    for await(const part of req.parts({limits:{fileSize:PROJECT_IMPORT_LIMITS.compressedBytes,files:1,fields:4,parts:5,fieldSize:1024}})){
      if(part.type==='file'){invariant(part.fieldname==='file'&&!bytes,'INVALID_PROJECT_BACKUP','Choose one editable AppScreen backup ZIP.');bytes=await part.toBuffer();invariant(!part.file.truncated,'IMPORT_SIZE','Editable backups must be 100 MB or smaller.',413);}
      else {invariant(['idempotencyKey','name','expectedWorkspaceId','expectedUserId'].includes(part.fieldname)&&!Object.hasOwn(fields,part.fieldname)&&!part.valueTruncated,'INVALID_INPUT','The backup form contains an invalid or repeated field.');fields[part.fieldname]=z.string().parse(part.value);}
    }
    invariant(bytes,'INVALID_PROJECT_BACKUP','Choose an editable AppScreen backup ZIP.');
    const expectedWorkspaceId=z.string().uuid().parse(fields.expectedWorkspaceId),expectedUserId=z.string().min(1).max(200).parse(fields.expectedUserId);
    invariant(expectedWorkspaceId===context.workspaceId&&expectedUserId===context.userId,'IMPORT_ACCOUNT_CHANGED','Your account changed while choosing this backup. Reopen Import backup in the intended account.',409);
    invariant(!req.raw.aborted,'IMPORT_ABORTED','The backup upload was interrupted. Retry the same backup.');
    return await importProjectBackup(services,context,{bytes,idempotencyKey:fields.idempotencyKey,name:fields.name});
    } finally {activeProjectImports--;}
  });
  app.get('/api/projects/:id',async req=>services.getProject(await ctx(req),{projectId:p(req).id}));
  app.patch('/api/projects/:id',async req=>services.updateProject(await ctx(req),p(req).id,body(req)));
  app.post('/api/projects/:id/drafts',async req=>services.createDraft(await ctx(req),{...body(req),projectId:p(req).id}));
  app.get('/api/projects/:id/revisions/:revisionId',async req=>({revision:await services.getRevision(await ctx(req),p(req).id,p(req).revisionId)}));
  app.post('/api/projects/:id/revisions',async req=>{const context=await ctx(req);const args=z.object({document:z.record(z.string(),z.unknown()),expectedRevisionId:z.string().uuid().nullable(),apply:z.boolean().default(false),label:z.string().max(120).optional(),idempotencyKey:z.string().min(8).max(200).optional()}).parse(body(req));return services.saveRevision(context,p(req).id,args,{allowLockChanges:context.authKind!=='mcp'});});
  app.post('/api/projects/:id/revisions/:revisionId/apply',async req=>services.applyRevision(await ctx(req),{projectId:p(req).id,revisionId:p(req).revisionId,expectedRevisionId:body(req).expectedRevisionId??null,idempotencyKey:body(req).idempotencyKey}));
  app.post('/api/projects/:id/operations',async req=>services.applyOperations(await ctx(req),{...body(req),projectId:p(req).id}));
  app.post('/api/projects/:id/assets',async req=>{const context=await ctx(req);const file=await req.file();invariant(file,'FILE_REQUIRED','Choose a screenshot to upload.');const bytes=await file.toBuffer();invariant(!file.file.truncated,'UPLOAD_SIZE','Image exceeds the upload limit.',413);return services.uploadAsset(context,p(req).id,file.filename,bytes);});
  app.post('/api/projects/:id/upload-ticket',async req=>services.requestAssetUpload(await ctx(req),{...body(req),projectId:p(req).id}));
  app.post('/api/uploads/:id',{bodyLimit:config.uploadLimit},async req=>{
    const token=z.string().min(20).parse((req.query as any).token);invariant(Buffer.isBuffer(req.body),'INVALID_IMAGE','Send PNG or JPEG bytes.');const bytes=req.body as Buffer;
    return transaction(db,async client=>{
      const result=await client.query('SELECT * FROM upload_tickets WHERE id=$1 AND token_hash=$2 AND expires_at>now() FOR UPDATE',[p(req).id,hash(token)]);invariant(result.rowCount,'UPLOAD_EXPIRED','This upload link expired.',403);const ticket=result.rows[0];
      const context={...await auth.resolveContext(ticket.user_id,'',ticket.workspace_id,'mcp',['assets:write']),...(ticket.metadata.connection?{connection:ticket.metadata.connection}:{})};await services.assertMembership(context,client);
      invariant(!ticket.metadata.byteLength||ticket.metadata.byteLength===bytes.length,'UPLOAD_MISMATCH','Image size does not match the authorized upload.');
      invariant(!ticket.metadata.checksum||ticket.metadata.checksum===hash(bytes),'UPLOAD_MISMATCH','Image checksum does not match the authorized upload.');
      const prior=await client.query('SELECT * FROM assets WHERE id=$1 AND workspace_id=$2 AND project_id=$3',[ticket.id,ticket.workspace_id,ticket.project_id]);
      let uploaded;
      if(prior.rowCount){invariant(prior.rows[0].sha256===hash(bytes),'UPLOAD_MISMATCH','This upload was already completed with different bytes.',409);uploaded={asset:(await services.serializeAssets(context,prior.rows))[0]};}
      else uploaded=await services.uploadAsset(context,ticket.project_id,ticket.name,bytes,ticket.id);
      await client.query('UPDATE upload_tickets SET used_at=now() WHERE id=$1',[ticket.id]);return uploaded;
    });
  });
  app.get('/api/media/:id',async(req,reply)=>{const a=await services.authorizeMedia(p(req).id,z.string().parse((req.query as any).token));const bytes=await services.storage.read(a.storage_key);reply.header('Cache-Control','private, no-store').type(a.mime_type);if(!a.mime_type.startsWith('image/'))reply.header('Content-Disposition',`attachment; filename="${a.name.replace(/["\r\n]/g,'_')}"`);return reply.send(bytes);});
  app.get('/api/templates',async()=>services.listTemplates({} as Context));
  app.get('/api/templates/:id/preview',async(req,reply)=>reply.type('image/svg+xml').header('Cache-Control','public, max-age=300').send(templatePreview(p(req).id)));
  for(const [path,kind] of [['design-jobs','design'],['revision-jobs','revision'],['export-jobs','export']] as const)app.post(`/api/projects/:id/${path}`,async req=>services.createJob(await ctx(req),{...body(req),kind,projectId:p(req).id}));
  app.get('/api/jobs/:id',async req=>services.getJob(await ctx(req),{jobId:p(req).id}));
  app.post('/api/jobs/:id/cancel',async req=>services.cancelJob(await ctx(req),{jobId:p(req).id}));
  app.post('/api/jobs/:id/retry',async req=>services.retryJob(await ctx(req),{...body(req),jobId:p(req).id}));
  app.get('/api/jobs/:id/events',async(req,reply)=>{
    const context=await ctx(req);await services.getJob(context,{jobId:p(req).id});let cursor=Number(req.headers['last-event-id']||(req.query as any).after||0);invariant(Number.isSafeInteger(cursor)&&cursor>=0,'INVALID_CURSOR','Invalid event position.');
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});let busy=false;
    const timer=setInterval(async()=>{if(busy)return;busy=true;try{await services.assertMembership(context);const events=await db.query('SELECT id,event FROM job_events WHERE job_id=$1 AND workspace_id=$2 AND id>$3 ORDER BY id LIMIT 100',[p(req).id,context.workspaceId,cursor]);for(const e of events.rows){reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e.event)}\n\n`);cursor=Number(e.id);}if(!events.rowCount)reply.raw.write(': keepalive\n\n');}catch{clearInterval(timer);reply.raw.end();}finally{busy=false;}},1000);reply.raw.on('close',()=>clearInterval(timer));
  });
  app.post('/api/billing/checkout',async req=>billing.checkout(await ctx(req),body(req)));
  app.post('/api/billing/portal',async req=>billing.portal(await ctx(req)));
  await app.register(async scoped=>{scoped.removeContentTypeParser('application/json');scoped.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,data,done)=>done(null,data));scoped.post('/api/billing/webhook',async req=>billing.receive(req.body as Buffer,z.string().parse(req.headers['stripe-signature'])));});
  app.get('/api/connections',async req=>{const c=await ctx(req);invariant(c.authKind!=='mcp','FORBIDDEN','Manage connections in AppScreen.',403);const r=await db.query(`SELECT id,name,scopes,expires_at,revoked_at,created_at,'token' AS type,false AS upstream_revocation_pending,NULL::integer AS version FROM api_tokens WHERE workspace_id=$1 AND user_id=$2 UNION ALL SELECT id,client_name AS name,scopes,expires_at,revoked_at,created_at,'oauth' AS type,upstream_revocation_pending,version FROM oauth_grants WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC`,[c.workspaceId,c.userId]);return {connections:r.rows.map(r=>row(r))};});
  app.post('/api/connections',async req=>{const c=await ctx(req);const args=z.object({name:z.string().min(1).max(80),scopes:z.array(z.string()),days:z.number().int().min(1).max(90).default(30)}).parse(body(req));const token=await auth.issueToken(c,args.name,args.scopes,args.days);await services.audit(c,'connection.create',token.id);return token;});
  app.delete('/api/connections/:id',async req=>{const c=await ctx(req);invariant(c.authKind!=='mcp','FORBIDDEN','Manage connections in AppScreen.',403);const grant=await db.query('SELECT id FROM oauth_grants WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[z.string().uuid().parse(p(req).id),c.userId,c.workspaceId]);if(grant.rowCount)return oauth.revoke(c,req.headers.authorization!.slice(7),p(req).id);await db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[p(req).id,c.userId,c.workspaceId]);await services.audit(c,'connection.revoke',p(req).id);return {revoked:true};});
  app.get('/api/oauth/authorizations/:authorizationId',async req=>oauth.details(await ctx(req),req.headers.authorization!.slice(7),p(req).authorizationId));
  app.post('/api/connections/:id/reconnect',async req=>{invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to reset this connection.',403);return oauth.prepareReconnect(await ctx(req),req.headers.authorization!.slice(7),p(req).id,body(req));});
  app.post('/api/oauth/authorizations/:authorizationId/consent',async req=>{invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to approve this connection.',403);return oauth.consent(await ctx(req),req.headers.authorization!.slice(7),p(req).authorizationId,body(req));});
  app.get('/api/account/deletion-request',async req=>accountLifecycle.deletionStatus(await ctx(req)));
  app.post('/api/account/deletion-request',async req=>{invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to manage your account.',403);return accountLifecycle.requestDeletion(await ctx(req),body(req));});
  app.post('/api/account/deletion-request/cancel',async req=>{invariant(!req.headers.origin||req.headers.origin===new URL(config.baseUrl).origin,'ORIGIN_FORBIDDEN','Return to AppScreen to manage your account.',403);return accountLifecycle.cancelDeletion(await ctx(req),body(req));});
  app.post('/api/support',{config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async req=>{sameOrigin(req);return accountLifecycle.requestSupport(await ctx(req),body(req));});
  app.get('/api/support',async req=>support.customerList(await ctx(req),req.query));
  app.get('/api/support/:id',async req=>support.customerDetail(await ctx(req),p(req).id));
  app.post('/api/support/:id/replies',{config:{rateLimit:{max:40,timeWindow:'15 minutes'}}},async req=>{sameOrigin(req);return support.customerFollowUp(await ctx(req),p(req).id,body(req));});
  app.get('/api/operator/support',async req=>support.operatorList(await ctx(req),req.query));
  app.post('/api/operator/support/:id/view',async req=>{sameOrigin(req);return support.operatorDetail(await ctx(req),p(req).id,body(req));});
  app.post('/api/operator/support/:id/replies',{config:{rateLimit:{max:60,timeWindow:'15 minutes'}}},async req=>{sameOrigin(req);return support.operatorReply(await ctx(req),p(req).id,body(req));});
  app.post('/api/operator/support/:id/status',{config:{rateLimit:{max:60,timeWindow:'15 minutes'}}},async req=>{sameOrigin(req);return support.operatorTransition(await ctx(req),p(req).id,body(req));});
  app.get('/api/notifications',async req=>{
    const context=await ctx(req);const args=z.object({limit:z.coerce.number().int().min(1).max(50).optional(),cursor:z.string().max(1000).optional(),unreadOnly:z.enum(['true','false']).transform(value=>value==='true').optional()}).strict().parse(req.query);
    return notifications.list(context,args);
  });
  app.get('/api/notifications/unread-count',async req=>notifications.unreadCount(await ctx(req)));
  app.post('/api/notifications/read',async req=>{sameOrigin(req);return notifications.markRead(await ctx(req),body(req));});
  app.get('/api/notifications/email-preferences',async req=>email.preferences(await ctx(req)));
  app.post('/api/notifications/email-preferences',async req=>{sameOrigin(req);return email.savePreferences(await ctx(req),body(req));});
  app.get('/api/operator/email',async req=>email.report(await ctx(req)));
  const emailIncidents=new EmailIncidents(services);
  app.get('/api/operator/email/incidents',async(req,reply)=>{reply.header('Cache-Control','private, no-store');return emailIncidents.list(await ctx(req),req.query);});
  app.post('/api/operator/email/incidents/:id/review',{config:{rateLimit:{max:60,timeWindow:'15 minutes'}}},async(req,reply)=>{sameOrigin(req);reply.header('Cache-Control','private, no-store');return emailIncidents.review(await ctx(req),p(req).id,body(req));});
  // An encapsulated parser preserves the exact signed bytes without changing
  // ordinary JSON API parsing. Verified events still work while sending is off.
  await app.register(async route=>{
    route.removeContentTypeParser('application/json');
    route.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:128*1024},(_req,raw,done)=>done(null,raw));
    route.post('/api/webhooks/email',{bodyLimit:128*1024,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async req=>email.webhook(req.body as Buffer,req.headers));
  });
  app.get('/api/account/export',async(req,reply)=>{
    const c=await ctx(req),controller=new AbortController();let archive:Awaited<ReturnType<typeof createAccountExport>>|undefined;
    const disconnected=()=>{if(!reply.raw.writableFinished&&!reply.raw.finished&&!archive?.stream.readableEnded)controller.abort();};
    req.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    try {
      const backup=await createAccountExport(services,c,{signal:controller.signal});archive=backup;
      void backup.completion.catch(error=>console.error(`AppScreen account backup ${backup.exportId} stopped (${error.code||'ACCOUNT_EXPORT_FAILED'}).`)).finally(()=>{req.raw.removeListener('aborted',disconnected);reply.raw.removeListener('close',disconnected);});
      return reply.header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="${backup.filename}"`).header('X-AppScreen-Export-ID',backup.exportId).type(backup.contentType).send(backup.stream);
    } catch(error) {req.raw.removeListener('aborted',disconnected);reply.raw.removeListener('close',disconnected);throw error;}
  });
  await registerMcp(app,services,auth.authenticate,{baseUrl:config.baseUrl,authorizationServers:config.mcpOAuthEnabled?[`${config.supabaseUrl}/auth/v1`]:[],oauthScopes:config.mcpOAuthEnabled?['openid']:undefined});
  const types:Record<string,string>={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',txt:'text/plain; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',woff2:'font/woff2',glb:'model/gltf-binary',json:'application/json'};
  app.get('/*',async(req,reply)=>{
    const path=decodeURIComponent(req.url.split('?')[0]),relative=publicResource(path);invariant(relative,'NOT_FOUND','Page not found.',404);
    const filename=resolve(rootDirectory,relative);invariant(filename.startsWith(rootDirectory+sep),'NOT_FOUND','Page not found.',404);const bytes=await readFile(filename).catch(()=>null);invariant(bytes,'NOT_FOUND','Page not found.',404);
    if(path==='/saas/vendor/supabase.js')reply.header('Link','</third-party/supabase-license.txt>; rel="license"');
    reply.type(path==='/third-party/supabase-license.txt'?'text/plain; charset=utf-8':types[filename.split('.').pop()||'']||'application/octet-stream').header('Cache-Control',filename.endsWith('.html')?'no-store':'no-cache');return reply.send(bytes);
  });
  return {app,services,auth,billing,oauth,operations,accountLifecycle,support,notifications,email};
}
