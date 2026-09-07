import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import sharp from 'sharp';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { checkedOAuthRedirect } from '../oauth.js';

test('OAuth redirects reject executable URLs, credentials, fragments, and changed callbacks',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,hello','http://external.example/callback','https://user:password@example.com/callback','https://example.com/#token','custom-app://callback'])assert.throws(()=>checkedOAuthRedirect(value));
  assert.equal(checkedOAuthRedirect('http://127.0.0.1:1234/callback?code=test'),'http://127.0.0.1:1234/callback?code=test');
  assert.throws(()=>checkedOAuthRedirect('https://other.example/callback','https://example.com/callback'));
  assert.throws(()=>checkedOAuthRedirect('https://example.com/other','https://example.com/callback'));
  assert.throws(()=>checkedOAuthRedirect('https://example.com/callback?fixed=changed','https://example.com/callback?fixed=expected'));
});

const databaseUrl=process.env.TEST_DATABASE_URL;
test('Supabase OAuth adapter, signed JWT boundaries, consent and brief persistence',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!);await migrate(db);
  const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'isolated-oauth-test',alg:'RS256'};
  const ownerId=randomUUID(),strangerId=randomUUID(),clientId=randomUUID();
  const requests=new Map<string,any>();let providerFailure=false;
  // An isolated fake identity provider, not a proof of a real Supabase PKCE flow.
  const provider=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/auth/v1/.well-known/jwks.json'){res.end(JSON.stringify({keys:[jwk]}));return;}
    const match=req.url?.match(/^\/auth\/v1\/oauth\/authorizations\/([a-zA-Z0-9_-]+)(\/consent)?$/);
    if(match){const details=requests.get(match[1]);if(!details){res.statusCode=404;res.end('{}');return;}
      if(providerFailure){res.statusCode=503;res.end('{}');return;}
      if(match[2]){let raw='';for await(const chunk of req)raw+=chunk;const action=JSON.parse(raw).action;res.end(JSON.stringify({redirect_url:details.redirect_uri+(action==='approve'?'?code=one-use-placeholder&state=client-state':'?error=access_denied&state=client-state')}));return;}
      res.end(JSON.stringify(details));return;
    }
    if(req.url?.startsWith('/auth/v1/user/oauth/grants')){res.statusCode=providerFailure?503:204;res.end();return;}
    res.statusCode=404;res.end('{}');
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const port=(provider.address() as any).port;
  const issuer=`http://127.0.0.1:${port}/auth/v1`;
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,SUPABASE_URL:`http://127.0.0.1:${port}`,SUPABASE_PUBLISHABLE_KEY:'public-isolated-test-key',APPSCREEN_MCP_OAUTH:'true',APP_BASE_URL:'http://127.0.0.1:8001',APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APPSCREEN_STORAGE_PATH:await mkdtemp(join(tmpdir(),'appscreen-oauth-test-'))});
  const {app,auth,services}=await createApp(config,db);await app.ready();
  t.after(async()=>{await app.close();await db.end();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));});
  const sign=async(claims:any={})=>new SignJWT({email:'oauth-test@example.test',...claims}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject(claims.sub||ownerId).setIssuer(issuer).setAudience(claims.aud||'authenticated').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const ownerToken=await sign(),strangerToken=await sign({sub:strangerId});
  const request=(method:any,path:string,token=ownerToken,payload?:any,headers:Record<string,string>={})=>app.inject({method,url:path,headers:{authorization:`Bearer ${token}`,...headers},...(payload!==undefined?{payload}:{})});
  const checked=async(method:any,path:string,token=ownerToken,payload?:any)=>{const result=await request(method,path,token,payload);assert.equal(result.statusCode,200,result.body);return result.json();};
  const session=await checked('GET','/api/session');await checked('GET','/api/session',strangerToken);
  const ctx=await auth.resolveContext(ownerId,'oauth-test@example.test',session.workspace.id,'web',['projects:read','projects:write','assets:write','exports:write','ai:run']);
  const {project}=await checked('POST','/api/projects',ownerToken,{name:'OAuth isolation fixture'});
  const bytes=await sharp({create:{width:320,height:640,channels:3,background:'#445588'}}).png().toBuffer();
  await services.uploadAsset(ctx,project.id,'fixture.png',bytes);
  let grant:any,agentToken:string,agentMedia:string;
  const freshRequest=(extra:any={})=>{const id=`request_${randomUUID()}`;requests.set(id,{authorization_id:id,redirect_uri:'http://127.0.0.1:4567/callback',client:{id:clientId,name:'Example agent <not HTML>'},user:{id:ownerId},scope:'openid',...extra});return id;};

  await t.test('partial brief autosave is durable and only one concurrent writer wins',async()=>{
    const inputs=['First','Second'].map(promise=>({brief:{appName:'',promise,confirmedFacts:[],brandColors:[]},designPreferences:{templateId:'tidal-relay',templateMode:'inspiration',screenCount:5,locks:{positions:true}},expectedUpdatedAt:project.updatedAt}));
    const saves=await Promise.all(inputs.map(input=>request('PATCH',`/api/projects/${project.id}`,ownerToken,input)));
    assert.deepEqual(saves.map(result=>result.statusCode).sort(),[200,409]);
    const saved=saves.find(result=>result.statusCode===200)!.json().project;
    const reloaded=(await checked('GET',`/api/projects/${project.id}`)).project;
    assert.equal(reloaded.brief.promise,saved.brief.promise);assert.equal(reloaded.designPreferences.locks.positions,true);
    assert.notEqual(saved.updatedAt,project.updatedAt);
  });
  await t.test('OAuth is never interpreted as browser-owner access, even with the normal Supabase audience',async()=>{
    const token=await sign({client_id:clientId});
    assert.equal((await request('POST','/api/connections',token,{name:'Escalate',scopes:['projects:read']})).statusCode,401);
    assert.equal((await request('GET','/api/session',token)).statusCode,401);
    const missing=await sign({client_id:clientId,aud:config.mcpResource});
    assert.equal((await request('GET','/api/projects',missing)).statusCode,401);
  });
  await t.test('consent requires the owner, correct request identity, nonce, and origin',async()=>{
    const id=freshRequest();assert.equal((await request('GET',`/api/oauth/authorizations/${id}`,strangerToken)).statusCode,403);
    const details=await checked('GET',`/api/oauth/authorizations/${id}`);
    assert.equal(details.client.name,'Example agent <not HTML>');assert.equal(details.permissions.find((p:any)=>p.scope==='ai:run').defaultSelected,false);
    const input={consentNonce:details.consentNonce,action:'approve',scopes:['projects:read','exports:write'],days:30};
    assert.equal((await request('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,{...input,consentNonce:'a'.repeat(43)})).statusCode,403);
    assert.equal((await request('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,input,{origin:'https://attacker.example'})).statusCode,403);
    const result=await checked('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,input);
    assert.match(result.redirectUrl,/^http:\/\/127\.0\.0\.1:4567\/callback\?code=/);
    grant=(await db.query('SELECT * FROM oauth_grants WHERE user_id=$1 AND client_id=$2',[ownerId,clientId])).rows[0];
    assert.deepEqual(grant.scopes,['exports:write','projects:read']);assert.equal(grant.workspace_id,session.workspace.id);
    assert.equal((await request('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,input)).statusCode,409);
  });
  await t.test('the Supabase hook binds OAuth tokens to the resource, grant version and selected workspace',async()=>{
    const normal={sub:ownerId,aud:'authenticated',role:'authenticated'};
    assert.deepEqual((await db.query('SELECT public.appscreen_access_token_hook($1::jsonb) AS result',[{user_id:ownerId,claims:normal}])).rows[0].result,{claims:normal});
    const result=(await db.query('SELECT public.appscreen_access_token_hook($1::jsonb) AS result',[{user_id:ownerId,claims:{...normal,client_id:clientId}}])).rows[0].result;
    assert.equal(result.claims.aud,config.mcpResource);assert.equal(result.claims.appscreen_grant_id,grant.id);assert.deepEqual(result.claims.appscreen_scopes,grant.scopes);
    const unknown=(await db.query('SELECT public.appscreen_access_token_hook($1::jsonb) AS result',[{user_id:strangerId,claims:{...normal,sub:strangerId,client_id:clientId}}])).rows[0].result;assert.equal(unknown.error.http_code,403);
    agentToken=await sign(result.claims);
    const response=await checked('GET',`/api/projects/${project.id}`,agentToken);agentMedia=response.assets[0].url;
    assert.equal((await request('GET','/api/session',agentToken)).statusCode,403);
    assert.equal((await request('POST','/api/billing/checkout',agentToken,{planId:'pro'})).statusCode,403);
    assert.equal((await request('POST','/api/connections',agentToken,{name:'Escalate',scopes:['projects:read']})).statusCode,403);
    assert.equal((await request('POST','/api/projects',agentToken,{name:'Not allowed'})).statusCode,403);
    const excessive=await sign({...result.claims,appscreen_scopes:[...grant.scopes,'ai:run']});assert.equal((await request('GET','/api/projects',excessive)).statusCode,401);
    const wrongWorkspace=await sign({...result.claims,appscreen_workspace_id:randomUUID()});assert.equal((await request('GET','/api/projects',wrongWorkspace)).statusCode,401);
    const wrongVersion=await sign({...result.claims,appscreen_grant_version:grant.version+1});assert.equal((await request('GET','/api/projects',wrongVersion)).statusCode,401);
  });
  await t.test('discovery points to the configured Supabase issuer without claiming custom identity scopes',async()=>{
    const response=await app.inject({method:'GET',url:'/.well-known/oauth-protected-resource/mcp'});const metadata=response.json();
    assert.equal(metadata.resource,config.mcpResource);assert.deepEqual(metadata.authorization_servers,[issuer]);assert.deepEqual(metadata.scopes_supported,['openid']);
  });
  await t.test('revocation denies JWTs and existing agent download links even if the upstream service is down',async()=>{
    providerFailure=true;const revoked=await checked('DELETE',`/api/connections/${grant.id}`);assert.equal(revoked.upstreamRevocationPending,true);
    assert.equal((await request('GET','/api/projects',agentToken)).statusCode,401);
    const media=new URL(agentMedia);assert.equal((await app.inject({method:'GET',url:media.pathname+media.search})).statusCode,403);
    const connections=await checked('GET','/api/connections');assert.equal(connections.connections.find((c:any)=>c.id===grant.id).upstreamRevocationPending,true);
    providerFailure=false;assert.equal((await checked('DELETE',`/api/connections/${grant.id}`)).upstreamRevocationPending,false);
  });
  await t.test('deny never creates a new grant, and unsafe callback data cannot redirect the browser',async()=>{
    const other=randomUUID(),id=freshRequest({client:{id:other,name:'Denied client'}});
    const details=await checked('GET',`/api/oauth/authorizations/${id}`);
    const denied=await checked('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,{consentNonce:details.consentNonce,action:'deny',scopes:[]});assert.match(denied.redirectUrl,/error=access_denied/);
    assert.equal((await db.query('SELECT id FROM oauth_grants WHERE user_id=$1 AND client_id=$2',[ownerId,other])).rowCount,0);
    const bad=freshRequest({redirect_uri:'javascript:alert(1)'});assert.equal((await request('GET',`/api/oauth/authorizations/${bad}`)).statusCode,502);
  });
  await t.test('the reconnect HTTP endpoint enforces origin, ownership, confirmation and current version',async()=>{
    const other=randomUUID(),id=freshRequest({client:{id:other}});
    const details=await checked('GET',`/api/oauth/authorizations/${id}`);assert.equal(details.client.name,'Unnamed client');
    await checked('POST',`/api/oauth/authorizations/${id}/consent`,ownerToken,{consentNonce:details.consentNonce,action:'approve',scopes:['projects:read']});
    const current=(await db.query('SELECT * FROM oauth_grants WHERE user_id=$1 AND client_id=$2',[ownerId,other])).rows[0];
    const listed=(await checked('GET','/api/connections')).connections.find((connection:any)=>connection.id===current.id);
    assert.equal(listed.version,current.version);
    const payload={expectedVersion:current.version,confirmation:'reconnect'},path=`/api/connections/${current.id}/reconnect`;
    assert.equal((await request('POST',path,ownerToken,payload,{origin:'https://attacker.example'})).statusCode,403);
    assert.equal((await request('POST',path,strangerToken,payload)).statusCode,404);
    assert.equal((await request('POST',path,ownerToken,{expectedVersion:current.version})).statusCode,400);
    assert.equal((await request('POST',path,ownerToken,{...payload,expectedVersion:current.version+1})).statusCode,409);
    const result=await checked('POST',path,ownerToken,payload);
    assert.equal(result.reconnectReady,true);assert.equal(result.restartRequired,true);assert.equal(result.version,current.version+1);
    const reloaded=(await checked('GET','/api/connections')).connections.find((connection:any)=>connection.id===current.id);
    assert.equal(reloaded.version,result.version);assert.ok(reloaded.revokedAt);
    assert.equal((await request('POST',path,ownerToken,payload)).statusCode,409);
  });
});
