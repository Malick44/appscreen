// Explicit isolated UI QA: node saas/tests/backup-import.browser-qa.mjs
// A separate headless browser and synthetic API routes are used. No user session,
// user screenshots, providers, local development API, or real workspaces are read.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'appscreen-backup-import-ui-'));
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const selected = {
  name: 'backup-\"><img src=x onerror=alert(1)>.zip',
  mimeType: 'application/zip', buffer: Buffer.from('Synthetic backup bytes; route intentionally mocks archive validation.'),
};
const copyName = 'Launch \"<img src=x onerror=alert(2)> & copy';
const writes = [], apiHits = [], unexpected = [], pageErrors = [];
let behavior = 'uncertain', releaseRequest;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://isolated.test').pathname;
  if (path.startsWith('/api/')) {
    unexpected.push(path);
    response.writeHead(500).end();
    return;
  }
  const file = path.startsWith('/saas/') ? path : path === '/img/icon.png' ? path : '/saas/index.html';
  if (file.includes('..') || (!/^\/saas\/[a-z0-9./-]+$/i.test(file) && file !== '/img/icon.png')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(repo, file));
    response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' })[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('qa-bootstrapped')) {
      sessionStorage.setItem('appscreen.dev.token', 'synthetic-local-test');
      sessionStorage.setItem('qa-bootstrapped', 'true');
    }
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    apiHits.push({ path: url.pathname, method: request.method() });
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/config') return send({ auth: { provider: 'development' }, mcp: {}, plans: [], aiEnabled: false });
    if (url.pathname === '/api/session') return send({ user: { id: userId, email: 'synthetic@example.test' }, workspace: { id: workspaceId, name: 'Isolated import QA' }, credits: 100, operator: false });
    if (url.pathname === '/api/notifications') return send({ notifications: [], unreadCount: 0, nextCursor: null });
    if (url.pathname === '/api/notifications/unread-count') return send({ unreadCount: 0 });
    if (url.pathname === '/api/projects' && request.method() === 'GET') return send({ projects: [] });
    if (url.pathname === '/api/projects/import') {
      assert.equal(request.method(), 'POST');
      assert.match(request.headers()['content-type'], /^multipart\/form-data; boundary=/);
      const multipart = await new Request('http://synthetic.test/import', {
        method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer(),
      }).formData();
      const original = multipart.get('file');
      writes.push({
        fields: [...multipart.keys()].sort(), fileName: original.name,
        bytes: Buffer.from(await original.arrayBuffer()).toString('base64'),
        name: multipart.get('name'), idempotencyKey: multipart.get('idempotencyKey'),
        expectedUserId: multipart.get('expectedUserId'), expectedWorkspaceId: multipart.get('expectedWorkspaceId'),
      });
      const current = behavior;
      if (current === 'pending') {
        await new Promise(resolve => { releaseRequest = resolve; });
        return route.abort('failed');
      }
      if (current === 'uncertain') return route.abort('failed');
      if (current === 'invalid') return send({ error: { code: 'INVALID_BACKUP', message: 'This archive does not contain an editable campaign.' } }, 422);
      return send({ project: { id: projectId, name: copyName }, revision: { id: revisionId } });
    }
    unexpected.push(request.url());
    return send({ error: { code: 'UNEXPECTED' } }, 500);
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', async dialog => { pageErrors.push(`Unexpected dialog: ${dialog.message()}`); await dialog.dismiss(); });
  const modal = page.locator('#modal');
  const open = async () => { await page.getByRole('button', { name: 'Import editable backup', exact: true }).click(); await page.locator('#backup-import-form').waitFor(); };
  const select = async () => {
    await page.locator('#backup-import-file').setInputFiles(selected);
    await page.locator('#backup-import-name').fill(copyName);
  };
  const submit = () => page.getByRole('button', { name: 'Import as new campaign', exact: true }).click();
  const retryReady = () => page.getByRole('button', { name: 'Retry import', exact: true }).waitFor();
  const receiptCount = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('appscreen.backup-import.v1.')).length);
  const checkLayout = async (target, label) => {
    const layout = await target.locator('#modal').evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect();
      const controls = [...dialog.querySelectorAll('button,input,a.button')].filter(element => element.getClientRects().length);
      return {
        horizontal: document.documentElement.scrollWidth <= innerWidth && dialog.scrollWidth <= dialog.clientWidth,
        inside: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
        focus: dialog.contains(document.activeElement),
        targets: controls.map(element => ({ label: element.getAttribute('aria-label') || element.id || element.textContent, height: element.getBoundingClientRect().height })),
      };
    });
    assert.equal(layout.horizontal, true, `${label}: no horizontal overflow`);
    assert.equal(layout.inside, true, `${label}: dialog fits viewport`);
    assert.equal(layout.focus, true, `${label}: focus remains in dialog`);
    assert.ok(layout.targets.every(target => target.height >= 44), `${label}: ${JSON.stringify(layout.targets)}`);
  };
  await page.goto(origin + '/app');
  await page.getByRole('button', { name: 'Import editable backup', exact: true }).waitFor();
  assert.ok((await page.locator('.campaign-actions button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))).every(height => height >= 44), 'desktop campaign actions have 44px targets');
  await open();
  assert.equal(await page.locator('#backup-import-file').evaluate(element => element === document.activeElement), true, 'initial focus chooses ZIP');
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await modal.evaluate(dialog => dialog.contains(document.activeElement) || document.activeElement === document.body), true, 'native dialog prevents keyboard focus from reaching background page controls (browser chrome may remain reachable)');
  }
  await checkLayout(page, 'desktop');
  await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Import editable backup', exact: true }).evaluate(element => element === document.activeElement), true, 'escape restores trigger focus');
  await open();
  await page.getByRole('button', { name: 'Close import', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(writes.length, 0, 'close before confirmation never uploads');
  await open();
  await select();
  behavior = 'pending';
  await submit();
  await page.getByRole('button', { name: 'Importing campaign…', exact: true }).waitFor();
  assert.equal(await page.locator('#backup-import-file').isDisabled(), true);
  assert.equal(await page.locator('#backup-import-name').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Close import', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#backup-import-form button[type=submit]').getAttribute('aria-busy'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await modal.isVisible(), true, 'escape cannot close while request is pending');
  await page.locator('#backup-import-form').evaluate(form => form.requestSubmit());
  assert.equal(writes.length, 1, 'duplicate submit never duplicates pending import');
  await page.screenshot({ path: join(artifacts, 'pending.png'), fullPage: false });
  releaseRequest();
  await retryReady();
  await page.waitForFunction(() => document.activeElement?.id === 'backup-import-error');
  assert.equal(await receiptCount(), 1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await open();
  assert.equal(await page.locator('#backup-import-file').isDisabled(), true, 'reopened pending receipt freezes file');
  assert.equal(await page.locator('#backup-import-name').inputValue(), copyName);
  assert.equal(await page.locator('#backup-import-name').isDisabled(), true);
  assert.equal(await page.locator('#modal img').count(), 0, 'user-supplied names never create markup');
  assert.ok((await page.locator('#backup-import-file-note').innerText()).includes(selected.name));
  assert.equal(await page.getByRole('button', { name: 'Retry import', exact: true }).evaluate(element => element === document.activeElement), true);
  await checkLayout(page, 'desktop retry');
  await page.screenshot({ path: join(artifacts, 'retry.png'), fullPage: false });
  behavior = 'success';
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await page.getByRole('link', { name: 'Open imported campaign', exact: true }).waitFor();
  assert.equal(page.url(), origin + '/app', 'success does not navigate away automatically');
  assert.equal(await page.locator('#backup-import-open').getAttribute('href'), `/app/projects/${projectId}`);
  assert.equal(await page.locator('#backup-import-open').evaluate(element => element === document.activeElement), true);
  assert.match(await page.locator('#backup-import-status').innerText(), /new campaign.*No AI credits/);
  assert.equal(await receiptCount(), 0);
  assert.deepEqual(writes[0], writes[1], 'close/reopen retry keeps identical multipart intent');
  assert.deepEqual(writes[0].fields, ['expectedUserId', 'expectedWorkspaceId', 'file', 'idempotencyKey', 'name']);
  assert.equal(writes[0].expectedUserId, userId);
  assert.equal(writes[0].expectedWorkspaceId, workspaceId);
  assert.equal(writes[0].bytes, selected.buffer.toString('base64'));
  await page.screenshot({ path: join(artifacts, 'success.png'), fullPage: false });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await open();
  await select();
  behavior = 'invalid';
  await submit();
  await page.waitForFunction(() => document.querySelector('#backup-import-error')?.textContent.includes('does not contain'));
  assert.equal(await page.locator('#backup-import-file').isDisabled(), false, 'definitive validation rejection permits new ZIP');
  assert.equal(await page.locator('#backup-import-name').isDisabled(), false);
  assert.equal(await receiptCount(), 0);
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await open();
  await select();
  behavior = 'uncertain';
  await submit();
  await retryReady();
  const beforeReload = writes.at(-1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await open();
  assert.equal(await page.locator('#backup-import-file').isDisabled(), false, 'reload requires user to reselect file without storing screenshots');
  await select();
  behavior = 'success';
  await submit();
  await page.getByRole('link', { name: 'Open imported campaign', exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), beforeReload, 'reload/reselection reuses the original receipt');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const mobile = await context.newPage();
  mobile.on('pageerror', error => pageErrors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin + '/app#import-backup');
  await mobile.locator('#backup-import-form').waitFor();
  assert.ok((await mobile.locator('.campaign-actions button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))).every(height => height >= 44), 'mobile campaign actions have 44px targets');
  await checkLayout(mobile, 'mobile');
  await mobile.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: false });
  await mobile.locator('#backup-import-file').setInputFiles(selected);
  await mobile.locator('#backup-import-name').fill(copyName);
  behavior = 'uncertain';
  await mobile.getByRole('button', { name: 'Import as new campaign', exact: true }).click();
  await mobile.getByRole('button', { name: 'Retry import', exact: true }).waitFor();
  await mobile.waitForFunction(() => document.activeElement?.id === 'backup-import-error');
  await checkLayout(mobile, 'mobile retry with long filename');
  assert.equal(await mobile.getByRole('button', { name: 'Retry import', exact: true }).evaluate(button => {
    const bounds = button.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.height >= 44;
  }), true, 'mobile retry stays visible without requiring a scroll');
  assert.equal(await mobile.locator('#backup-import-error').evaluate(feedback => {
    const bounds = feedback.getBoundingClientRect();
    const actions = feedback.closest('form').querySelector('.actions').getBoundingClientRect();
    const dialog = feedback.closest('dialog').getBoundingClientRect();
    return bounds.top >= dialog.top && bounds.bottom <= actions.top;
  }), true, 'mobile error feedback is not hidden under the sticky retry controls');
  await mobile.screenshot({ path: join(artifacts, 'mobile-retry.png'), fullPage: false });
  await mobile.keyboard.press('Escape');
  await mobile.locator('#modal').waitFor({ state: 'hidden' });
  await mobile.waitForURL(origin + '/app');
  assert.equal(mobile.url(), origin + '/app', 'closing deep-link dialog clears its hash');
  await mobile.close();
  await open();
  await select();
  behavior = 'uncertain';
  await submit();
  await retryReady();
  const beforeSignOut = writes.at(-1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/login');
  assert.equal(await receiptCount(), 1, 'opaque workspace-bound receipt survives sign-out to avoid duplicate uncertain imports');
  const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('appscreen.backup-import.v1.')).map(key => [key, sessionStorage.getItem(key)]))));
  for (const privateValue of [selected.name, copyName, 'Synthetic backup bytes', userId, workspaceId]) {
    assert.equal(stored.includes(privateValue), false, 'receipt stores no campaign name, filename, bytes, user ID, or workspace ID');
  }
  await page.evaluate(() => sessionStorage.setItem('appscreen.dev.token', 'synthetic-local-test'));
  await page.goto(origin + '/app');
  await open();
  assert.equal(await page.locator('#backup-import-file').isDisabled(), false, 'sign-out discarded the in-memory frozen file');
  assert.equal(await page.locator('#backup-import-file').inputValue(), '');
  assert.equal(await page.locator('#backup-import-name').inputValue(), '');
  await select();
  behavior = 'success';
  await submit();
  await page.getByRole('link', { name: 'Open imported campaign', exact: true }).waitFor();
  assert.deepEqual(writes.at(-1), beforeSignOut, 'same owner reselection after sign-in reuses safe receipt');
  assert.deepEqual(unexpected, [], 'all API requests are mocked and no external providers are accessed');
  assert.deepEqual(pageErrors, []);
  assert.ok(apiHits.filter(hit => hit.method !== 'GET').every(hit => hit.path === '/api/projects/import'), 'only requested import writes occur; no AI, export, billing, or message calls');
  console.log(JSON.stringify({ result: 'PASS', artifacts, mockedImports: writes.length, mockedApiRequests: apiHits.length, unmockedRequests: unexpected.length, pageErrors }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
