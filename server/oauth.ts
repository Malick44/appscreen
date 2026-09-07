import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ALL_SCOPES, hash, type Context } from './auth.js';
import { AppError, invariant } from './errors.js';
import type { AppServices } from './services.js';
import type { PoolClient } from 'pg';

const authorizationId=z.string().regex(/^[a-zA-Z0-9_-]{8,160}$/);
export const AGENT_PERMISSIONS=[
  {scope:'projects:read',label:'Read projects',description:'View campaigns, source screenshots, and saved drafts.',defaultSelected:true},
  {scope:'projects:write',label:'Edit campaigns',description:'Create projects, change drafts, and apply reviewed revisions.',defaultSelected:true},
  {scope:'assets:write',label:'Upload screenshots',description:'Add real screenshots to your workspace.',defaultSelected:true},
  {scope:'exports:write',label:'Render and export',description:'Create previews and downloadable campaign files within your storage limits.',defaultSelected:true},
  {scope:'ai:run',label:'Use hosted AI credits',description:'Start AppScreen AI jobs with an explicitly approved credit limit.',defaultSelected:false},
];

export function checkedOAuthRedirect(value:string,expected?:string) {
  let url:URL;try{url=new URL(value);}catch{throw new AppError('OAUTH_REDIRECT_INVALID','The sign-in service returned an invalid destination.',502);}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  invariant((url.protocol==='https:'||(url.protocol==='http:'&&loopback))&&!url.username&&!url.password&&!url.hash,'OAUTH_REDIRECT_INVALID','The sign-in destination is not secure.',502);
  if(expected){const base=new URL(expected);invariant(base.origin===url.origin&&base.pathname===url.pathname&&[...base.searchParams].every(([key,value])=>url.searchParams.get(key)===value),'OAUTH_REDIRECT_INVALID','The sign-in destination changed. Restart the connection.',502);}
  return url.href;
}

/** Supabase owns OAuth identity, PKCE/code exchange and rotating refresh tokens.
 * This service owns additional user-approved AppScreen workspace permissions.
 * No native session/refresh token is persisted or passed to the MCP client. */
export class OAuthConnections {
  constructor(public services:AppServices,private fetcher:typeof fetch=fetch){}
  requireBrowser(ctx:Context){invariant(this.services.config.mcpOAuthEnabled,'OAUTH_UNAVAILABLE','Agent sign-in has not been configured yet.',503);invariant(ctx.authKind==='web'&&ctx.role==='owner','BROWSER_SESSION_REQUIRED','Sign in to AppScreen as the workspace owner to manage agent access.',403);}
  /** Keep provider handoffs for one user/client serialized even after committing
   * immediate local revocation. An older DELETE must not revoke a newer consent.
   * Never wait indefinitely or consume a second pooled connection for a write. */
  private async clientAction<T>(ctx:Context,clientId:string,work:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.services.db.connect();const key=`appscreen-oauth:${ctx.userId}:${clientId}`;
    let locked=false,discard=false;
    try {
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[key])).rows[0].locked;
      invariant(locked,'OAUTH_CONNECTION_BUSY','Another connection change is still finishing. Wait a moment and try again.',409);
      return await work(client);
    } finally {
      if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>{discard=true;});
      client.release(discard);
    }
  }
  private async atomic<T>(client:PoolClient,work:()=>Promise<T>):Promise<T> {
    await client.query('BEGIN');
    try {const result=await work();await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}
  }
  async provider(token:string,path:string,method='GET',body?:unknown) {
    const config=this.services.config;
    try{
      const response=await this.fetcher(`${config.supabaseUrl}/auth/v1/${path}`,{method,headers:{apikey:config.supabasePublishableKey,Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000),redirect:'error'});
      if(!response.ok)throw new AppError('OAUTH_PROVIDER_REJECTED',response.status===401?'Your sign-in expired. Sign in and restart the agent connection.':'The authorization request could not be completed. Restart the connection from your agent.',response.status>=500?502:400);
      if(response.status===204)return {};
      const reader=response.body?.getReader();if(!reader)return {};const chunks:Uint8Array[]= [];let length=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;invariant(length<=64*1024,'OAUTH_PROVIDER_INVALID','The sign-in response exceeded its limit.',502);chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});}
      return length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('OAUTH_PROVIDER_UNAVAILABLE','The sign-in service could not be reached. Your workspace data is unchanged.',502);}
  }
  async details(ctx:Context,token:string,id:string) {
    this.requireBrowser(ctx);await this.services.assertMembership(ctx);authorizationId.parse(id);
    const data=await this.provider(token,`oauth/authorizations/${encodeURIComponent(id)}`);
    if(typeof data.redirect_url==='string') {
      checkedOAuthRedirect(data.redirect_url);
      // Supabase omits client identity in this response. A callback is not proof
      // of identity, and upstream consent is not fresh workspace permission.
      // Discard this code; require the owner to choose one known connection.
      const known=await this.services.db.query('SELECT id,client_name,version,scopes,expires_at,revoked_at,upstream_revocation_pending FROM oauth_grants WHERE user_id=$1 AND workspace_id=$2 ORDER BY updated_at DESC',[ctx.userId,ctx.workspaceId]);
      return {reconnectRequired:true,reason:'UPSTREAM_CONSENT_REUSED',message:known.rowCount?'The sign-in provider reused an earlier approval without identifying the client. Choose the connection you are reconnecting to clear that approval, then start sign-in again from your agent. No permissions or expiry have been renewed.':'The sign-in provider reused an earlier approval, but this workspace has no matching connection to reset. Ask the operator to remove that specific provider approval, or use a scoped token. No access was granted.',connections:known.rows.map(item=>({id:item.id,name:item.client_name||'Unnamed client',version:item.version,scopes:item.scopes,expiresAt:item.expires_at,revokedAt:item.revoked_at,upstreamRevocationPending:item.upstream_revocation_pending}))};
    }
    const details=z.object({authorization_id:z.string(),redirect_uri:z.string(),client:z.object({id:z.string().uuid(),name:z.string().trim().max(300).optional().transform(name=>name||'Unnamed client')}),user:z.object({id:z.string()}),scope:z.string().max(2000)}).parse(data);
    invariant(details.authorization_id===id&&details.user.id===ctx.userId,'OAUTH_REQUEST_FORBIDDEN','This authorization request belongs to another account.',403);
    const redirectUri=checkedOAuthRedirect(details.redirect_uri),nonce=randomBytes(32).toString('base64url');
    const request=await this.services.db.query(`INSERT INTO oauth_authorization_requests(id,workspace_id,user_id,client_id,client_name,redirect_uri,identity_scopes,consent_nonce_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')
      ON CONFLICT(id) DO UPDATE SET consent_nonce_hash=excluded.consent_nonce_hash,expires_at=excluded.expires_at
      WHERE oauth_authorization_requests.user_id=excluded.user_id AND oauth_authorization_requests.workspace_id=excluded.workspace_id AND oauth_authorization_requests.decided_at IS NULL RETURNING expires_at`,[id,ctx.workspaceId,ctx.userId,details.client.id,details.client.name,redirectUri,details.scope,hash(nonce)]);
    invariant(request.rowCount,'OAUTH_REQUEST_FINISHED','This request was already decided. Restart the connection from your agent.',409);
    const workspace=await this.services.db.query('SELECT id,name FROM workspaces WHERE id=$1',[ctx.workspaceId]);
    return {authorizationId:id,client:details.client,redirectUri,identityScopes:details.scope.split(' ').filter(Boolean),permissions:AGENT_PERMISSIONS,consentNonce:nonce,workspace:workspace.rows[0],expiresAt:request.rows[0].expires_at};
  }
  async consent(ctx:Context,token:string,id:string,args:unknown) {
    this.requireBrowser(ctx);authorizationId.parse(id);
    const input=z.object({consentNonce:z.string().min(32).max(100),action:z.enum(['approve','deny']),scopes:z.array(z.enum(ALL_SCOPES)).max(5).default([]),days:z.number().int().min(1).max(90).default(30)}).strict().parse(args);
    const scopes=[...new Set(input.scopes)].sort();if(input.action==='approve')invariant(scopes.includes('projects:read'),'OAUTH_SCOPE_REQUIRED','Read projects is required for an agent connection.');
    const identity=await this.services.db.query('SELECT client_id FROM oauth_authorization_requests WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[id,ctx.userId,ctx.workspaceId]);
    invariant(identity.rowCount,'OAUTH_CONSENT_EXPIRED','This consent page expired. Restart the connection from your agent.',403);
    return this.clientAction(ctx,identity.rows[0].client_id,async client=>{
    const request=await this.atomic(client,async()=>{
      await this.services.assertMembership(ctx,client);
      const result=await client.query('SELECT * FROM oauth_authorization_requests WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',[id,ctx.userId,ctx.workspaceId]);const item=result.rows[0];
      invariant(item&&new Date(item.expires_at).getTime()>Date.now()&&item.consent_nonce_hash===hash(input.consentNonce),'OAUTH_CONSENT_EXPIRED','This consent page expired. Restart the connection from your agent.',403);
      invariant(!item.decided_at,'OAUTH_REQUEST_FINISHED','This request was already decided. Return to your agent or restart its connection.',409);
      let grantId=null;
      if(input.action==='approve'){
        const prior=await client.query('SELECT upstream_revocation_pending FROM oauth_grants WHERE user_id=$1 AND client_id=$2 FOR UPDATE',[ctx.userId,item.client_id]);
        invariant(!prior.rows[0]?.upstream_revocation_pending,'OAUTH_RECONNECT_PENDING','Finish clearing this connection’s previous approval before approving new access.',409);
        const grant=await client.query(`INSERT INTO oauth_grants(id,workspace_id,user_id,client_id,client_name,scopes,resource,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::integer*interval '1 day'))
          ON CONFLICT(user_id,client_id) DO UPDATE SET workspace_id=excluded.workspace_id,client_name=excluded.client_name,scopes=excluded.scopes,resource=excluded.resource,expires_at=excluded.expires_at,revoked_at=NULL,upstream_revocation_pending=false,version=oauth_grants.version+1,updated_at=now() RETURNING id`,[randomUUID(),ctx.workspaceId,ctx.userId,item.client_id,item.client_name,scopes,this.services.config.mcpResource,input.days]);grantId=grant.rows[0].id;
      }
      await client.query('UPDATE oauth_authorization_requests SET decision=$1,decided_at=now(),grant_id=$2 WHERE id=$3',[input.action,grantId,id]);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ctx.workspaceId,ctx.userId,`oauth.${input.action}`,grantId||id,{clientId:item.client_id,scopes:input.action==='approve'?scopes:[]}]);return item;
    });
    // Record the user's explicit scope decision before Supabase can mint a token.
    // If provider handoff fails, access remains limited to that actual decision;
    // no code/token is fabricated and the client must restart authorization.
    const data=await this.provider(token,`oauth/authorizations/${encodeURIComponent(id)}/consent`,'POST',{action:input.action});
    invariant(typeof data.redirect_url==='string','OAUTH_PROVIDER_INVALID','The sign-in service did not provide a return destination.',502);
    return {redirectUrl:checkedOAuthRedirect(data.redirect_url,request.redirect_uri)};
    });
  }
  async revoke(ctx:Context,token:string,id:string,options:{expectedVersion?:number}={}) {
    invariant(ctx.authKind!=='mcp'&&ctx.role==='owner','BROWSER_SESSION_REQUIRED','Manage agent access from AppScreen.',403);await this.services.assertMembership(ctx);
    const identity=await this.services.db.query('SELECT client_id FROM oauth_grants WHERE id=$1 AND workspace_id=$2 AND user_id=$3',[z.string().uuid().parse(id),ctx.workspaceId,ctx.userId]);
    invariant(identity.rowCount,'CONNECTION_NOT_FOUND','Agent connection not found.',404);
    return this.clientAction(ctx,identity.rows[0].client_id,async client=>{
    const grant=await this.atomic(client,async()=>{
      await this.services.assertMembership(ctx,client);
      const current=await client.query('SELECT * FROM oauth_grants WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE',[id,ctx.workspaceId,ctx.userId]);
      invariant(current.rowCount,'CONNECTION_NOT_FOUND','Agent connection not found.',404);
      invariant(options.expectedVersion===undefined||current.rows[0].version===options.expectedVersion,'OAUTH_CONNECTION_CHANGED','This connection changed. Reload it before reconnecting so newer access is not revoked.',409);
      const changed=await client.query('UPDATE oauth_grants SET revoked_at=now(),version=version+1,upstream_revocation_pending=true,updated_at=now() WHERE id=$1 RETURNING client_id,version',[id]);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ctx.workspaceId,ctx.userId,options.expectedVersion===undefined?'oauth.revoke':'oauth.prepare-reconnect',id,{version:changed.rows[0].version}]);
      return changed.rows[0];
    });
    let upstreamRevocationPending=false;
    if(this.services.config.mcpOAuthEnabled)await this.provider(token,`user/oauth/grants?client_id=${encodeURIComponent(grant.client_id)}`,'DELETE').catch(()=>{upstreamRevocationPending=true;});
    else upstreamRevocationPending=true;
    const saved=await client.query('UPDATE oauth_grants SET upstream_revocation_pending=$1 WHERE id=$2 AND version=$3 AND revoked_at IS NOT NULL RETURNING id',[upstreamRevocationPending,id,grant.version]);
    invariant(saved.rowCount,'OAUTH_CONNECTION_CHANGED','This connection changed while the sign-in provider was responding. Reload its current status.',409);
    return {revoked:true,upstreamRevocationPending,version:grant.version};
    });
  }
  async prepareReconnect(ctx:Context,token:string,id:string,args:unknown) {
    this.requireBrowser(ctx);
    const input=z.object({expectedVersion:z.number().int().min(1),confirmation:z.literal('reconnect')}).strict().parse(args);
    const result=await this.revoke(ctx,token,id,{expectedVersion:input.expectedVersion});
    return {...result,reconnectReady:!result.upstreamRevocationPending,restartRequired:!result.upstreamRevocationPending,message:result.upstreamRevocationPending?'AppScreen access is revoked, but the sign-in provider could not clear its earlier approval. Retry this connection reset before restarting sign-in.':'The earlier approval is cleared. Start sign-in again from your agent and choose permissions on the fresh consent screen. No access has been renewed yet.'};
  }
}
