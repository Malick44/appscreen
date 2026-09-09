import { decodeJwt, decodeProtectedHeader, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import { AppError } from './errors.js';

type AuthServerConfig = Pick<Config, 'supabaseUrl' | 'supabasePublishableKey' | 'mcpOAuthEnabled'>;
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new AppError('AUTH_INVALID', 'Your session expired. Sign in again.', 401);
function requireValid(value: unknown): asserts value { if (!value) throw invalid(); }

function validateClaims(claims: JWTPayload, issuer: string, now: number) {
  requireValid(claims.iss === issuer && claims.aud === 'authenticated');
  requireValid(typeof claims.sub === 'string' && userIdPattern.test(claims.sub));
  requireValid(typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp > now);
  requireValid(claims.nbf === undefined || (typeof claims.nbf === 'number' && Number.isSafeInteger(claims.nbf) && claims.nbf <= now));
  requireValid(claims.role === 'authenticated');
  requireValid(claims.is_anonymous === undefined || claims.is_anonymous === false);
  // A browser compatibility path must never turn an OAuth token into an owner session.
  requireValid(!Object.hasOwn(claims, 'client_id'));
}

/** Explicit compatibility mode for legacy HS256 Supabase browser sessions.
 * Decoding is only an admission check, NEVER authentication. The configured
 * Auth server must accept this exact bearer before any decoded claim is used.
 * No shared JWT secret, service-role key, session persistence, or retry/fallback.
 */
export async function verifyAuthServerToken(token: string, config: AuthServerConfig, {
  fetcher = fetch, timeoutMs = 5000,
}: { fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<JWTPayload> {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    requireValid(!config.mcpOAuthEnabled && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000);
    // No alternate host/path can be supplied by a JWT header or a redirect.
    const base = new URL(config.supabaseUrl);
    requireValid(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash && config.supabaseUrl === base.origin);
    const key = config.supabasePublishableKey;
    requireValid(key && !key.startsWith('sb_secret_'));
    if (key.split('.').length === 3) requireValid(decodeJwt(key).role === 'anon');
    requireValid(typeof token === 'string' && token.length <= 16_384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
    const header = decodeProtectedHeader(token);
    requireValid(header.alg === 'HS256' && !header.crit && header.b64 !== false);
    requireValid(Buffer.from(token.split('.')[2], 'base64url').length === 32);
    const issuer = `${config.supabaseUrl}/auth/v1`;
    const claims = decodeJwt(token);
    validateClaims(claims, issuer, Math.floor(Date.now() / 1000));

    controller = new AbortController();
    timer = setTimeout(() => controller?.abort(), timeoutMs);
    const response = await fetcher(`${issuer}/user`, {
      method: 'GET', headers: { apikey: key, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', credentials: 'omit', signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      controller.abort();
      throw invalid();
    }
    const reader = response.body?.getReader();
    requireValid(reader);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { controller.abort(); throw invalid(); }
      chunks.push(value);
    }
    const user = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireValid(user && !Array.isArray(user) && user.id === claims.sub && user.aud === 'authenticated' && user.role === 'authenticated');
    requireValid(user.is_anonymous === undefined || user.is_anonymous === false);
    requireValid(!user.deleted_at && (!user.banned_until || (Number.isFinite(Date.parse(user.banned_until)) && Date.parse(user.banned_until) <= Date.now())));
    requireValid(user.email === undefined || (typeof user.email === 'string' && user.email.length <= 320 && !/[\r\n\0]/.test(user.email)));
    // The token may expire while Auth is responding. Do not admit stale claims.
    validateClaims(claims, issuer, Math.floor(Date.now() / 1000));
    return { ...claims, email: user.email || '' };
  } catch { throw invalid(); }
  finally { if (timer) clearTimeout(timer); }
}
