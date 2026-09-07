import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
function localSigningSecret() {
  const directory=resolve(rootDirectory,'.appscreen-data');const path=resolve(directory,'development-signing-key');
  mkdirSync(directory,{recursive:true,mode:0o700});
  try{return readFileSync(path,'utf8').trim();}catch(error:any){if(error.code!=='ENOENT')throw error;}
  try{writeFileSync(path,randomBytes(48).toString('hex'),{flag:'wx',mode:0o600});}catch(error:any){if(error.code!=='EEXIST')throw error;}
  return readFileSync(path,'utf8').trim();
}
const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid numeric service configuration');
  return parsed;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const developmentAuth = !production && env.APPSCREEN_DEV_AUTH === 'true';
  const port = integer(env.PORT, 8001);
  const baseUrl = env.APP_BASE_URL || `http://127.0.0.1:${port}`;
  const signingSecret = env.APPSCREEN_SIGNING_SECRET || (developmentAuth ? localSigningSecret() : !production ? randomBytes(48).toString('hex') : '');
  const databaseUrl = env.DATABASE_URL || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY || '';
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const mcpOAuthEnabled=env.APPSCREEN_MCP_OAUTH==='true';
  const emailEnabled=env.APPSCREEN_EMAIL_ENABLED==='true';
  const emailFrom=env.APPSCREEN_EMAIL_FROM||'';
  const resendKey=env.RESEND_API_KEY||'',resendWebhookSecret=env.RESEND_WEBHOOK_SECRET||'';
  if(emailEnabled&&(developmentAuth||!baseUrl.startsWith('https://')||!supabaseUrl.startsWith('https://')||!supabaseServiceKey||!resendKey||!resendWebhookSecret||!/^[-a-zA-Z0-9.!#$%&'*+/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(emailFrom)))throw new Error('Email delivery requires approved HTTPS hosting, real Supabase Auth, a verified sender address, and Resend API/webhook secrets. Development accounts cannot send email.');
  const operatorUserIds=[...new Set((env.APPSCREEN_OPERATOR_USER_IDS||'').split(',').map(id=>id.trim()).filter(Boolean))];
  const identityPattern=production?/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i:/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dev:[0-9a-f]{64})$/i;
  if(operatorUserIds.some(id=>!identityPattern.test(id)))throw new Error('Operator access requires exact verified account IDs, not email addresses or workspace roles.');
  if (!databaseUrl) throw new Error('DATABASE_URL is required. See .env.saas.example and SAAS_SETUP.md.');
  if (production && (signingSecret.length < 48 || !baseUrl.startsWith('https://'))) throw new Error('Production requires HTTPS APP_BASE_URL and a strong APPSCREEN_SIGNING_SECRET.');
  if (!developmentAuth && (!supabaseUrl || !supabasePublishableKey)) throw new Error('Configure Supabase authentication, or explicitly enable APPSCREEN_DEV_AUTH for localhost development.');
  if (production && !supabaseServiceKey) throw new Error('Production private storage requires SUPABASE_SERVICE_ROLE_KEY.');
  if(mcpOAuthEnabled&&(developmentAuth||!supabaseUrl||!supabasePublishableKey))throw new Error('MCP OAuth requires configured Supabase Auth, not development sign-in.');
  if(production&&supabaseUrl&&!supabaseUrl.startsWith('https://'))throw new Error('Production Supabase must use HTTPS.');
  return {
    production, developmentAuth, port, host: developmentAuth ? '127.0.0.1' : (env.HOST || '0.0.0.0'), baseUrl,
    signingSecret, databaseUrl, supabaseUrl, supabasePublishableKey, supabaseServiceKey,
    mcpOAuthEnabled,mcpResource:new URL('/mcp',baseUrl).href,operatorUserIds,
    emailEnabled,emailFrom,resendKey,resendWebhookSecret,
    storageBucket: env.SUPABASE_STORAGE_BUCKET || 'appscreen-private',
    localStorageDirectory: resolve(env.APPSCREEN_STORAGE_PATH || '.appscreen-data/assets'),
    stripeKey: env.STRIPE_SECRET_KEY || '', stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    stripePriceId: env.STRIPE_PRO_PRICE_ID || '', priceAmount: env.PRO_PRICE_AMOUNT ? integer(env.PRO_PRICE_AMOUNT, 0) : null,
    currency: env.PRO_PRICE_CURRENCY || 'usd', trialCredits: integer(env.TRIAL_CREDITS, developmentAuth ? 100 : 5),
    monthlyCredits: integer(env.PRO_MONTHLY_CREDITS, 100), designCredits: integer(env.DESIGN_CREDITS, 5),
    revisionCredits: integer(env.REVISION_CREDITS, 1), uploadLimit: integer(env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024),
    maxPixels: integer(env.MAX_IMAGE_PIXELS, 40_000_000), maxStorageBytes: integer(env.MAX_STORAGE_BYTES, 500 * 1024 * 1024),
    maxProjects: integer(env.MAX_PROJECTS, 25), maxConcurrentJobs: integer(env.MAX_CONCURRENT_JOBS, 2),
    openaiKey: env.OPENAI_API_KEY || '', openaiModel: env.OPENAI_MODEL || 'gpt-6-astra',
    embeddedWorker: env.APPSCREEN_EMBEDDED_WORKER === 'true',
    allowLiveAI: env.APPSCREEN_ENABLE_AI === 'true',
    enableBilling: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRO_PRICE_ID && env.STRIPE_WEBHOOK_SECRET),
  };
}
export type Config = ReturnType<typeof loadConfig>;
