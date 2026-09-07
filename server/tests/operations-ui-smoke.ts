// Opt-in real-browser regression (not in the default test glob).
// TEST_DATABASE_URL=...appscreen_test npx tsx server/tests/operations-ui-smoke.ts
// Synthetic local accounts only; no provider configuration, email, AI, payment,
// erasure, or changes to the user's existing development server/allowlist.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { createDatabase, transaction, verifyMigrations } from '../db.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { hash } from '../auth.js';
import { enqueueNotification } from '../notifications.js';

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL || '';
  assert.match(new URL(databaseUrl).pathname, /(?:^|[_/-])test(?:[_/-]|$)/, 'A dedicated test database is required.');
  const runId = randomUUID().slice(0, 8), output = await mkdtemp(join(tmpdir(), 'appscreen-operations-ui-'));
  const customerEmail = `operations-ui-customer-${runId}@example.test`, staffEmail = `operations-ui-staff-${runId}@example.test`;
  const customerId = `dev:${hash(customerEmail)}`, staffId = `dev:${hash(staffEmail)}`;
  const initialMessage = 'Synthetic QA request: my campaign is ready, but I would like help reviewing the export before publishing.';
  const customerReply = 'Synthetic follow-up: the issue appears on my smaller screen. Please check that the action buttons remain readable.';
  const staffReply = 'Thanks for the details. Your campaign is saved. We will review the export layout and reply in this conversation.';
  const internalNote = `INTERNAL_ONLY_QA_${runId}: Escalate this synthetic layout check to the design reviewer. Never show this note to the customer.`;
  const report: any = { runId, output, customerEmail, staffEmail, syntheticOnly: true, providersDisabled: true, chromiumSandbox: true, screenshots: [], checks: [], layouts: [], responses: [], pageErrors: [], blockedExternalRequests: [], requestId: null, workspaceId: null, completed: false };
  const db = createDatabase(databaseUrl);
  await verifyMigrations(db);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: join(output, 'synthetic-storage'), APPSCREEN_OPERATOR_USER_IDS: staffId, APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMBEDDED_WORKER: 'false' });
  const runtime = await createApp(config, db);
  const base = new URL(await runtime.app.listen({ host: '127.0.0.1', port: 0 }));
  config.baseUrl = base.origin; config.mcpResource = new URL('/mcp', base).href;
  report.baseUrl = base.origin;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  let failRead = false;
  let viewRequests = 0;
  const contexts: BrowserContext[] = [];
  const record = (name: string, pass: boolean, detail: unknown = '') => { report.checks.push({ name, pass, detail }); return pass; };
  const requireCheck = (name: string, pass: boolean, detail: unknown = '') => { record(name, pass, detail); assert.ok(pass, name); };
  const unique = async (locator: Locator) => { assert.equal(await locator.count(), 1, 'Each action requires one unique visible UI target.'); return locator; };
  async function pageFor(actor: string) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' }); contexts.push(context);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.origin !== base.origin && !['data:', 'blob:'].includes(url.protocol)) { report.blockedExternalRequests.push({ actor, origin: url.origin, path: url.pathname }); await route.abort(); return; }
      if (method === 'POST' && /^\/api\/operator\/support\/[^/]+\/view$/.test(url.pathname)) viewRequests++;
      if (method === 'POST' && url.pathname === '/api/notifications/read' && failRead) {
        failRead = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ_RETRY', message: 'Synthetic QA: read status could not be saved. Please try again.' } }) }); return;
      }
      // Controlled local latency makes actual disabled/busy feedback observable.
      if (method === 'POST' && (url.pathname.startsWith('/api/support') || url.pathname.startsWith('/api/operator/support') || url.pathname === '/api/notifications/read' || url.pathname === '/api/dev/session')) await new Promise(resolve => setTimeout(resolve, 280));
      await route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => report.pageErrors.push({ actor, message: error.message }));
    page.on('response', response => { if (response.status() >= 400) report.responses.push({ actor, path: new URL(response.url()).pathname, status: response.status() }); });
    return page;
  }
  async function ready(page: Page, title: string) { await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor(); await page.evaluate(() => document.fonts.ready); }
  async function go(page: Page, path: string, heading: string) {
    const response = await page.goto(new URL(path, base).href); requireCheck(`${path}: direct route serves app`, response?.status() === 200); await ready(page, heading);
  }
  async function snapshot(page: Page, name: string) {
    const path = join(output, `${name}.png`), modal = await page.getByRole('dialog').isVisible();
    // Full-page screenshots after keyboard scrolling can paint fixed off-screen
    // elements into the stitched result. Normalize scroll without changing focus.
    if (!modal) await page.evaluate(() => { window.scrollTo(0, 0); return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await page.screenshot({ path, fullPage: !modal, animations: 'disabled' }); report.screenshots.push({ name, path });
    const layout = await page.evaluate(() => {
      const modal = document.querySelector('dialog[open]'), scope = modal || document.querySelector('main')!;
      const targets = [...scope.querySelectorAll<HTMLElement>('button,a.button,input:not([type=checkbox]):not([type=radio]),select,textarea')].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      }).map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { label: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 90), tag: element.tagName, width: rect.width, height: rect.height, disabled: 'disabled' in element && !!element.disabled, fontSize: style.fontSize, outlineWidth: style.outlineWidth, clipped: rect.left < -1 || rect.right > innerWidth + 1 };
      });
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, targets };
    });
    report.layouts.push({ name, ...layout });
    record(`${name}: no horizontal document overflow`, layout.documentWidth <= layout.width + 1, `${layout.documentWidth}/${layout.width}`);
    record(`${name}: main controls remain in viewport`, !layout.targets.some(target => target.clipped));
    record(`${name}: main action buttons have comfortable height`, layout.targets.filter(target => target.tag === 'BUTTON' && target.label !== 'Close').every(target => target.height >= 43));
  }
  async function focusCheck(page: Page, locator: Locator, name: string) {
    await (await unique(locator)).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    const style = await locator.evaluate(element => ({ focused: document.activeElement === element, width: getComputedStyle(element).outlineWidth, color: getComputedStyle(element).outlineColor, visible: element.matches(':focus-visible') }));
    record(name, style.focused && style.visible && parseFloat(style.width) >= 2, style);
  }
  async function login(page: Page, email: string) {
    await go(page, '/login', 'Welcome back.');
    await (await unique(page.getByLabel('Email address', { exact: true }))).fill(email);
    await (await unique(page.getByRole('button', { name: 'Enter local workspace', exact: true }))).click();
    await page.getByRole('button', { name: 'Signing in…', exact: true }).waitFor();
    requireCheck(`${email}: sign-in shows disabled busy feedback`, await page.getByRole('button', { name: 'Signing in…', exact: true }).isDisabled());
    await ready(page, 'Your campaigns');
  }
  async function openPrivate(page: Page, reason: string) {
    await (await unique(page.getByLabel('Reason for accessing this request', { exact: true }))).fill(reason);
    await (await unique(page.getByRole('button', { name: 'Open private conversation', exact: true }))).click();
    await page.getByRole('button', { name: 'Opening audited conversation…', exact: true }).waitFor();
    requireCheck('private conversation access shows disabled busy feedback', await page.getByRole('button', { name: 'Opening audited conversation…', exact: true }).isDisabled());
    await page.getByRole('region', { name: 'Conversation', exact: true }).waitFor();
  }
  const customer = await pageFor('customer'), staff = await pageFor('staff');
  try {
    await login(customer, customerEmail); await login(staff, staffEmail);
    report.workspaceId = (await db.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1', [customerId])).rows[0].workspace_id;
    requireCheck('staff permissions apply only to isolated synthetic staff', !await customer.getByRole('link', { name: 'Operations', exact: true }).count() && await staff.getByRole('link', { name: 'Operations', exact: true }).count() === 1);
    await go(customer, '/app/support', 'Your support conversations');
    await snapshot(customer, 'desktop-support-empty');
    await (await unique(customer.getByRole('link', { name: 'New problem report', exact: true }))).click();
    await ready(customer, 'Your account');
    await (await unique(customer.getByLabel('What went wrong?', { exact: true }))).fill(initialMessage);
    await (await unique(customer.getByRole('button', { name: 'Send problem report', exact: true }))).click();
    await customer.getByRole('button', { name: 'Sending report…', exact: true }).waitFor();
    requireCheck('initial support report shows disabled busy feedback', await customer.getByRole('button', { name: 'Sending report…', exact: true }).isDisabled());
    await customer.waitForURL(/\/app\/support\/[a-f0-9-]{36}$/); await ready(customer, 'Support conversation');
    const requestId = new URL(customer.url()).pathname.split('/').at(-1)!; report.requestId = requestId;
    requireCheck('initial report receipt opens saved conversation', await customer.getByText(initialMessage, { exact: true }).isVisible());
    await (await unique(customer.getByLabel('Your message', { exact: true }))).fill(customerReply);
    await (await unique(customer.getByRole('button', { name: 'Send reply', exact: true }))).click();
    await customer.getByRole('button', { name: 'Sending reply…', exact: true }).waitFor();
    requireCheck('customer follow-up shows disabled busy feedback', await customer.getByRole('button', { name: 'Sending reply…', exact: true }).isDisabled());
    await customer.getByText(customerReply, { exact: true }).waitFor();
    requireCheck('customer follow-up persisted once', (await db.query("SELECT count(*)::integer AS count FROM support_messages WHERE request_id=$1 AND author_kind='customer'", [requestId])).rows[0].count === 1);

    await go(staff, `/app/operator/support/${requestId}`, 'Support conversation');
    requireCheck('staff detail does not fetch private content before a reason', viewRequests === 0 && !(await staff.locator('body').innerText()).includes(initialMessage));
    await (await unique(staff.getByRole('button', { name: 'Open private conversation', exact: true }))).click();
    requireCheck('empty reason leaves private detail unopened', viewRequests === 0 && await staff.locator('#support-access-form').isVisible());
    await focusCheck(staff, staff.getByRole('button', { name: 'Open private conversation', exact: true }), 'staff private-access button has visible keyboard focus');
    await snapshot(staff, 'desktop-staff-reason-gate');
    await openPrivate(staff, 'Synthetic UI QA: investigate the requested layout review.');
    requireCheck('reasoned access reveals requested synthetic thread', await staff.getByText(initialMessage, { exact: true }).isVisible());
    await (await unique(staff.getByLabel('Customer-visible reply', { exact: true }))).fill(staffReply);
    await (await unique(staff.getByRole('button', { name: 'Review reply', exact: true }))).click();
    await staff.getByRole('dialog').waitFor();
    requireCheck('staff reply preview displays exact customer-visible text', await staff.getByRole('dialog').getByText(staffReply, { exact: true }).isVisible());
    requireCheck('staff reply is not sent before review confirmation', (await db.query("SELECT count(*)::integer AS count FROM support_messages WHERE request_id=$1 AND author_kind='support'", [requestId])).rows[0].count === 0);
    await snapshot(staff, 'desktop-staff-reply-review');
    await (await unique(staff.getByRole('checkbox', { name: 'I have reviewed this customer-visible reply.', exact: true }))).check();
    await (await unique(staff.getByRole('dialog').getByRole('button', { name: 'Send reply', exact: true }))).click();
    await staff.getByRole('button', { name: 'Sending reply…', exact: true }).waitFor();
    requireCheck('confirmed staff send disables modal controls', await staff.getByRole('dialog').getByRole('button', { name: 'Go back', exact: true }).isDisabled());
    await staff.locator('#support-access-form').waitFor();
    requireCheck('successful staff write closes private details again', !(await staff.locator('body').innerText()).includes(staffReply));
    await openPrivate(staff, 'Synthetic UI QA: review the reply and record escalation context.');
    await (await unique(staff.getByLabel('New status', { exact: true }))).selectOption('escalated');
    await (await unique(staff.getByRole('button', { name: 'Review status change', exact: true }))).click();
    await staff.locator('#support-status-error').getByText(/Escalation/).waitFor();
    requireCheck('escalation without a private explanation is blocked', !await staff.getByRole('dialog').isVisible());
    await (await unique(staff.getByLabel('Internal note (required for escalation)', { exact: true }))).fill(internalNote);
    await (await unique(staff.getByRole('button', { name: 'Review status change', exact: true }))).click();
    await staff.getByRole('dialog').waitFor();
    await snapshot(staff, 'desktop-staff-escalation-review');
    await (await unique(staff.getByRole('checkbox', { name: 'I have reviewed this status change and any private note.', exact: true }))).check();
    await (await unique(staff.getByRole('dialog').getByRole('button', { name: 'Change status', exact: true }))).click();
    await staff.getByRole('button', { name: 'Changing status…', exact: true }).waitFor();
    requireCheck('status update shows disabled busy feedback', await staff.getByRole('button', { name: 'Changing status…', exact: true }).isDisabled());
    await staff.locator('#support-access-form').waitFor();
    requireCheck('status change closes private content including internal note', !(await staff.locator('body').innerText()).includes(internalNote));

    await go(customer, `/app/support/${requestId}`, 'Support conversation');
    requireCheck('customer sees public staff reply and escalation status', await customer.getByText(staffReply, { exact: true }).isVisible() && await customer.locator('.case-status').getByText('Escalated', { exact: true }).isVisible());
    requireCheck('customer DOM never receives internal note', !(await customer.locator('body').innerText()).includes(internalNote));
    const privateCheck = await customer.evaluate(async id => { const { api } = await import(String('/saas/api.js')); return JSON.stringify(await api(`/api/support/${id}`)); }, requestId);
    requireCheck('customer API response excludes internal note and staff identity', !privateCheck.includes(internalNote) && !privateCheck.includes(staffId));
    await go(customer, '/app/inbox', 'Your inbox');
    requireCheck('public staff reply delivered one unread in-app notice', await customer.locator('.notice-row.unread').count() === 1);
    requireCheck('inbox does not imply email delivery', /in-app updates, not email|This inbox does not send email/.test(await customer.locator('main').innerText()));
    failRead = true;
    await (await unique(customer.getByRole('button', { name: 'Mark as read', exact: true }))).click();
    await customer.getByText('Synthetic QA: read status could not be saved. Please try again.', { exact: true }).waitFor();
    requireCheck('failed mark-read keeps unread state and usable retry', await customer.locator('.notice-row.unread').count() === 1 && await customer.getByRole('button', { name: 'Mark as read', exact: true }).isEnabled());
    await snapshot(customer, 'desktop-inbox-read-retry');
    await (await unique(customer.getByRole('button', { name: 'Mark as read', exact: true }))).click();
    await customer.getByRole('button', { name: 'Marking as read…', exact: true }).waitFor();
    requireCheck('retry shows disabled busy feedback', await customer.getByRole('button', { name: 'Marking as read…', exact: true }).isDisabled());
    await customer.locator('#announcer').getByText(/Notification marked as read/).waitFor({ state: 'attached' });
    requireCheck('mark-read success updates unread count without resolving case', await customer.locator('.notice-row.unread').count() === 0 && (await db.query('SELECT status FROM account_requests WHERE id=$1', [requestId])).rows[0].status === 'escalated');
    await (await unique(customer.getByRole('checkbox', { name: 'Unread only', exact: true }))).check();
    await customer.getByRole('heading', { name: 'You’re all caught up.', exact: true }).waitFor();
    requireCheck('unread filter has a useful empty state', true);
    await (await unique(customer.getByRole('checkbox', { name: 'Unread only', exact: true }))).uncheck();
    await customer.locator('.notice-row').waitFor();
    await (await unique(customer.getByRole('link', { name: 'Open update', exact: true }))).click();
    await ready(customer, 'Support conversation');
    requireCheck('notification action opens the correct source conversation', new URL(customer.url()).pathname === `/app/support/${requestId}`);

    // Explicit terminal-state fixture for the second visual state, not an AI run.
    const projectId = randomUUID(), jobId = randomUUID(), key = randomUUID();
    await transaction(db, async client => {
      await client.query('INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)', [projectId, report.workspaceId, `Synthetic operations UI ${runId}`]);
      await client.query("INSERT INTO agent_jobs(id,workspace_id,project_id,user_id,kind,status,input,result,idempotency_key,request_hash,attempts) VALUES($1,$2,$3,$4,'design','ready','{}','{}',$5,$5,1)", [jobId, report.workspaceId, projectId, customerId, key]);
      await enqueueNotification(client, { kind: 'design-ready', workspaceId: report.workspaceId, recipientUserId: customerId, jobId, attempt: 1 });
    });
    for (const [size, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
      await customer.setViewportSize({ width, height }); await staff.setViewportSize({ width, height });
      await go(customer, '/app/inbox', 'Your inbox');
      await focusCheck(customer, customer.getByRole('button', { name: 'Mark as read', exact: true }), `${size}: inbox action has visible keyboard focus`);
      await snapshot(customer, `${size}-inbox`);
      await go(customer, '/app/support', 'Your support conversations'); await snapshot(customer, `${size}-support-history`);
      await go(customer, `/app/support/${requestId}`, 'Support conversation');
      await focusCheck(customer, customer.getByRole('button', { name: 'Send reply', exact: true }), `${size}: customer reply button has visible keyboard focus`);
      await snapshot(customer, `${size}-customer-conversation`);
      await go(staff, `/app/operator/support/${requestId}`, 'Support conversation'); await snapshot(staff, `${size}-staff-private-gate`);
      await openPrivate(staff, `Synthetic ${size} visual QA of the saved support conversation.`);
      requireCheck(`${size}: internal note appears only to explicitly authorized staff`, await staff.getByText(internalNote, { exact: true }).isVisible());
      await snapshot(staff, `${size}-staff-conversation`);
      if (size === 'mobile') {
        await (await unique(staff.getByLabel('Customer-visible reply', { exact: true }))).fill('Synthetic mobile preview only. This draft will be cancelled, not sent.');
        await (await unique(staff.getByRole('button', { name: 'Review reply', exact: true }))).click();
        await staff.getByRole('dialog').waitFor();
        await focusCheck(staff, staff.getByRole('dialog').getByRole('button', { name: 'Send reply', exact: true }), 'mobile: review send button has visible keyboard focus');
        await snapshot(staff, 'mobile-staff-reply-review');
        await (await unique(staff.getByRole('dialog').getByRole('button', { name: 'Go back', exact: true }))).click();
        // HTMLDialogElement queues its close event; wait for that event's cleanup.
        await staff.waitForFunction(() => { const modal = document.querySelector<HTMLDialogElement>('#modal'); return modal && !modal.open && modal.textContent === ''; });
        requireCheck('mobile: cancelling review clears the private modal content', !await staff.getByRole('dialog').isVisible() && (await staff.locator('#modal').textContent()) === '');
      }
      await go(staff, '/app/operator/report?days=7', 'Activity report');
      requireCheck(`${size}: report identifies nonproduction and token-count limitations`, (await staff.locator('main').innerText()).includes('Nonproduction activity') && (await staff.locator('main').innerText()).includes('not monetary cost estimates'));
      requireCheck(`${size}: report excludes support/private content`, !(await staff.locator('main').innerText()).includes(internalNote) && !(await staff.locator('main').innerText()).includes(initialMessage));
      await focusCheck(staff, staff.getByRole('button', { name: 'Refresh report', exact: true }), `${size}: report refresh has visible keyboard focus`);
      await snapshot(staff, `${size}-operator-report`);
      await (await unique(staff.getByLabel('Reporting window', { exact: true }))).selectOption('90');
      await staff.waitForURL(/days=90$/); await ready(staff, 'Activity report');
      requireCheck(`${size}: reporting window action refreshes data`, await staff.getByLabel('Reporting window', { exact: true }).inputValue() === '90');
      await go(customer, '/app/operator/report', 'Operator access required');
      requireCheck(`${size}: customer cannot view staff report`, (await customer.locator('main').innerText()).includes('403 · Access denied') && !await customer.getByRole('heading', { name: 'Provider usage', exact: true }).count());
      await snapshot(customer, `${size}-operator-denied`);
    }
    requireCheck('no uncaught browser runtime errors', report.pageErrors.length === 0, report.pageErrors);
    requireCheck('only expected injected HTTP failure occurred', report.responses.every((item: any) => item.path === '/api/notifications/read' && item.status === 503), report.responses);
    report.completed = true;
  } catch (error: any) {
    report.error = { message: error.message, stack: error.stack };
    for (const [name, page] of [['customer', customer], ['staff', staff]] as const) await snapshot(page, `failure-${name}`).catch(() => {});
  } finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); await runtime.app.close(); await db.end();
  }
  console.log(JSON.stringify({ output, report: join(output, 'report.json'), completed: report.completed, checks: report.checks.length, failedChecks: report.checks.filter((item: any) => !item.pass), screenshots: report.screenshots, error: report.error?.message }, null, 2));
  if (!report.completed || report.checks.some((item: any) => !item.pass)) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
