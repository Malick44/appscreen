// Explicit headless UI regression, not part of the default unit test glob.
// Run: node server/tests/ui-smoke.mjs
// Creates one clearly labeled synthetic local development workspace/project.
// Never contacts a real Auth/AI/payment provider or submits a deletion request.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';

const base = new URL(process.env.APPSCREEN_QA_BASE_URL || 'http://127.0.0.1:8001');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Loopback only.');
const config = await (await fetch(new URL('/api/config', base))).json();
assert.equal(config.auth?.provider, 'development', 'Explicit local development sign-in is required.');
const output = await mkdtemp(join(tmpdir(), 'appscreen-ui-smoke-'));
const marker = `QA · Headless UI ${Date.now()}`;
const captureOnly = process.argv.includes('--capture-only');
const accountOnly = process.argv.includes('--account-only');
assert.ok(!accountOnly || captureOnly, '--account-only must use --capture-only.');
const email = captureOnly ? process.env.APPSCREEN_QA_EMAIL : `headless-ui-qa-${randomUUID().slice(0, 8)}@example.test`;
assert.match(email || '', /^headless-ui-qa-[a-f0-9]{8}@example\.test$/, 'Capture-only requires the existing synthetic account email in APPSCREEN_QA_EMAIL.');
const report = { marker, email, captureOnly, baseUrl: base.origin, screenshots: [], checks: [], layouts: [], pageErrors: [], failedResponses: [], blockedExternalRequests: [], projectId: null, workspaceId: null, archive: null };
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'reduce' });
let failExport = false, createdConnectionId = null, connectionRevoked = false;
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) {
    report.blockedExternalRequests.push({ origin: url.origin, path: url.pathname });
    await route.abort(); return;
  }
  if (url.pathname === '/api/account/export' && failExport) {
    failExport = false;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ACCOUNT_EXPORT_BUSY', message: 'Synthetic QA: backup capacity is busy. Please try again shortly.' } }) }); return;
  }
  if (route.request().method() === 'POST' && ['/api/dev/session', '/api/connections'].includes(url.pathname)) await new Promise(resolve => setTimeout(resolve, 400));
  await route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(12_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400) report.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
});
const check = (name, okay, detail = '') => report.checks.push({ name, pass: !!okay, detail });
async function unique(locator) { assert.equal(await locator.count(), 1, 'Each action must have one unambiguous DOM target.'); return locator; }
async function ready(title) { await page.getByRole('heading', { name: title, exact: true }).waitFor(); await page.evaluate(() => document.fonts.ready); }
async function snapshot(name) {
  const path = join(output, `${name}.png`);
  const modalVisible = await page.getByRole('dialog').isVisible();
  await page.screenshot({ path, fullPage: !modalVisible, mask: [page.locator('#new-connection-token')], animations: 'disabled' });
  report.screenshots.push({ name, path });
  const layout = await page.evaluate(() => {
    const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden'; };
    const targets = [...document.querySelectorAll('button,a.button,input:not([type=checkbox]):not([type=radio]),select,textarea')].filter(visible).map(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { text: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 120), tag: element.tagName, width: Math.round(rect.width), height: Math.round(rect.height), disabled: !!element.disabled, fontSize: style.fontSize, color: style.color, background: style.backgroundColor, clippedHorizontally: rect.left < -1 || rect.right > innerWidth + 1 };
    });
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, targets };
  });
  report.layouts.push({ name, ...layout });
  check(`${name}: no page horizontal overflow`, layout.documentWidth <= layout.viewport + 1, `${layout.documentWidth}/${layout.viewport}`);
  check(`${name}: primary controls remain within viewport`, !layout.targets.some(target => target.clippedHorizontally));
}
async function go(path, heading) { const response = await page.goto(new URL(path, base).href); check(`${path}: direct route`, response.status() === 200, String(response.status())); if (response.status() !== 200) return false; await ready(heading); return true; }

try {
  await go('/login', 'Welcome back.');
  if (!accountOnly) await snapshot('desktop-login');
  const emailField = await unique(page.getByLabel('Email address', { exact: true }));
  await emailField.fill(email);
  const submit = await unique(page.getByRole('button', { name: 'Enter local workspace', exact: true }));
  await submit.click();
  await page.getByRole('button', { name: 'Signing in…', exact: true }).waitFor();
  check('login shows disabled busy feedback', await page.getByRole('button', { name: 'Signing in…', exact: true }).isDisabled());
  await ready('Your campaigns');
  report.workspaceId = await page.evaluate(async () => { const { api } = await import('/saas/api.js'); return (await api('/api/session')).workspace.id; });
  check('synthetic local login completed', (await page.locator('body').innerText()).includes(email));
  if (captureOnly) {
    for (const [size, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await go('/app/settings', 'Your account'); await snapshot(`${size}-account`);
      const recoveryExplanation = page.getByText('Recovery email isn’t available for local test accounts.', { exact: true });
      check(`${size}: disabled recovery has a visible explanation`, await recoveryExplanation.isVisible());
      const recoveryRow = recoveryExplanation.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," settings-row ")][1]');
      check(`${size}: explanation is beside the disabled recovery action`, await recoveryRow.getByRole('button', { name: 'Send recovery email', exact: true }).isDisabled());
      const geometry = await page.evaluate(() => {
        const grid = document.querySelector('.settings-grid'), children = [...grid.children].map(node => node.getBoundingClientRect());
        return { gaps: children.slice(1).map((rect, index) => Math.round(rect.top - children[index].bottom)), downloadHeight: document.querySelector('[data-action="account-export"]').getBoundingClientRect().height };
      });
      check(`${size}: account card spacing`, geometry.gaps.every(gap => gap >= 16), JSON.stringify(geometry.gaps));
      if (size === 'desktop') check('desktop: download label stays on one line', geometry.downloadHeight <= 56, String(geometry.downloadHeight));
      if (!accountOnly) {
        await go('/app/connections', 'Connect your agent'); await snapshot(`${size}-connections`);
        await go('/recover', 'Let’s get you back in.'); await snapshot(`${size}-recovery`);
      }
    }
    if (!accountOnly) {
      await go('/app/settings', 'Your account');
      await (await unique(page.locator('.settings-grid').getByRole('button', { name: 'Sign out', exact: true }))).click();
      await ready('Welcome back.'); await snapshot('mobile-login-after-signout');
    }
  } else {
  await (await unique(page.locator('.page-heading').getByRole('button', { name: 'Create campaign', exact: true }))).click();
  await page.getByRole('dialog').waitFor(); await snapshot('desktop-create-dialog');
  await (await unique(page.getByLabel('Campaign name', { exact: true }))).fill(marker);
  await (await unique(page.getByRole('dialog').getByRole('button', { name: 'Create campaign', exact: true }))).click();
  await page.waitForURL(/\/app\/projects\/[a-f0-9-]+$/);
  report.projectId = new URL(page.url()).pathname.split('/').at(-1);
  check('synthetic project created', !!report.projectId);

  await go('/app/settings', 'Your account'); await snapshot('desktop-account');
  check('recovery email unavailable in local mode', await (await unique(page.getByRole('button', { name: 'Send recovery email', exact: true }))).isDisabled());
  const downloadButton = await unique(page.getByRole('button', { name: 'Download workspace ZIP', exact: true }));
  failExport = true; await downloadButton.click();
  await page.getByText('Synthetic QA: backup capacity is busy. Please try again shortly.', { exact: true }).waitFor();
  check('export failure restores retry control', await downloadButton.isEnabled());
  await snapshot('desktop-account-export-error');
  const downloadEvent = page.waitForEvent('download'); await downloadButton.click();
  const download = await downloadEvent, archivePath = join(output, download.suggestedFilename());
  await download.saveAs(archivePath); assert.equal(await download.failure(), null);
  const zip = await JSZip.loadAsync(await readFile(archivePath)), manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const projects = await zip.file('data/projects.ndjson').async('string');
  check('workspace archive contains synthetic project', projects.includes(marker));
  check('archive is scoped to synthetic workspace', manifest.scope.workspaceId === report.workspaceId);
  check('archive excludes credentials and connections', !Object.keys(zip.files).some(name => /tokens|connections|oauth|receipts/.test(name)));
  report.archive = { path: archivePath, entries: Object.keys(zip.files), scope: manifest.scope, projectCount: manifest.counts.projects };
  await page.getByText(/Complete workspace ZIP received/).waitFor();
  check('export success confirms completed download', true); await snapshot('desktop-account-export-success');

  await go('/app/connections', 'Connect your agent'); await snapshot('desktop-connections');
  check('connection defaults to read-only', await page.getByRole('checkbox', { checked: true }).count() === 1 && await page.getByRole('checkbox', { name: 'Read projects and templates', exact: true }).isChecked());
  check('paid AI is not preselected', !await page.getByRole('checkbox', { name: 'Start paid AI jobs', exact: true }).isChecked());
  await (await unique(page.getByLabel('Connection name', { exact: true }))).fill('QA · Headless temporary read-only token');
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/connections' && response.request().method() === 'POST');
  await (await unique(page.getByRole('button', { name: 'Create scoped token', exact: true }))).click();
  await page.getByRole('button', { name: 'Creating token…', exact: true }).waitFor();
  check('token creation displays disabled busy feedback', await page.getByRole('button', { name: 'Creating token…', exact: true }).isDisabled());
  createdConnectionId = (await (await createdResponse).json()).id;
  await page.getByLabel('New access token', { exact: true }).waitFor();
  check('new token is masked', await page.getByLabel('New access token', { exact: true }).getAttribute('type') === 'password');
  await snapshot('desktop-token-created');
  await (await unique(page.getByRole('button', { name: 'I saved it securely', exact: true }))).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await (await unique(page.getByRole('button', { name: 'Revoke', exact: true }))).click();
  await page.locator('.badge').getByText('Revoked', { exact: true }).waitFor(); connectionRevoked = true;
  check('temporary token revoked through UI', true);

  await page.setViewportSize({ width: 390, height: 844 });
  await go('/app/connections', 'Connect your agent'); await snapshot('mobile-connections');
  await go('/app/settings', 'Your account'); await snapshot('mobile-account');
  const deletion = page.getByRole('button', { name: 'Request deletion', exact: true });
  if (await deletion.count() === 1) {
    await deletion.click(); await page.getByRole('dialog').waitFor(); await snapshot('mobile-deletion-confirmation');
    check('deletion requires explicit confirmation input', await page.getByLabel('Type DELETE to confirm', { exact: true }).count() === 1);
    await (await unique(page.getByRole('dialog').getByRole('button', { name: /^(Keep account|Go back)$/ }))).click();
    check('deletion dialog safely cancelled without request', !await page.getByRole('dialog').isVisible());
  }
  await go('/reset-password', 'Get a fresh password link.'); await snapshot('mobile-reset-without-proof');
  check('unverified reset has no password input', await page.locator('input[type=password]').count() === 0);
  await page.getByRole('link', { name: 'Request recovery link', exact: true }).click();
  await ready('Let’s get you back in.'); await snapshot('mobile-recovery');
  check('recovery send disabled in development', await page.getByRole('button', { name: 'Send recovery link', exact: true }).isDisabled());
  const recoveryReload = await page.reload(); check('/recover: refresh route', recoveryReload.status() === 200, String(recoveryReload.status()));
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (recoveryReload.status() === 200) { await ready('Let’s get you back in.'); await snapshot('desktop-recovery'); }
  await go('/app/settings', 'Your account');
  await (await unique(page.locator('.settings-grid').getByRole('button', { name: 'Sign out', exact: true }))).click();
  await ready('Welcome back.'); check('sign-out returns to login', new URL(page.url()).pathname === '/login');
  await page.goto(new URL('/app/settings', base).href); await ready('Welcome back.');
  check('signed-out account page is protected', new URL(page.url()).pathname === '/login');
  await page.setViewportSize({ width: 390, height: 844 }); await snapshot('mobile-login');
  }
} catch (error) {
  report.checks.push({ name: 'smoke execution completed', pass: false, detail: error.message });
  await snapshot('failure-state').catch(() => {});
} finally {
  if (createdConnectionId && !connectionRevoked) {
    // Revocation is limited to this script's newly created synthetic credential.
    await page.evaluate(async id => { const { api } = await import('/saas/api.js'); await api(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }); }, createdConnectionId).then(() => { connectionRevoked = true; }).catch(() => {});
  }
  report.syntheticConnectionRevoked = connectionRevoked || !createdConnectionId;
  check('no browser JavaScript exceptions', report.pageErrors.length === 0);
  check('no external service requests', report.blockedExternalRequests.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ output, marker, email, workspaceId: report.workspaceId, projectId: report.projectId, passed: report.checks.filter(item => item.pass).length, failed: report.checks.filter(item => !item.pass), pageErrors: report.pageErrors, blockedExternalRequests: report.blockedExternalRequests, archive: report.archive?.path, screenshots: report.screenshots, syntheticConnectionRevoked: report.syntheticConnectionRevoked }, null, 2));
  process.exitCode = report.checks.every(item => item.pass) ? 0 : 1;
}
