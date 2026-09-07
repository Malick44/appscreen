import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const LIVE_AI_FIXTURE_VERSION = 'focusboard-synthetic-v1';
export const LIVE_AI_CONFIRMATION = 'synthetic-five-usd5';
export const LIVE_AI_TOTAL_CONFIRMATION = 'synthetic-total-usd5-including-prior';
export const LIVE_AI_LIMITS = Object.freeze({ budgetMicroUsd: 5_000_000, maxCalls: 7, maxInputTokens: 40_000, maxOutputTokens: 6_000, timeoutMs: 120_000 });
// Independently fetched official API Standard pricing on this UTC date. This
// dated record is NOT permission to run and deliberately expires at UTC midnight.
export const LIVE_AI_RATE_CARD = Object.freeze({
  model: 'gpt-6-astra', serviceTier: 'default', verified: true, verifiedAt: '2026-09-07',
  inputMicroUsdPerMillion: 10_000_000, cachedInputMicroUsdPerMillion: 1_000_000,
  cacheWriteMicroUsdPerMillion: 12_500_000, outputMicroUsdPerMillion: 50_000_000,
});
export const LIVE_AI_RATE_SOURCES = Object.freeze([
  'https://developers.openai.com/api/docs/pricing',
  'https://developers.openai.com/api/docs/models/gpt-6-astra',
]);
export function rehearsalError(code) { return Object.assign(new Error(code), { code }); }
export function requireCheck(condition, code) { if (!condition) throw rehearsalError(code); }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function assertLiveAITestDatabase(value) {
  let url;
  try { url = new URL(value); } catch { throw rehearsalError('TEST_DATABASE_REQUIRED'); }
  requireCheck(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname), 'LOOPBACK_DATABASE_REQUIRED');
  requireCheck(url.pathname === '/appscreen_test' && !url.search && !url.hash, 'EXACT_TEST_DATABASE_REQUIRED');
  return { fingerprint: sha256(url.href), database: 'appscreen_test' };
}
export function parseLiveAIArguments(args) {
  if (!args.length || (args.length === 1 && args[0] === '--prepare')) return { mode: 'prepare' };
  if (args.length === 2 && args[0] === '--live' && isAbsolute(args[1])) return { mode: 'live', directory: args[1] };
  throw rehearsalError('USE_PREPARE_OR_LIVE_ABSOLUTE_PREPARED_DIRECTORY');
}
export async function assertPreparedDirectory(directory, temporaryRoot) {
  requireCheck(isAbsolute(directory) && directory === resolve(directory), 'PREPARED_DIRECTORY_INVALID');
  const details = await lstat(directory);
  requireCheck(details.isDirectory() && !details.isSymbolicLink(), 'PREPARED_DIRECTORY_INVALID');
  const resolved = await realpath(directory), parent = await realpath(temporaryRoot);
  requireCheck(resolved === directory && dirname(resolved) === parent && /^appscreen-live-ai-[A-Za-z0-9]{6}$/.test(basename(resolved)), 'PREPARED_DIRECTORY_INVALID');
  return resolved;
}
export async function readBoundedFile(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireCheck(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'REHEARSAL_FILE_INVALID');
    const bytes = await handle.readFile();
    requireCheck(bytes.length === stat.size && bytes.length <= maxBytes, 'REHEARSAL_FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
export async function readPreparedChild(directory, relativePath, maxBytes) {
  const path = resolve(directory, relativePath);
  requireCheck(path.startsWith(directory + sep), 'PREPARED_CHILD_INVALID');
  // Resolve before reading so a symlinked ancestor cannot redirect a fixture or
  // private object read into an unrelated user folder.
  requireCheck(await realpath(dirname(path)) === dirname(path), 'PREPARED_CHILD_INVALID');
  return readBoundedFile(path, maxBytes);
}
/** @param {any} prepared @param {any} env @param {{now?:Date,databaseFingerprint?:string,expectedKeyFile?:string}} options */
export function assertLiveAIApproval(prepared, env, { now = new Date(), databaseFingerprint, expectedKeyFile } = {}) {
  requireCheck(prepared?.kind === 'appscreen-live-ai-prepared' && prepared.version === 1 && prepared.fixtureVersion === LIVE_AI_FIXTURE_VERSION && prepared.status === 'prepared-no-live-authorization', 'PREPARATION_INVALID');
  requireCheck(/^[a-f0-9-]{36}$/.test(prepared.runId || ''), 'PREPARATION_INVALID');
  requireCheck(env.APPSCREEN_LIVE_AI_CONFIRM === LIVE_AI_CONFIRMATION && env.APPSCREEN_LIVE_AI_RUN_ID === prepared.runId, 'EXPLICIT_LIVE_APPROVAL_REQUIRED');
  requireCheck(now.toISOString().slice(0, 10) === LIVE_AI_RATE_CARD.verifiedAt && env.APPSCREEN_LIVE_AI_RATE_REVIEWED === LIVE_AI_RATE_CARD.verifiedAt, 'FRESH_RATE_REVIEW_REQUIRED');
  requireCheck(canonicalJSON(prepared.rateCard) === canonicalJSON(LIVE_AI_RATE_CARD) && canonicalJSON(prepared.limits) === canonicalJSON(LIVE_AI_LIMITS), 'PREPARED_BUDGET_CHANGED');
  requireCheck(prepared.databaseFingerprint === databaseFingerprint, 'PREPARED_DATABASE_CHANGED');
  requireCheck(env.APPSCREEN_LIVE_AI_KEY_FILE === expectedKeyFile && isAbsolute(expectedKeyFile), 'EXACT_APPROVED_KEY_FILE_REQUIRED');
  requireCheck(Number.isFinite(Date.parse(prepared.preparedAt)) && Date.parse(prepared.preparedAt) <= now.getTime() && now.getTime() - Date.parse(prepared.preparedAt) <= 6 * 60 * 60 * 1000, 'PREPARATION_EXPIRED');
}
// A fresh fixture never resets the approved aggregate allowance. The operator
// must pin the one private ledger created for this evaluation campaign.
export function liveAIBudgetBinding(env) {
  requireCheck(env.APPSCREEN_LIVE_AI_TOTAL_CONFIRM === LIVE_AI_TOTAL_CONFIRMATION, 'AGGREGATE_BUDGET_APPROVAL_REQUIRED');
  const directory = env.APPSCREEN_LIVE_AI_BUDGET_DIRECTORY;
  requireCheck(typeof directory === 'string' && isAbsolute(directory) && directory === resolve(directory), 'AGGREGATE_BUDGET_DIRECTORY_REQUIRED');
  requireCheck(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(env.APPSCREEN_LIVE_AI_BUDGET_ID || ''), 'AGGREGATE_BUDGET_ID_REQUIRED');
  requireCheck(/^[0-9a-f]{64}$/.test(env.APPSCREEN_LIVE_AI_BUDGET_MANIFEST_SHA256 || ''), 'AGGREGATE_BUDGET_HASH_REQUIRED');
  return { directory, expectedBudgetId: env.APPSCREEN_LIVE_AI_BUDGET_ID, expectedManifestSha256: env.APPSCREEN_LIVE_AI_BUDGET_MANIFEST_SHA256 };
}
export async function claimLiveAIAttempt(directory, prepared) {
  const path = join(directory, 'live-attempt.json');
  // O_EXCL means even two simultaneous invocations cannot read a credential or
  // send under the same prepared approval. This receipt is never removed/reused.
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw rehearsalError('LIVE_ATTEMPT_ALREADY_USED'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, runId: prepared.runId, startedAt: new Date().toISOString(), state: 'claimed-no-automatic-retry', budgetMicroUsd: LIVE_AI_LIMITS.budgetMicroUsd, preparationSha256: sha256(canonicalJSON(prepared)) }, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
  return path;
}
export function createLiveAIReportWriter(directory, mode) {
  let path = join(directory, mode === 'prepare' ? 'prepare-report.json' : `rejected-live-attempt-${randomUUID()}.json`), initialized = false;
  return {
    get path() { return path; },
    async claim(prepared) {
      requireCheck(mode === 'live', 'LIVE_REPORT_CLAIM_INVALID');
      await claimLiveAIAttempt(directory, prepared);
      // Only the atomic attempt owner can acquire the authoritative report.
      // Preserve even an orphaned prior report rather than overwrite evidence.
      const authoritative = join(directory, 'live-report.json');
      const handle = await open(authoritative, 'wx', 0o600);
      await handle.close();
      path = authoritative; initialized = true;
    },
    async persist(value) {
      const flags = initialized ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      const handle = await open(path, flags, 0o600);
      initialized = true;
      try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
    },
  };
}
export function extractApprovedOpenAIKey(bytes) {
  // Intentionally does not load dotenv or parse/use any other setting. No env
  // mutation, interpolation, logs, fallback key, org, project or base URL reads.
  const matches = bytes.toString('utf8').split(/\r?\n/).filter(line => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line));
  requireCheck(matches.length === 1, 'APPROVED_OPENAI_KEY_MISSING_OR_DUPLICATE');
  const value = matches[0].replace(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*/, '').trim();
  const match = value.match(/^(?:"(sk-[A-Za-z0-9_-]+)"|'(sk-[A-Za-z0-9_-]+)'|(sk-[A-Za-z0-9_-]+))(?:\s*(?:#.*)?)$/);
  requireCheck(!!match, 'APPROVED_OPENAI_KEY_INVALID');
  return match[1] || match[2] || match[3];
}
export function assertApprovedOpenAIRequest(urlValue, { method, headers, body }) {
  const url = new URL(urlValue);
  requireCheck(url.origin === 'https://api.openai.com' && !url.username && !url.password && !url.search && !url.hash && ['/v1/responses', '/v1/responses/input_tokens'].includes(url.pathname) && method === 'POST', 'PROVIDER_NETWORK_DENIED');
  const actualHeaders = new Headers(headers);
  requireCheck(!actualHeaders.has('openai-organization') && !actualHeaders.has('openai-project') && !actualHeaders.has('cookie'), 'INHERITED_PROVIDER_CONTEXT_DENIED');
  requireCheck(typeof body === 'string' && Buffer.byteLength(body) <= 45 * 1024 * 1024, 'PROVIDER_BODY_DENIED');
  let json; try { json = JSON.parse(body); } catch { throw rehearsalError('PROVIDER_BODY_DENIED'); }
  requireCheck(json.model === LIVE_AI_RATE_CARD.model, 'PROVIDER_MODEL_DENIED');
  if (url.pathname === '/v1/responses') requireCheck(json.store === false && json.service_tier === 'default' && json.max_output_tokens <= LIVE_AI_LIMITS.maxOutputTokens, 'PROVIDER_POLICY_DENIED');
  return url.pathname;
}
/** @param {any} transport @param {(event:{path:string,method:string})=>void} observe */
export function createApprovedOpenAIFetch(transport, observe = () => {}) {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const path = assertApprovedOpenAIRequest(request.url, { method: request.method, headers: request.headers, body });
    observe({ path, method: 'POST' });
    // Never follow a provider redirect, even to another OpenAI path or origin.
    return transport(request, { redirect: 'error' });
  };
}
