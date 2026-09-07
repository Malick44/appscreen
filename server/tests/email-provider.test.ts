import test from 'node:test';
import assert from 'node:assert/strict';
import { Webhook } from 'svix';
import { createResendProvider, EmailDeliveryError, type EmailPayload, verifyResendEvent } from '../email-provider.js';

const messageId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const payload: EmailPayload = {
  from: 'AppScreen <notifications@example.com>', to: ['recipient@example.com'],
  subject: 'Your export is ready', html: '<p>Your export is ready.</p>', text: 'Your export is ready.',
};
const apiKey = 're_synthetic_test_key';
const secret = `whsec_${Buffer.from('synthetic-webhook-secret-32-bytes!').toString('base64')}`;
const privateText = 'private recipient@example.com and provider credential';
const expectError = (code: string, retryable: boolean) => (error: unknown) => {
  assert.ok(error instanceof EmailDeliveryError);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  assert.equal(error.message, 'The email operation could not be completed.');
  assert.doesNotMatch(JSON.stringify(error), /recipient@example|credential|re_synthetic/);
  assert.equal(error.cause, undefined);
  return true;
};
function signed(event: unknown, date = new Date()) {
  const raw = Buffer.isBuffer(event) ? event : Buffer.from(JSON.stringify(event));
  const eventId = 'msg_synthetic_delivery_1';
  return { raw, headers: {
    'svix-id': eventId, 'svix-timestamp': String(Math.floor(date.getTime() / 1000)),
    'svix-signature': new Webhook(secret).sign(eventId, date, raw),
  } };
}
function event(type = 'email.delivered') {
  return { type, created_at: '2026-09-04T10:20:30.123Z', data: {
    email_id: messageId, to: ['recipient@example.com'], subject: privateText,
    tags: { private: privateText }, from: 'sender@example.com',
  } };
}

test('Resend sends the immutable permitted JSON with the same idempotency key and no redirects', async () => {
  const requests: RequestInit[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    requests.push(options!);
    return Response.json({ id: messageId, private: privateText });
  };
  const provider = createResendProvider(apiKey, fetcher);
  const mutable = { ...payload, to: [...payload.to] };
  const pending = provider.send(mutable, 'notification/export-1');
  mutable.to[0] = 'different@example.com';
  mutable.subject = 'Changed';
  assert.deepEqual(await pending, { id: messageId });
  assert.deepEqual(await provider.send(payload, 'notification/export-1'), { id: messageId });
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(String(requests[0].body)), payload);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.equal(new Headers(request.headers).get('Idempotency-Key'), 'notification/export-1');
    assert.equal(new Headers(request.headers).get('Authorization'), `Bearer ${apiKey}`);
    assert.equal(new Headers(request.headers).get('Content-Type'), 'application/json');
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test('Resend rejects invalid payloads and header values before a network request', async () => {
  let calls = 0;
  const provider = createResendProvider(apiKey, async () => { calls++; return Response.json({ id: messageId }); });
  for (const invalid of [
    { ...payload, to: [] }, { ...payload, to: ['recipient@example.com', 'other@example.com'] },
    { ...payload, to: ['not-an-email'] }, { ...payload, subject: 'Header\r\ninjection' },
    { ...payload, bcc: ['other@example.com'] }, { ...payload, html: '' },
  ]) await assert.rejects(provider.send(invalid, 'valid-key'), expectError('EMAIL_PAYLOAD_INVALID', false));
  for (const key of ['', 'a'.repeat(257), 'injected\r\nvalue']) {
    await assert.rejects(provider.send(payload, key), expectError('EMAIL_PAYLOAD_INVALID', false));
  }
  await assert.rejects(createResendProvider('bad\nkey').send(payload, 'valid-key'), expectError('EMAIL_PROVIDER_NOT_CONFIGURED', false));
  assert.equal(calls, 0);
});

test('Resend classifies transient HTTP errors without disclosing provider bodies', async () => {
  for (const status of [408, 429, 500, 502, 503, 599]) {
    const provider = createResendProvider(apiKey, async () => Response.json({ message: privateText }, { status }));
    await assert.rejects(provider.send(payload, 'valid-key'), expectError('EMAIL_PROVIDER_REJECTED', true));
  }
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 422]) {
    const provider = createResendProvider(apiKey, async () => Response.json({ message: privateText }, { status, headers: { Location: 'https://untrusted.example' } }));
    await assert.rejects(provider.send(payload, 'valid-key'), expectError('EMAIL_PROVIDER_REJECTED', false));
  }
});

test('Resend retries only concurrent 409 requests and never retries a changed-payload conflict', async () => {
  for (const [name, code, retryable] of [
    ['concurrent_idempotent_requests', 'EMAIL_PROVIDER_BUSY', true],
    ['invalid_idempotent_request', 'EMAIL_IDEMPOTENCY_CONFLICT', false],
    ['unknown_error', 'EMAIL_IDEMPOTENCY_CONFLICT', false],
  ] as const) {
    const provider = createResendProvider(apiKey, async () => Response.json({ name, message: privateText }, { status: 409 }));
    await assert.rejects(provider.send(payload, 'valid-key'), expectError(code, retryable));
  }
  const malformed = createResendProvider(apiKey, async () => new Response(privateText, { status: 409 }));
  await assert.rejects(malformed.send(payload, 'valid-key'), expectError('EMAIL_IDEMPOTENCY_CONFLICT', false));
});

test('Resend redacts network failures and requires a UUID in successful responses', async () => {
  const unavailable = createResendProvider(apiKey, async () => { throw new Error(privateText); });
  await assert.rejects(unavailable.send(payload, 'valid-key'), expectError('EMAIL_PROVIDER_UNAVAILABLE', true));
  for (const response of [Response.json({ id: privateText }), Response.json({}), new Response(privateText), new Response('x'.repeat(65 * 1024))]) {
    const provider = createResendProvider(apiKey, async () => response);
    await assert.rejects(provider.send(payload, 'valid-key'), expectError('EMAIL_PROVIDER_RESPONSE_INVALID', true));
  }
});

test('Resend times out after ten seconds, including a stalled response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stalledBody of [false, true]) {
    let sentSignal: AbortSignal | null | undefined;
    let bodyReadStarted = false;
    const provider = createResendProvider(apiKey, async (_url, options) => {
      sentSignal = options?.signal;
      if (stalledBody) return new Response(new ReadableStream({ pull() { bodyReadStarted = true; } }, { highWaterMark: 0 }));
      return new Promise<Response>(() => {});
    });
    const pending = provider.send(payload, 'valid-key');
    const assertion = assert.rejects(pending, expectError('EMAIL_PROVIDER_TIMEOUT', true));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(bodyReadStarted, stalledBody);
    t.mock.timers.tick(9_999);
    assert.equal(sentSignal?.aborted, false);
    t.mock.timers.tick(1);
    await assertion;
    assert.equal(sentSignal?.aborted, true);
  }
});

test('Resend honors caller cancellation and never exposes the abort reason', async () => {
  let calls = 0;
  let sentSignal: AbortSignal | null | undefined;
  const provider = createResendProvider(apiKey, async (_url, options) => {
    calls++; sentSignal = options?.signal;
    return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const pending = provider.send(payload, 'valid-key', controller.signal);
  controller.abort(new Error(privateText));
  await assert.rejects(pending, expectError('EMAIL_PROVIDER_INTERRUPTED', true));
  assert.equal(sentSignal?.aborted, true);
  await assert.rejects(provider.send(payload, 'valid-key', controller.signal), expectError('EMAIL_PROVIDER_INTERRUPTED', true));
  assert.equal(calls, 1);
});

test('verified delivery events expose only the normalized minimal record', () => {
  for (const type of ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed']) {
    const request = signed(event(type));
    const result = verifyResendEvent(request.raw, request.headers, secret);
    assert.deepEqual(result, { eventId: 'msg_synthetic_delivery_1', messageId, type, createdAt: '2026-09-04T10:20:30.123Z', recipients: ['recipient@example.com'] });
    assert.doesNotMatch(JSON.stringify(result), /subject|private|sender@example/);
  }
});

test('webhook authentication uses exact raw bytes and validates signatures before ignoring tracking events', () => {
  const original = signed(Buffer.from(JSON.stringify(event(), null, 2)));
  assert.ok(verifyResendEvent(original.raw, original.headers, secret));
  assert.throws(() => verifyResendEvent(Buffer.from(JSON.stringify(event())), original.headers, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  assert.throws(() => verifyResendEvent(original.raw, original.headers, `whsec_${Buffer.alloc(32, 1).toString('base64')}`), expectError('EMAIL_WEBHOOK_INVALID', false));
  for (const type of ['email.opened', 'email.clicked']) {
    const request = signed(event(type));
    assert.equal(verifyResendEvent(request.raw, request.headers, secret), null);
    assert.throws(() => verifyResendEvent(request.raw, { ...request.headers, 'svix-signature': 'v1,invalid' }, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  }
});

test('webhook signature headers are bounded, unambiguous, and replay-time checked', () => {
  const request = signed(event());
  for (const [name, value] of [
    ['svix-id', ''], ['svix-id', 'x'.repeat(201)], ['svix-id', ['msg_duplicate']],
    ['svix-timestamp', '123invalid'], ['svix-timestamp', '1'.repeat(14)], ['svix-timestamp', undefined],
    ['svix-signature', 'x'.repeat(2049)], ['svix-signature', `${request.headers['svix-signature']}\r\n`],
  ] as const) {
    assert.throws(() => verifyResendEvent(request.raw, { ...request.headers, [name]: value }, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  }
  assert.throws(() => verifyResendEvent(request.raw, { ...request.headers, 'Svix-Id': request.headers['svix-id'] }, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  const upper = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toUpperCase(), value]));
  assert.ok(verifyResendEvent(request.raw, upper, secret));
  for (const delta of [-301_000, 301_000]) {
    const stale = signed(event(), new Date(Date.now() + delta));
    assert.throws(() => verifyResendEvent(stale.raw, stale.headers, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  }
});

test('authentic webhooks still require an allowed event, UUID, timestamp and exactly one valid recipient', () => {
  for (const invalid of [
    { ...event(), type: 'email.received' }, { ...event(), type: 'domain.created' },
    { ...event(), created_at: 'not-a-date' }, { ...event(), created_at: '2026-02-30T10:00:00Z' },
    { ...event(), data: { email_id: 'not-a-uuid', to: payload.to } },
    { ...event(), data: { email_id: messageId, to: [] } },
    { ...event(), data: { email_id: messageId, to: [...payload.to, 'other@example.com'] } },
    { ...event(), data: { email_id: messageId, to: ['invalid'] } },
    { ...event(), data: { email_id: messageId, to: 'recipient@example.com' } },
  ]) {
    const request = signed(invalid);
    assert.throws(() => verifyResendEvent(request.raw, request.headers, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  }
  for (const raw of [Buffer.from('{invalid JSON'), Buffer.from([0xff]), Buffer.alloc(256 * 1024 + 1, 32)]) {
    const request = signed(raw);
    assert.throws(() => verifyResendEvent(request.raw, request.headers, secret), expectError('EMAIL_WEBHOOK_INVALID', false));
  }
});
