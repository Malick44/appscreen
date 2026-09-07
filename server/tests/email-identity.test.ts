import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { serviceEmail, verifiedEmailResolver } from '../email.js';
import { EmailDeliveryError } from '../email-provider.js';
import type { NotificationKind } from '../notifications.js';

// Complete synthetic configuration: never inherit developer credentials or URLs.
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused/unused_email_identity_test',
  APPSCREEN_SIGNING_SECRET: 'synthetic-email-identity-signing-secret-'.repeat(3),
  APP_BASE_URL: 'https://appscreen.example', SUPABASE_URL: 'https://identity.example',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-service-key',
  APPSCREEN_EMAIL_ENABLED: 'true', APPSCREEN_EMAIL_FROM: 'notifications@example.com',
  RESEND_API_KEY: 're_synthetic_identity_test_key',
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('synthetic-email-identity-webhook-key').toString('base64')}`,
};
const userId = 'ad2eb319-4737-4315-8b5b-d284ad773850';
const currentEmail = 'current-recipient@example.com';
const privateMarker = `private-identity-marker ${currentEmail} ${environment.SUPABASE_SERVICE_ROLE_KEY}`;
const confirmedAt = new Date(Date.now() - 60_000).toISOString();
function user(overrides: Record<string, unknown> = {}) {
  return { id: userId, email: currentEmail, email_confirmed_at: confirmedAt,
    is_anonymous: false, created_at: confirmedAt, app_metadata: {}, user_metadata: {},
    aud: 'authenticated', ...overrides };
}
function mockFetch(t: TestContext, implementation: typeof fetch = async () => {
  throw new Error('This isolated test forbids network requests.');
}) {
  const stub = t.mock.method(globalThis, 'fetch', implementation);
  t.after(() => stub.mock.restore());
  return stub;
}
function safeIdentityError(error: unknown) {
  assert.ok(error instanceof EmailDeliveryError);
  assert.equal(error.code, 'EMAIL_IDENTITY_UNAVAILABLE');
  assert.equal(error.retryable, true);
  assert.equal(error.message, 'The email operation could not be completed.');
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /private-identity-marker|current-recipient|synthetic-private-service-key/);
  return true;
}

test('email identity resolves the current confirmed Supabase address on every attempt', async t => {
  let activeUser = user();
  const stub = mockFetch(t, async (url, options) => {
    assert.equal(String(url), `https://identity.example/auth/v1/admin/users/${userId}`);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).get('Authorization'), `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`);
    return Response.json(activeUser);
  });
  const resolve = verifiedEmailResolver(loadConfig(environment));
  assert.equal(await resolve(userId), currentEmail);
  activeUser = user({ email: 'updated-recipient@example.com', email_change: 'unconfirmed-next@example.com' });
  assert.equal(await resolve(userId), 'updated-recipient@example.com');
  activeUser = user({ email: currentEmail, banned_until: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(await resolve(userId), currentEmail);
  assert.equal(stub.mock.callCount(), 3);
});

test('email identity declines unconfirmed, malformed, anonymous, deleted, banned and mismatched users', async t => {
  let activeUser: unknown = user();
  mockFetch(t, async () => Response.json(activeUser));
  const resolve = verifiedEmailResolver(loadConfig(environment));
  for (const invalid of [
    user({ email_confirmed_at: null, confirmed_at: confirmedAt }),
    user({ email_confirmed_at: '' }), user({ email_confirmed_at: 'invalid-confirmation-date' }),
    user({ email_confirmed_at: new Date(Date.now() + 60_000).toISOString() }),
    user({ email: undefined }), user({ email: '' }), user({ email: 'not-an-email' }),
    user({ email: 'recipient@example.com\r\nBcc: other@example.com' }),
    user({ email: { address: currentEmail } }), user({ email: ['recipient@example.com'] }),
    user({ is_anonymous: true }), user({ deleted_at: confirmedAt }),
    user({ banned_until: new Date(Date.now() + 60_000).toISOString() }),
    user({ id: '9d6573e3-81ef-415e-8dd8-d616503ca806' }),
    {}, { user: null },
  ]) {
    activeUser = invalid;
    assert.equal(await resolve(userId), null);
  }
});

test('email identity treats a deleted or missing Supabase user as undeliverable', async t => {
  mockFetch(t, async () => Response.json({ message: privateMarker, code: 'user_not_found' }, { status: 404 }));
  assert.equal(await verifiedEmailResolver(loadConfig(environment))(userId), null);
});

test('email identity never queries Supabase for development accounts, invalid IDs or absent configuration', async t => {
  const stub = mockFetch(t);
  const config = loadConfig(environment);
  for (const disabled of [
    { ...config, developmentAuth: true }, { ...config, supabaseServiceKey: '' }, { ...config, supabaseUrl: '' },
  ]) assert.equal(await verifiedEmailResolver(disabled)(userId), null);
  const resolve = verifiedEmailResolver(config);
  for (const invalidId of ['', 'dev:'.concat('a'.repeat(64)), 'current-recipient@example.com', 'not-a-uuid']) {
    assert.equal(await resolve(invalidId), null);
  }
  assert.equal(stub.mock.callCount(), 0);
});

test('email identity redacts transient provider and network failures without logging private details', async t => {
  let nextResponse: (() => Promise<Response>) = async () => { throw new Error(privateMarker); };
  mockFetch(t, async () => nextResponse());
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args));
  const resolve = verifiedEmailResolver(loadConfig(environment));
  for (const failure of [
    async () => { throw new Error(privateMarker); },
    async () => { throw new DOMException(privateMarker, 'AbortError'); },
    ...[401, 403, 408, 429, 500, 503].map(status => async () => Response.json({ message: privateMarker }, { status })),
    async () => new Response(privateMarker, { status: 200 }),
  ]) {
    nextResponse = failure;
    await assert.rejects(resolve(userId), safeIdentityError);
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-identity-marker|current-recipient|synthetic-private-service-key/);
});

test('enabled service email requires real identity, complete secrets and HTTPS destinations', t => {
  const stub = mockFetch(t);
  const production = { ...environment, NODE_ENV: 'production' };
  const accepted = loadConfig(production);
  assert.equal(accepted.emailEnabled, true);
  assert.equal(accepted.developmentAuth, false);
  const invalidSettings: NodeJS.ProcessEnv[] = [
    { NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true' },
    ...['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'APPSCREEN_EMAIL_FROM', 'APPSCREEN_SIGNING_SECRET'].map(name => ({ [name]: '' })),
    { APP_BASE_URL: 'http://appscreen.example' }, { SUPABASE_URL: 'http://identity.example' },
    { APP_BASE_URL: 'javascript:alert(1)' }, { SUPABASE_URL: 'file:///private/local' },
    { APPSCREEN_EMAIL_FROM: 'notifications@example.com\r\nBcc: other@example.com' },
    { APPSCREEN_EMAIL_FROM: 'notifications@example.com\n' },
  ];
  for (const changes of invalidSettings) {
    assert.throws(() => loadConfig({ ...production, ...changes }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /synthetic-private-service-key|re_synthetic_identity|notifications@example|other@example/);
      return true;
    });
  }
  assert.equal(stub.mock.callCount(), 0);
});

test('service email stays disabled by default and permits isolated development without email credentials', t => {
  const stub = mockFetch(t);
  const config = loadConfig({
    NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: environment.DATABASE_URL,
    APPSCREEN_SIGNING_SECRET: environment.APPSCREEN_SIGNING_SECRET,
  });
  assert.equal(config.emailEnabled, false);
  assert.equal(config.developmentAuth, true);
  assert.equal(config.resendKey, '');
  assert.equal(config.resendWebhookSecret, '');
  assert.equal(stub.mock.callCount(), 0);
});

test('all service emails contain static HTML and text with only the authenticated inbox link', t => {
  const stub = mockFetch(t);
  const config = loadConfig({ ...environment, APP_BASE_URL: 'https://appscreen.example/customer-path?token=private-customer-marker#private-customer-marker' });
  const titles: Record<NotificationKind, string> = {
    'design-ready': 'Your design is ready', 'needs-review': 'Your campaign needs review',
    'job-failed': 'A campaign job needs attention', 'export-ready': 'Your export is ready',
    'payment-needs-attention': 'Your payment needs attention', 'support-reply': 'Support replied',
  };
  for (const kind of Object.keys(titles) as NotificationKind[]) {
    const payload = serviceEmail(config, kind, currentEmail);
    assert.deepEqual(Object.keys(payload).sort(), ['from', 'html', 'subject', 'text', 'to']);
    assert.equal(payload.from, 'AppScreen <notifications@example.com>');
    assert.deepEqual(payload.to, [currentEmail]);
    assert.equal(payload.subject, titles[kind]);
    assert.match(payload.html, /^<!doctype html>/);
    assert.ok(payload.text.startsWith(`${titles[kind]}\n\n`));
    assert.deepEqual([...payload.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['https://appscreen.example/app/inbox']);
    assert.deepEqual(payload.text.match(/https?:\/\/\S+/g), ['https://appscreen.example/app/inbox']);
    assert.match(payload.text, /Sign in to AppScreen/);
    for (const body of [payload.html, payload.text]) {
      assert.match(body, /Manage email preferences in your AppScreen inbox/);
      assert.match(body, /Account sign-in and recovery emails are managed separately/);
      assert.doesNotMatch(body, /private-customer-marker|customer-path|current-recipient@example|synthetic-private|re_synthetic|download_token|support body|project name/);
    }
    assert.throws(() => serviceEmail(config, kind, 'recipient@example.com\r\nBcc: other@example.com'));
  }
  assert.equal(stub.mock.callCount(), 0);
});
