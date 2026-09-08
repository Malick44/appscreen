import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_CHECKS, validateBaseUrl, verifySaas } from './verify-saas.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function serveHealthy(req, res) {
  const check = DEPLOYMENT_CHECKS.find(check => check.path === req.url);
  assert.ok(check, 'Only explicit public routes may be requested');
  const content = {
    html: ['text/html; charset=utf-8', `<!doctype html><html>${check.marker}</html>`],
    config: ['application/json', JSON.stringify({ auth: { provider: 'development' }, aiEnabled: false, billingEnabled: false })],
    health: ['application/json', '{"status":"ok"}'],
    javascript: ['text/javascript; charset=utf-8', '/* synthetic asset */ export const ready = true;'],
    css: ['text/css; charset=utf-8', 'body { color: black; }'],
  }[check.kind];
  res.writeHead(200, { 'Content-Type': content[0] });
  res.end(content[1]);
}

test('requires a safe explicit origin without reading credentials or environment', () => {
  for (const value of [undefined, '', 'example.com', 'file:///tmp/app', 'ftp://example.com', 'https://u:secret@example.com', 'https://example.com/path', 'https://example.com?', 'https://example.com#', 'https://example.com/?token=secret', 'https://example.com/../', 'https://example.com\\path', ' https://example.com', 'http://example.com', 'http://192.168.1.2', 'http://localhost.example.com']) {
    assert.throws(() => validateBaseUrl(value), /explicit origin/);
  }
  assert.equal(validateBaseUrl('https://example.com/'), 'https://example.com');
  assert.equal(validateBaseUrl('http://localhost:8001'), 'http://localhost:8001');
  assert.equal(validateBaseUrl('http://127.0.0.1:8001/'), 'http://127.0.0.1:8001');
  assert.equal(validateBaseUrl('http://[::1]:8001'), 'http://[::1]:8001');
});

test('checks SaaS shells, APIs, and required assets using only anonymous GET requests', async t => {
  const seen = [];
  const origin = await fixture(t, (req, res) => {
    seen.push(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    serveHealthy(req, res);
  });
  const result = await verifySaas(origin);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, DEPLOYMENT_CHECKS.length);
  assert.deepEqual(seen.sort(), DEPLOYMENT_CHECKS.map(check => check.path).sort());
  for (const path of ['/login', '/signup', '/editor', '/font-library.js', '/saas/vendor/supabase.js', '/render/index.html']) assert.ok(seen.includes(path));
});

test('identifies a static editor catch-all and static nginx health response', async t => {
  const origin = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': req.url === '/health' ? 'text/plain' : 'text/html' });
    res.end(req.url === '/health' ? 'healthy\n' : '<!doctype html><title>App Store Screenshot Generator</title>');
  });
  const { ok, results } = await verifySaas(origin);
  assert.equal(ok, false);
  assert.match(results.find(r => r.path === '/login').message, /Static editor fallback/);
  assert.match(results.find(r => r.path === '/api/config').message, /HTML fallback/);
  assert.match(results.find(r => r.path === '/health').message, /Expected JSON/);
  assert.equal(results.find(r => r.path === '/editor').ok, true);
});

test('does not follow redirects, reveal response contents, or accept missing assets', async t => {
  const secret = 'private-token-do-not-print';
  let redirected = false;
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/redirect-target') { redirected = true; return res.end(secret); }
    if (req.url === '/login') { res.writeHead(302, { Location: `/redirect-target?token=${secret}` }); return res.end(secret); }
    if (req.url === '/font-library.js') { res.writeHead(404); return res.end(secret); }
    if (req.url === '/health') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: secret })); }
    serveHealthy(req, res);
  });
  const result = await verifySaas(origin);
  assert.equal(result.ok, false);
  assert.equal(redirected, false);
  assert.match(result.results.find(r => r.path === '/login').message, /302.*redirect not followed/);
  assert.match(result.results.find(r => r.path === '/font-library.js').message, /404/);
  assert.match(result.results.find(r => r.path === '/health').message, /503/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('rejects malformed JSON, unhealthy JSON, empty assets, and HTML disguised as JavaScript', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/api/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{secret'); }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"unhealthy"}'); }
    if (req.url === '/saas/styles.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('   '); }
    if (req.url === '/font-library.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('<!doctype html><html>wrong app</html>'); }
    serveHealthy(req, res);
  });
  const { results } = await verifySaas(origin);
  for (const path of ['/api/config', '/health', '/saas/styles.css', '/font-library.js']) assert.equal(results.find(r => r.path === path).ok, false, path);
});

test('times out slow bodies and rejects responses larger than its bounded budget', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html>'); return; }
    if (req.url === '/font-library.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('x'.repeat(1025)); }
    serveHealthy(req, res);
  });
  const { results } = await verifySaas(origin, { timeoutMs: 150, maxBytes: 1024 });
  assert.match(results.find(r => r.path === '/login').message, /Timed out/);
  assert.match(results.find(r => r.path === '/font-library.js').message, /size limit/);
  await assert.rejects(verifySaas(origin, { timeoutMs: 0 }), /Timeout/);
  await assert.rejects(verifySaas(origin, { maxBytes: Infinity }), /Response limit/);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./verify-saas.mjs', import.meta.url)), ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('CLI reports pass/fail and exit status without secret response bodies', async t => {
  const origin = await fixture(t, serveHealthy);
  const success = await runCli([origin]);
  assert.equal(success.code, 0);
  assert.match(success.output, /PASS \/login/);
  assert.match(success.output, /19\/19 public deployment checks passed/);
  const invalid = await runCli(['https://name:secret-value@example.com']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.output.includes('secret-value'), false);
  const missing = await runCli([]);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Usage:/);
  const unavailable = await fixture(t, (_req, res) => { res.writeHead(503); res.end('sensitive-server-detail'); });
  const failure = await runCli([unavailable]);
  assert.equal(failure.code, 1);
  assert.match(failure.output, /FAIL \/health.*503/);
  assert.equal(failure.output.includes('sensitive-server-detail'), false);
});
