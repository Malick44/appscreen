import { pathToFileURL } from 'node:url';

// Fixed public routes only: never log bodies, follow redirects, authenticate,
// load environment files, or trigger jobs. This is not a login/export test.
export const DEPLOYMENT_CHECKS = Object.freeze([
  ...['/', '/login', '/signup'].map(path => ({ path, kind: 'html', marker: '/saas/app.js', label: 'SaaS page shell' })),
  { path: '/editor', kind: 'html', marker: 'App Store Screenshot Generator', label: 'editor page' },
  { path: '/api/config', kind: 'config', label: 'public API configuration' },
  { path: '/health', kind: 'health', label: 'web/database readiness' },
  ...['/saas/app.js', '/saas/session.js', '/saas/api.js', '/saas/vendor/supabase.js', '/saas/editor-cloud.js', '/app.js', '/font-library.js', '/core/editor-bridge.mjs', '/core/render.mjs'].map(path => ({ path, kind: 'javascript', label: 'JavaScript asset' })),
  ...['/saas/styles.css', '/styles.css', '/ui-redesign.css'].map(path => ({ path, kind: 'css', label: 'stylesheet' })),
  { path: '/render/index.html', kind: 'html', marker: 'window.AppScreenRenderer', label: 'worker renderer page' },
].map(check => Object.freeze(check)));

export function validateBaseUrl(value) {
  const message = 'Provide one explicit origin, such as https://appscreen.example.com (no credentials, path, query, or fragment). HTTP is allowed only for localhost, 127.0.0.1, or [::1].';
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) throw new Error(message);
  let url;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(message);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(message);
  return url.origin;
}

class ProbeFailure extends Error {}

function validateContent(check, contentType, text) {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const html = mime === 'text/html' || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
  if (check.kind === 'html') {
    if (mime !== 'text/html' || !text.includes(check.marker)) {
      throw new ProbeFailure(text.includes('App Store Screenshot Generator') && check.path !== '/editor'
        ? 'Static editor fallback detected; this route is not serving the SaaS app.'
        : `Expected ${check.label}; the deployed page does not match.`);
    }
    return;
  }
  if (html) throw new ProbeFailure('HTML fallback detected; expected an API response or asset. Check the SaaS deployment and routing.');
  if (check.kind === 'config' || check.kind === 'health') {
    if (mime !== 'application/json') throw new ProbeFailure('Expected JSON from the SaaS backend, not a static-server response.');
    let data;
    try { data = JSON.parse(text); } catch { throw new ProbeFailure('The backend returned invalid JSON.'); }
    const valid = check.kind === 'health'
      ? data?.status === 'ok'
      : ['development', 'supabase'].includes(data?.auth?.provider) && typeof data?.billingEnabled === 'boolean' && typeof data?.aiEnabled === 'boolean';
    if (!valid) throw new ProbeFailure(`Unexpected ${check.label} response.`);
    return;
  }
  const validMime = check.kind === 'javascript'
    ? ['text/javascript', 'application/javascript'].includes(mime)
    : mime === 'text/css';
  if (!validMime || !text.trim()) throw new ProbeFailure(`Expected a nonempty ${check.label} with the correct content type.`);
}

async function probeRoute(origin, check, timeoutMs, maxBytes) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(new URL(check.path, origin), {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { 'Cache-Control': 'no-cache', Accept: '*/*' }, signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProbeFailure(response.status >= 300 && response.status < 400
        ? `HTTP ${response.status}: redirect not followed; check the exact deployment origin and routing.`
        : `HTTP ${response.status}: route unavailable.`);
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          throw new ProbeFailure('Response exceeded the verification size limit.');
        }
        chunks.push(value);
      }
    }
    validateContent(check, response.headers.get('content-type') || '', Buffer.concat(chunks).toString('utf8'));
    return { path: check.path, ok: true, message: check.label };
  } catch (error) {
    return { path: check.path, ok: false, message: timedOut ? `Timed out after ${timeoutMs} ms.` : error instanceof ProbeFailure ? error.message : 'Connection failed; check DNS, TLS, and service availability.' };
  } finally { clearTimeout(timer); }
}

export async function verifySaas(baseUrl, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const origin = validateBaseUrl(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Timeout must be between 1 and 30000 ms.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Response limit must be between 1 byte and 8 MiB.');
  const results = [];
  // Bound concurrency and total work: 19 known routes, four at a time.
  for (let i = 0; i < DEPLOYMENT_CHECKS.length; i += 4) {
    results.push(...await Promise.all(DEPLOYMENT_CHECKS.slice(i, i + 4).map(check => probeRoute(origin, check, timeoutMs, maxBytes))));
  }
  return { origin, ok: results.every(result => result.ok), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node deploy/verify-saas.mjs <explicit-base-origin>');
    const report = await verifySaas(process.argv[2]);
    for (const result of report.results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.path} — ${result.message}`);
    console.log(`${report.results.filter(result => result.ok).length}/${report.results.length} public deployment checks passed. Login, private storage, worker execution, and provider services still require separate verification.`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
