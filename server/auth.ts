import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { transaction, type DB } from './db.js';
import { AppError, invariant } from './errors.js';
import { recordMilestone } from './product-metrics.js';
import { verifyAuthServerToken } from './auth-server.js';

export const ALL_SCOPES = ['projects:read','projects:write','assets:write','exports:write','ai:run'] as const;
export type Context = { userId: string; workspaceId: string; email: string; role: string; scopes: string[]; authKind: 'web'|'development'|'mcp'; assuranceLevel?:'aal1'|'aal2'; connection?:{kind:'token'|'oauth';id:string;version?:number} };
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function createAuth(db: DB, config: Config) {
  const signingKey = new TextEncoder().encode(config.signingSecret);
  const jwks = config.supabaseUrl && config.supabaseAuthVerification !== 'auth-server' ? createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`)) : null;
  async function ensureWorkspace(userId: string, email: string) {
    return transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user:${userId}`]);
      const existing = await client.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId]);
      if (existing.rowCount) return existing.rows[0].workspace_id;
      const id = randomUUID();
      await client.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [id, 'My workspace']);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,email,role) VALUES($1,$2,$3,'owner')", [id,userId,email]);
      await client.query('INSERT INTO subscriptions(workspace_id) VALUES($1)', [id]);
      await client.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,$3,'trial',$4)", [randomUUID(),id,config.trialCredits,`trial:${id}`]);
      await recordMilestone(client,config,id,'signup');
      return id;
    });
  }
  async function resolveContext(userId: string, email: string, workspaceId: string | undefined, authKind: Context['authKind'], scopes: string[]): Promise<Context> {
    const membership = await db.query(`SELECT workspace_id,role,email FROM workspace_members WHERE user_id=$1 AND status='active' ${workspaceId ? 'AND workspace_id=$2' : ''} ORDER BY created_at LIMIT 1`, workspaceId ? [userId,workspaceId] : [userId]);
    invariant(membership.rowCount, 'WORKSPACE_FORBIDDEN','You do not have access to this workspace.',403);
    return { userId,email:email || membership.rows[0].email,workspaceId:membership.rows[0].workspace_id,role:membership.rows[0].role,authKind,scopes };
  }
  async function authenticate(request: FastifyRequest): Promise<Context> {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    invariant(bearer, 'AUTH_REQUIRED','Sign in to continue.',401);
    if (bearer.startsWith('ask_')) {
      const match = await db.query('SELECT * FROM api_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [hash(bearer)]);
      invariant(match.rowCount,'TOKEN_INVALID','This connection has expired or was revoked.',401);
      const t=match.rows[0];
      return {...await resolveContext(t.user_id,'',t.workspace_id,'mcp',t.scopes),connection:{kind:'token',id:t.id}};
    }
    let claims;
    try {
      if(config.developmentAuth) claims=(await jwtVerify(bearer,signingKey,{issuer:'appscreen-development',audience:'appscreen',algorithms:['HS256']})).payload;
      else if(config.supabaseAuthVerification==='auth-server') claims=await verifyAuthServerToken(bearer,config);
      else { invariant(jwks,'AUTH_UNAVAILABLE','Authentication is not configured.',503); claims=(await jwtVerify(bearer,jwks,{issuer:`${config.supabaseUrl}/auth/v1`,audience:config.mcpOAuthEnabled?['authenticated',config.mcpResource]:'authenticated'})).payload; }
    } catch { throw new AppError('AUTH_INVALID','Your session expired. Sign in again.',401); }
    invariant(claims.sub,'AUTH_INVALID','Invalid account identity.',401);
    invariant(claims.is_anonymous!==true,'VERIFIED_ACCOUNT_REQUIRED','Create an account before using cloud projects.',403);
    if(claims.client_id!==undefined&&claims.client_id!==null) {
      invariant(config.mcpOAuthEnabled&&!config.developmentAuth&&typeof claims.client_id==='string'&&claims.client_id.length>0&&claims.aud===config.mcpResource,'OAUTH_TOKEN_INVALID','This agent credential was not issued for AppScreen.',401);
      invariant(typeof claims.appscreen_grant_id==='string'&&typeof claims.appscreen_grant_version==='number'&&typeof claims.appscreen_workspace_id==='string'&&Array.isArray(claims.appscreen_scopes),'OAUTH_TOKEN_INVALID','Reconnect this agent to approve its permissions.',401);
      const grants=await db.query('SELECT * FROM oauth_grants WHERE id::text=$1 AND user_id=$2 AND client_id=$3 AND workspace_id::text=$4 AND version=$5 AND resource=$6 AND revoked_at IS NULL AND expires_at>now()',[claims.appscreen_grant_id,claims.sub,claims.client_id,claims.appscreen_workspace_id,claims.appscreen_grant_version,config.mcpResource]);
      invariant(grants.rowCount,'OAUTH_GRANT_REVOKED','This agent connection expired, changed, or was revoked.',401);const grant=grants.rows[0];
      invariant(claims.appscreen_scopes.every(scope=>typeof scope==='string'&&grant.scopes.includes(scope)&&ALL_SCOPES.includes(scope as any)),'OAUTH_SCOPE_INVALID','The credential exceeds its approved permissions.',401);
      return {...await resolveContext(claims.sub,'',grant.workspace_id,'mcp',claims.appscreen_scopes as string[]),connection:{kind:'oauth',id:grant.id,version:grant.version}};
    }
    invariant(claims.aud===(config.developmentAuth?'appscreen':'authenticated'),'AUTH_INVALID','This credential is not a browser session.',401);
    await ensureWorkspace(claims.sub,typeof claims.email==='string'?claims.email:'');
    const workspaceHeader = request.headers['x-workspace-id'];
    const context=await resolveContext(claims.sub,typeof claims.email==='string'?claims.email:'',typeof workspaceHeader==='string'?workspaceHeader:undefined,config.developmentAuth?'development':'web',[...ALL_SCOPES]);
    return {...context,assuranceLevel:claims.aal==='aal2'?'aal2':'aal1'};
  }
  async function developmentSession(email: string) {
    invariant(config.developmentAuth,'DEV_AUTH_DISABLED','Development sign-in is not enabled.',404);
    invariant(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'INVALID_EMAIL','Enter a valid email address.');
    const subject=`dev:${hash(email.trim().toLowerCase())}`;
    const token=await new SignJWT({email:email.trim().toLowerCase()}).setProtectedHeader({alg:'HS256'}).setSubject(subject).setIssuer('appscreen-development').setAudience('appscreen').setIssuedAt().setExpirationTime('12h').sign(signingKey);
    await ensureWorkspace(subject,email);
    return {token};
  }
  async function issueToken(context: Context, name: string, scopes: string[], days=30) {
    invariant(context.authKind!=='mcp' && context.role==='owner','OWNER_REQUIRED','Only the workspace owner can create agent connections.',403);
    invariant(scopes.length>0 && scopes.every(s=>ALL_SCOPES.includes(s as any)),'INVALID_SCOPES','Choose valid connection permissions.');
    const token=`ask_${randomBytes(32).toString('base64url')}`;
    const id=randomUUID();
    await db.query('INSERT INTO api_tokens(id,workspace_id,user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7::integer*interval \'1 day\'))',[id,context.workspaceId,context.userId,name,hash(token),scopes,Math.min(90,Math.max(1,days))]);
    return {id,token,name,scopes};
  }
  return {authenticate,developmentSession,issueToken,ensureWorkspace,resolveContext};
}
export function requireScope(context: Context, scope: string) { invariant(context.scopes.includes(scope),'SCOPE_REQUIRED',`This connection needs ${scope} permission.`,403); }
