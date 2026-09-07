import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { createApp } from '../app.js';
import { createDatabase, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { ALL_SCOPES, hash } from '../auth.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// Stripe can mark a zero-value invoice paid without a payment. Entitlements
// and the paid-conversion metric have deliberately different admission rules.
// https://docs.stripe.com/invoicing/overview
test('paid conversion requires a positive verified invoice amount without changing entitlement grants', { skip: !databaseUrl, timeout: 60_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /(?:^|[_/-])test(?:[_/-]|$)/);
  const db = createDatabase(databaseUrl!);
  await migrate(db);
  const secret = 'whsec_metrics_review_no_live_provider';
  const priceId = 'price_metrics_review';
  const config = loadConfig({
    NODE_ENV: 'test', APPSCREEN_DEV_AUTH: 'true', DATABASE_URL: databaseUrl!,
    APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APP_BASE_URL: 'http://localhost',
    APPSCREEN_STORAGE_PATH: await mkdtemp(join(tmpdir(), 'appscreen-metrics-review-')),
    STRIPE_SECRET_KEY: 'sk_test_metrics_review_no_live_provider', STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_PRO_PRICE_ID: priceId, PRO_MONTHLY_CREDITS: '100', APPSCREEN_ENABLE_AI: 'false',
  });
  const { app, auth, billing } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.end(); });
  await app.ready();
  const email = `metrics-review-${randomUUID()}@example.test`;
  await auth.developmentSession(email);
  const ctx = await auth.resolveContext(`dev:${hash(email)}`, email, undefined, 'development', [...ALL_SCOPES]);
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  await db.query('UPDATE subscriptions SET customer_id=$1 WHERE workspace_id=$2', [customerId, ctx.workspaceId]);
  const subscription = {
    id: subscriptionId, customer: customerId, status: 'active', created: 1_800_000_000,
    items: { data: [{ price: { id: priceId }, current_period_end: 2_000_000_000 }] },
  };
  const invoices = new Map<string, any>();
  const webhooks = new Stripe('sk_test_metrics_review_no_live_provider').webhooks;
  // Every method used by the billing implementation is supplied here. The SDK
  // instance above is used only for local signature creation and verification.
  billing.stripe = {
    webhooks,
    subscriptions: { list: async (args: any) => {
      assert.equal(args.customer, customerId); assert.equal(args.status, 'all');
      return { data: [structuredClone(subscription)], has_more: false };
    } },
    invoices: { retrieve: async (id: string) => {
      assert.ok(invoices.has(id)); return structuredClone(invoices.get(id));
    } },
  } as unknown as Stripe;
  let period = 1_800_000_000;
  const invoice = (amount: unknown) => {
    period += 2_592_000;
    const value = {
      id: `in_${randomUUID()}`, customer: customerId, status: 'paid', billing_reason: 'subscription_cycle',
      ...(amount === undefined ? {} : { amount_paid: amount }),
      parent: { subscription_details: { subscription: subscriptionId } },
      lines: { has_more: false, data: [{
        id: `il_${randomUUID()}`, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: subscriptionId, proration: false } },
        pricing: { price_details: { price: priceId } }, period: { start: period, end: period + 2_592_000 },
      }] },
    };
    invoices.set(value.id, value); return value;
  };
  const event = (value: any, amountInEvent: unknown) => ({
    id: `evt_${randomUUID()}`, object: 'event', type: 'invoice.paid', created: Math.floor(Date.now() / 1000),
    livemode: false, data: { object: { ...value, amount_paid: amountInEvent } },
  });
  const deliver = async (value: any) => {
    const payload = JSON.stringify(value);
    const response = await app.inject({
      method: 'POST', url: '/api/billing/webhook', payload: Buffer.from(payload),
      headers: { 'content-type': 'application/json', 'stripe-signature': webhooks.generateTestHeaderString({ payload, secret }) },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const conversions = async () => (await db.query("SELECT occurred_at FROM product_milestones WHERE workspace_id=$1 AND milestone='paid_conversion'", [ctx.workspaceId])).rows;
  const grants = async () => Number((await db.query('SELECT count(*) AS count FROM billing_credit_grants WHERE workspace_id=$1', [ctx.workspaceId])).rows[0].count);

  await t.test('zero, missing and malformed authoritative amounts do not count, even when the event claims payment', async () => {
    for (const amount of [0, undefined, -1, 0.5, '1900', Number.MAX_SAFE_INTEGER + 1]) {
      await deliver(event(invoice(amount), 1900));
      assert.equal((await conversions()).length, 0, `Invalid paid-conversion amount: ${String(amount)}`);
    }
    assert.equal(await grants(), 6, 'Metric validation must not change subscription entitlement grants');
  });

  await t.test('a positive refetched amount counts once across event and invoice replays', async () => {
    const positive = invoice(1900);
    const first = event(positive, 0); // Event snapshots are not authoritative.
    await deliver(first);
    const recorded = await conversions();
    assert.equal(recorded.length, 1);
    await deliver(first);
    await deliver(event(positive, 0));
    await deliver(event(invoice(1900), 0));
    assert.deepEqual(await conversions(), recorded, 'Later paid periods must not move first-conversion time');
    assert.equal(await grants(), 8);
    const balance = (await db.query("SELECT sum(amount)::integer AS amount FROM credit_ledger WHERE workspace_id=$1 AND reason='subscription'", [ctx.workspaceId])).rows[0].amount;
    assert.equal(balance, 800, 'Duplicate webhook events must not duplicate the credit grant');
  });
});
