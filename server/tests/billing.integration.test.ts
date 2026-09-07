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
import { hash, type Context } from '../auth.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const priceId='price_mock_appscreen_monthly';
const webhookSecret='whsec_isolated_test_no_real_billing';
const copy=<T>(value:T):T=>structuredClone(value);

// Only signature calculation/verification uses the real SDK. All provider calls
// use this in-memory transport; this suite cannot make a live Stripe request.
class MockStripe {
  customerRecords=new Map<string,any>();
  subscriptionRecords=new Map<string,any>();
  sessionRecords=new Map<string,any>();
  invoiceRecords=new Map<string,any>();
  chargeRecords=new Map<string,any>();
  customerKeys=new Map<string,{payload:any;value:any}>();
  checkoutKeys=new Map<string,{payload:any;value:any}>();
  customerCalls:any[]=[];
  checkoutCalls:any[]=[];
  portalCalls:any[]=[];
  subscriptionListCalls:any[]=[];
  failCheckoutBeforeCreate=false;
  failCheckoutAfterCreate=false;
  failCustomerAfterCreate=false;
  failListCustomer:string|null=null;
  price:any={id:priceId,active:true,unit_amount:1900,currency:'usd',recurring:{interval:'month',interval_count:1}};
  webhooks=new Stripe('sk_test_mock_not_a_real_key').webhooks;
  page=(records:any[],args:any)=>{
    const start=args.starting_after?records.findIndex(item=>item.id===args.starting_after)+1:0;
    const data=records.slice(start,start+(args.limit||100));
    return {data:copy(data),has_more:start+data.length<records.length};
  };
  customers={create:async(payload:any,options:any)=>{
    this.customerCalls.push(copy({payload,options}));
    const previous=this.customerKeys.get(options.idempotencyKey);
    if(previous){assert.deepEqual(payload,previous.payload,'a retried customer request must retain its original parameters');return copy(previous.value);}
    const value={id:`cus_${randomUUID()}`,...copy(payload)};
    this.customerRecords.set(value.id,value);this.customerKeys.set(options.idempotencyKey,{payload:copy(payload),value});
    if(this.failCustomerAfterCreate){this.failCustomerAfterCreate=false;throw new Error('Simulated transport loss after customer creation');}
    return copy(value);
  }};
  prices={retrieve:async(id:string)=>{assert.equal(id,priceId);return copy(this.price);}};
  subscriptions={
    list:async(args:any)=>{
      this.subscriptionListCalls.push(copy(args));
      if(this.failListCustomer===args.customer)throw new Error('Simulated provider outage');
      assert.equal(args.status,'all','reconciliation must include terminal subscriptions');
      return this.page([...this.subscriptionRecords.values()].filter(item=>item.customer===args.customer),args);
    },
    retrieve:async(id:string)=>{assert.ok(this.subscriptionRecords.has(id),`missing mock subscription ${id}`);return copy(this.subscriptionRecords.get(id));},
  };
  checkout={sessions:{
    create:async(payload:any,options:any)=>{
      this.checkoutCalls.push(copy({payload,options}));
      if(this.failCheckoutBeforeCreate){this.failCheckoutBeforeCreate=false;throw new Error('Simulated transport loss before checkout creation');}
      const previous=this.checkoutKeys.get(options.idempotencyKey);
      if(previous){assert.deepEqual(payload,previous.payload,'a retried checkout request must retain its original parameters');return copy(previous.value);}
      const id=`cs_${randomUUID()}`;
      const value={...copy(payload),id,status:'open',subscription:null,url:`https://checkout.stripe.test/${id}`,expires_at:Math.floor(Date.now()/1000)+86400};
      this.sessionRecords.set(id,value);this.checkoutKeys.set(options.idempotencyKey,{payload:copy(payload),value});
      if(this.failCheckoutAfterCreate){this.failCheckoutAfterCreate=false;throw new Error('Simulated transport loss after checkout creation');}
      return copy(value);
    },
    retrieve:async(id:string)=>{assert.ok(this.sessionRecords.has(id),`missing mock session ${id}`);return copy(this.sessionRecords.get(id));},
    list:async(args:any)=>this.page([...this.sessionRecords.values()].filter(item=>item.customer===args.customer&&(!args.status||item.status===args.status)),args),
  }};
  billingPortal={sessions:{create:async(payload:any)=>{this.portalCalls.push(copy(payload));return {url:`https://billing.stripe.test/${payload.customer}`};}}};
  invoices={
    retrieve:async(id:string)=>{assert.ok(this.invoiceRecords.has(id),`missing mock invoice ${id}`);return copy(this.invoiceRecords.get(id));},
    listLineItems:async(id:string,args:any)=>this.page(this.invoiceRecords.get(id).allLines,args),
  };
  charges={retrieve:async(id:string)=>{assert.ok(this.chargeRecords.has(id));return copy(this.chargeRecords.get(id));}};
  subscription(customer:string,status='active',extra:any={}) {
    const value={id:`sub_${randomUUID()}`,customer,status,created:Math.floor(Date.now()/1000),cancel_at_period_end:false,items:{data:[{id:`si_${randomUUID()}`,price:{id:priceId},current_period_end:2_000_000_000}]},...extra};
    this.subscriptionRecords.set(value.id,value);return value;
  }
  invoice(customer:string,subscription:string,start=1_800_000_000,extra:any={}) {
    const value={id:`in_${randomUUID()}`,customer,status:'paid',amount_paid:1900,billing_reason:'subscription_cycle',parent:{subscription_details:{subscription}},lines:{has_more:false,data:[{id:`il_${randomUUID()}`,parent:{type:'subscription_item_details',subscription_item_details:{subscription,proration:false}},pricing:{price_details:{price:priceId}},period:{start,end:start+2_592_000}}]},...extra};
    this.invoiceRecords.set(value.id,value);return value;
  }
}

test('real database billing lifecycle with verified webhooks and simulated Stripe', {skip:!databaseUrl,timeout:90_000}, async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/,'Only a dedicated test database may be used');
  const db=createDatabase(databaseUrl!);
  const storage=await mkdtemp(join(tmpdir(),'appscreen-billing-test-'));
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex'),APP_BASE_URL:'http://localhost',APPSCREEN_STORAGE_PATH:storage,STRIPE_SECRET_KEY:'sk_test_mock_not_a_real_key',STRIPE_WEBHOOK_SECRET:webhookSecret,STRIPE_PRO_PRICE_ID:priceId,PRO_PRICE_AMOUNT:'1900',PRO_MONTHLY_CREDITS:'100',TRIAL_CREDITS:'5',APPSCREEN_ENABLE_AI:'false'});
  let application:Awaited<ReturnType<typeof createApp>>;
  t.after(async()=>{await application?.app.close();await db.end();});
  await migrate(db);
  application=await createApp(config,db);
  const {app,auth,billing}=application;
  const mock=new MockStripe();billing.stripe=mock as unknown as Stripe;
  await app.ready();
  const run=randomUUID();
  const owner=async(label:string)=>{
    const email=`billing-${label}-${run}@integration.appscreen.test`;
    const {token}=await auth.developmentSession(email);
    const ctx=await auth.resolveContext(`dev:${hash(email)}`,email,undefined,'development',['projects:read','projects:write']);
    return {token,ctx};
  };
  const attachCustomer=async(ctx:Context)=>{
    const id=`cus_${randomUUID()}`;mock.customerRecords.set(id,{id});
    await db.query('UPDATE subscriptions SET customer_id=$1 WHERE workspace_id=$2',[id,ctx.workspaceId]);return id;
  };
  const event=(type:string,object:any)=>({id:`evt_${randomUUID()}`,object:'event',type,data:{object:copy(object)},created:Math.floor(Date.now()/1000),livemode:false,pending_webhooks:1,request:null,api_version:null}) as any;
  const deliver=async(payload:any,signature?:string)=>{
    const raw=JSON.stringify(payload);
    const header=signature||mock.webhooks.generateTestHeaderString({payload:raw,secret:webhookSecret});
    return app.inject({method:'POST',url:'/api/billing/webhook',headers:{'content-type':'application/json','stripe-signature':header},payload:Buffer.from(raw)});
  };
  const delivered=async(payload:any)=>{const response=await deliver(payload);assert.equal(response.statusCode,200,response.body);return response;};
  const monthly=async(workspaceId:string)=>(await db.query("SELECT count(*)::integer AS count,COALESCE(sum(amount),0)::integer AS amount FROM credit_ledger WHERE workspace_id=$1 AND reason='subscription'",[workspaceId])).rows[0];

  await t.test('concurrent and repeated checkout requests reuse one durable session beyond five minutes',async()=>{
    const {ctx}=await owner('concurrent');const before=mock.checkoutCalls.length;
    const results=await Promise.all(Array.from({length:4},()=>billing.checkout(ctx,{planId:'pro'})));
    assert.equal(new Set(results.map((result:any)=>result.checkoutId)).size,1);
    assert.equal(mock.checkoutCalls.length-before,1);
    const attempts=await db.query('SELECT * FROM billing_checkout_attempts WHERE workspace_id=$1',[ctx.workspaceId]);
    assert.equal(attempts.rowCount,1);assert.equal(attempts.rows[0].status,'open');
    assert.equal(mock.checkoutCalls.at(-1).options.idempotencyKey,`appscreen-checkout:${attempts.rows[0].id}`);
    await db.query("UPDATE billing_checkout_attempts SET created_at=now()-interval '2 hours' WHERE workspace_id=$1",[ctx.workspaceId]);
    const again:any=await billing.checkout(ctx,{planId:'pro'});
    assert.equal(again.checkoutId,(results[0] as any).checkoutId);assert.equal(again.reused,true);
    assert.equal(mock.checkoutCalls.length-before,1);
  });

  await t.test('customer creation intent preserves its key and original parameters after an uncertain response',async()=>{
    const {ctx}=await owner('customer-crash');const before=mock.customerCalls.length;
    mock.failCustomerAfterCreate=true;
    await assert.rejects(billing.checkout(ctx,{planId:'pro'}),/transport loss/);
    const intent=(await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.ok(intent.customer_request_started_at);assert.equal(intent.customer_id,null);
    await billing.checkout({...ctx,email:'changed-email@integration.appscreen.test'},{planId:'pro'});
    assert.equal(mock.customerCalls.length-before,2);
    assert.deepEqual(mock.customerCalls.at(-1),mock.customerCalls.at(-2));
    assert.equal([...mock.customerRecords.values()].filter(item=>item.metadata?.workspaceId===ctx.workspaceId).length,1);
  });

  await t.test('checkout creation survives response loss without creating a second session',async()=>{
    const {ctx}=await owner('checkout-crash');const before=mock.checkoutCalls.length;
    mock.failCheckoutAfterCreate=true;
    await assert.rejects(billing.checkout(ctx,{planId:'pro'}),/transport loss/);
    const intent=(await db.query('SELECT * FROM billing_checkout_attempts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.equal(intent.status,'creating');assert.equal(intent.session_id,null);
    const recovered:any=await billing.checkout(ctx,{planId:'pro'});
    assert.equal(recovered.reused,true);assert.equal(mock.checkoutCalls.length-before,1);
    assert.equal([...mock.sessionRecords.values()].filter(item=>item.metadata?.workspaceId===ctx.workspaceId).length,1);
  });

  await t.test('pre-write provider failures replay the persisted checkout payload and idempotency key',async()=>{
    const {ctx}=await owner('checkout-before');mock.failCheckoutBeforeCreate=true;
    await assert.rejects(billing.checkout(ctx,{planId:'pro'}),/transport loss/);
    await billing.checkout(ctx,{planId:'pro'});
    assert.deepEqual(mock.checkoutCalls.at(-1),mock.checkoutCalls.at(-2));
  });

  await t.test('old uncertain checkout/customer writes require review instead of reusing a pruned key',async()=>{
    const {ctx}=await owner('checkout-old');mock.failCheckoutBeforeCreate=true;
    await assert.rejects(billing.checkout(ctx,{planId:'pro'}),/transport loss/);
    await db.query("UPDATE billing_checkout_attempts SET created_at=now()-interval '25 hours' WHERE workspace_id=$1",[ctx.workspaceId]);
    const before=mock.checkoutCalls.length;
    for(let n=0;n<2;n++)await assert.rejects(billing.checkout(ctx,{planId:'pro'}),{code:'BILLING_REVIEW_REQUIRED'});
    assert.equal(mock.checkoutCalls.length,before);
    const audits=await db.query("SELECT count(*)::integer AS count FROM audit_events WHERE workspace_id=$1 AND action='billing.review-required'",[ctx.workspaceId]);
    assert.equal(audits.rows[0].count,1);
    const other=await owner('customer-old');
    await db.query("UPDATE subscriptions SET customer_request_started_at=now()-interval '25 hours',customer_request_payload=$2 WHERE workspace_id=$1",[other.ctx.workspaceId,{email:other.ctx.email}]);
    const customerCalls=mock.customerCalls.length;
    await assert.rejects(billing.checkout(other.ctx,{planId:'pro'}),{code:'BILLING_REVIEW_REQUIRED'});
    assert.equal(mock.customerCalls.length,customerCalls);
  });

  await t.test('all nonterminal subscriptions block duplicate checkout, including paused and unpaid',async()=>{
    for(const status of ['active','trialing','past_due','incomplete','unpaid','paused']) {
      const {ctx}=await owner(status),customer=await attachCustomer(ctx);mock.subscription(customer,status);
      const before=mock.checkoutCalls.length;
      const result:any=await billing.checkout(ctx,{planId:'pro'});
      assert.equal(result.destination,'portal',status);assert.equal(mock.checkoutCalls.length,before,status);
      assert.equal((await db.query('SELECT status FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,status);
    }
    for(const status of ['canceled','incomplete_expired']) {
      const {ctx}=await owner(status),customer=await attachCustomer(ctx);mock.subscription(customer,status);
      assert.ok((await billing.checkout(ctx,{planId:'pro'}) as any).checkoutId,status);
    }
  });

  await t.test('only expired or terminal-subscription checkout sessions permit a replacement',async()=>{
    const {ctx}=await owner('expired');const first:any=await billing.checkout(ctx,{planId:'pro'});
    mock.sessionRecords.get(first.checkoutId).status='expired';
    const second:any=await billing.checkout(ctx,{planId:'pro'});assert.notEqual(second.checkoutId,first.checkoutId);
    const complete=mock.sessionRecords.get(second.checkoutId);complete.status='complete';complete.subscription=null;complete.url=null;
    const before=mock.checkoutCalls.length;
    for(let n=0;n<2;n++)assert.equal((await billing.checkout(ctx,{planId:'pro'}) as any).destination,'portal');
    assert.equal(mock.checkoutCalls.length,before,'complete-but-processing sessions remain guarded on subsequent visits');
    const terminal=mock.subscription(complete.customer,'canceled');complete.subscription=terminal.id;
    assert.ok((await billing.checkout(ctx,{planId:'pro'}) as any).checkoutId);
  });

  await t.test('untracked open checkout and mismatched configured prices fail closed',async()=>{
    const {ctx}=await owner('legacy-open'),customer=await attachCustomer(ctx);
    const id=`cs_${randomUUID()}`;mock.sessionRecords.set(id,{id,customer,mode:'subscription',status:'open',metadata:{},url:'https://checkout.stripe.test/legacy'});
    await assert.rejects(billing.checkout(ctx,{planId:'pro'}),{code:'CHECKOUT_ALREADY_OPEN'});
    const other=await owner('price');const before=mock.checkoutCalls.length;
    mock.price.unit_amount=2900;
    try{await assert.rejects(billing.checkout(other.ctx,{planId:'pro'}),{code:'PRICE_INVALID'});}finally{mock.price.unit_amount=1900;}
    assert.equal(mock.checkoutCalls.length,before);
  });

  await t.test('a missing previously known subscription blocks a replacement and records one review',async()=>{
    const {ctx}=await owner('missing-subscription');await attachCustomer(ctx);
    await db.query('UPDATE subscriptions SET subscription_id=$1 WHERE workspace_id=$2',[`sub_${randomUUID()}`,ctx.workspaceId]);
    const before=mock.checkoutCalls.length;
    for(let n=0;n<2;n++)await assert.rejects(billing.checkout(ctx,{planId:'pro'}),{code:'BILLING_REVIEW_REQUIRED'});
    assert.equal(mock.checkoutCalls.length,before);
    const saved=(await db.query('SELECT status,reconciliation_required FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.equal(saved.status,'unpaid');assert.equal(saved.reconciliation_required,true);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM billing_review_items WHERE workspace_id=$1 AND reason='subscription-missing'",[ctx.workspaceId])).rows[0].count,1);
  });

  await t.test('stale cancelled events cannot replace an active subscription, including webhook bursts',async()=>{
    const {ctx}=await owner('out-of-order'),customer=await attachCustomer(ctx);
    const old=mock.subscription(customer,'canceled',{created:100}),active=mock.subscription(customer,'active',{created:200});
    await billing.syncSubscription(old.id);
    let saved=(await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.equal(saved.subscription_id,active.id);assert.equal(saved.status,'active');
    await Promise.all(Array.from({length:14},()=>delivered(event('customer.subscription.deleted',old))));
    saved=(await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.equal(saved.subscription_id,active.id);assert.equal(saved.status,'active');
    assert.ok(mock.subscriptionListCalls.every(call=>call.status==='all'));
  });

  await t.test('multiple live subscriptions trigger one review audit, without starting another',async()=>{
    const {ctx}=await owner('duplicate-active'),customer=await attachCustomer(ctx);
    mock.subscription(customer,'active',{created:10});const newest=mock.subscription(customer,'active',{created:20});
    await billing.syncCustomer(customer);await billing.syncCustomer(customer);
    const saved=(await db.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
    assert.equal(saved.subscription_id,newest.id);assert.equal(saved.reconciliation_required,true);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM audit_events WHERE workspace_id=$1 AND action='billing.review-required'",[ctx.workspaceId])).rows[0].count,1);
    const before=mock.checkoutCalls.length;await billing.checkout(ctx,{planId:'pro'});assert.equal(mock.checkoutCalls.length,before);
  });

  await t.test('invalid signatures are rejected before any durable billing event is inserted',async()=>{
    const payload=event('customer.subscription.updated',{id:'sub_untrusted',customer:'cus_untrusted'});
    const response=await deliver(payload,'t=1,v1=not-a-valid-signature');
    assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'WEBHOOK_SIGNATURE_INVALID');
    assert.equal((await db.query('SELECT id FROM billing_events WHERE id=$1',[payload.id])).rowCount,0);
  });

  await t.test('verified provider failures return retryable 503 and replay the durable event safely',async()=>{
    const {ctx}=await owner('webhook-retry'),customer=await attachCustomer(ctx),sub=mock.subscription(customer);
    const invoice=mock.invoice(customer,sub.id),payload=event('invoice.paid',invoice);
    mock.failListCustomer=customer;
    const response=await deliver(payload);
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'BILLING_EVENT_RETRY');
    const pending=(await db.query('SELECT * FROM billing_events WHERE id=$1',[payload.id])).rows[0];
    assert.equal(pending.processed_at,null);assert.equal(pending.attempts,1);assert.ok(pending.next_attempt_at);assert.equal((await monthly(ctx.workspaceId)).count,0);
    mock.failListCustomer=null;await delivered(payload);await delivered(payload);
    const done=(await db.query('SELECT * FROM billing_events WHERE id=$1',[payload.id])).rows[0];
    assert.ok(done.processed_at);assert.equal(done.error_code,null);assert.deepEqual(await monthly(ctx.workspaceId),{count:1,amount:100});
  });

  await t.test('invoice, event and billing-period duplicates never grant credits twice; renewal grants once',async()=>{
    const {ctx}=await owner('periods'),customer=await attachCustomer(ctx),sub=mock.subscription(customer);
    const invoice=mock.invoice(customer,sub.id),duplicate=mock.invoice(customer,sub.id),payload=event('invoice.paid',invoice);
    await delivered(payload);await delivered(payload);
    await Promise.all([delivered(event('invoice.paid',invoice)),delivered(event('invoice.paid',duplicate))]);
    assert.deepEqual(await monthly(ctx.workspaceId),{count:1,amount:100});
    assert.equal((await db.query('SELECT * FROM billing_credit_grants WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,1);
    const renewal=mock.invoice(customer,sub.id,1_802_592_000);
    await delivered(event('invoice.paid',renewal));assert.deepEqual(await monthly(ctx.workspaceId),{count:2,amount:200});
    assert.equal((await db.query("SELECT 1 FROM product_milestones WHERE workspace_id=$1 AND milestone='paid_conversion'",[ctx.workspaceId])).rowCount,1,'renewals and replays count one paid conversion');
  });

  await t.test('payment-failed, one-off, proration and unrelated-price invoices do not grant monthly credits',async()=>{
    const {ctx}=await owner('nongrants'),customer=await attachCustomer(ctx),sub=mock.subscription(customer);
    const failed=mock.invoice(customer,sub.id,1_810_000_000,{paid:false,status:'open'});
    await delivered(event('invoice.payment_failed',failed));
    const oneoff=mock.invoice(customer,sub.id,1_820_000_000,{billing_reason:'manual'});await delivered(event('invoice.paid',oneoff));
    const proration=mock.invoice(customer,sub.id,1_830_000_000);proration.lines.data[0].parent.subscription_item_details.proration=true;await delivered(event('invoice.paid',proration));
    const unrelated=mock.invoice(customer,sub.id,1_840_000_000);unrelated.lines.data[0].pricing.price_details.price='price_other';await delivered(event('invoice.paid',unrelated));
    const item=mock.invoice(customer,sub.id,1_850_000_000);item.lines.data[0].parent={type:'invoice_item_details'};await delivered(event('invoice.paid',item));
    assert.deepEqual(await monthly(ctx.workspaceId),{count:0,amount:0});
    assert.equal((await db.query('SELECT status FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,'active');
    assert.equal((await db.query("SELECT 1 FROM product_milestones WHERE workspace_id=$1 AND milestone='paid_conversion'",[ctx.workspaceId])).rowCount,0,'active subscription status is not proof of a paid conversion');
  });

  await t.test('payment attention notice commits with a reconciled failure, retries once and ignores stale failures',async()=>{
    const {ctx}=await owner('payment-notice'),customer=await attachCustomer(ctx),sub=mock.subscription(customer,'past_due');
    const invoice=mock.invoice(customer,sub.id,1_810_000_000,{status:'open'}),payload=event('invoice.payment_failed',invoice);
    const originalAtomic=(billing as any).atomic.bind(billing);let fail=true;
    (billing as any).atomic=async(client:any,work:any)=>{
      const query=client.query;
      client.query=function(sql:any,values:any){if(fail&&typeof sql==='string'&&sql.startsWith('UPDATE billing_events SET processed_at')&&values?.[0]===payload.id){fail=false;throw new Error('Isolated notification commit failure');}return query.apply(this,arguments as any);};
      try{return await originalAtomic(client,work);}finally{client.query=query;}
    };
    try{assert.equal((await deliver(payload)).statusCode,503);}finally{(billing as any).atomic=originalAtomic;}
    const notices=async()=>(await db.query('SELECT kind,recipient_user_id FROM notifications WHERE workspace_id=$1',[ctx.workspaceId])).rows;
    assert.deepEqual(await notices(),[],'a rolled-back payment event cannot leave a notification');
    await Promise.all([delivered(payload),delivered(payload)]);
    assert.deepEqual(await notices(),[{kind:'payment-needs-attention',recipient_user_id:ctx.userId}]);
    sub.status='active';await delivered(event('invoice.payment_failed',invoice));
    assert.equal((await notices()).length,1,'an old failure cannot notify again after authoritative recovery');
    assert.deepEqual(await monthly(ctx.workspaceId),{count:0,amount:0});
  });

  await t.test('legacy invoice grants are not minted again and paginated modern line items are supported',async()=>{
    const {ctx}=await owner('legacy-grants'),customer=await attachCustomer(ctx),sub=mock.subscription(customer);
    const invoice=mock.invoice(customer,sub.id);
    await db.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,100,'subscription',$3)",[randomUUID(),ctx.workspaceId,`invoice:${invoice.id}`]);
    await delivered(event('invoice.paid',invoice));assert.deepEqual(await monthly(ctx.workspaceId),{count:1,amount:100});
    const modern:any=mock.invoice(customer,sub.id,1_802_592_000);modern.allLines=copy(modern.lines.data);modern.lines={has_more:true,data:[]};
    await delivered(event('invoice.paid',modern));assert.deepEqual(await monthly(ctx.workspaceId),{count:2,amount:200});
    const legacy:any=mock.invoice(customer,sub.id,1_805_184_000);legacy.subscription=sub.id;delete legacy.parent;
    legacy.lines.data=[{id:`il_${randomUUID()}`,type:'subscription',subscription:sub.id,price:{id:priceId},proration:false,period:{start:1_805_184_000,end:1_807_776_000}}];
    await delivered(event('invoice.paid',legacy));assert.deepEqual(await monthly(ctx.workspaceId),{count:3,amount:300});
  });

  await t.test('failed event commit rolls back the grant and retry creates exactly one credit ledger entry',async()=>{
    const {ctx}=await owner('atomic-retry'),customer=await attachCustomer(ctx),sub=mock.subscription(customer);
    const invoice=mock.invoice(customer,sub.id),payload=event('invoice.paid',invoice);
    const originalAtomic=(billing as any).atomic.bind(billing);let fail=true;
    (billing as any).atomic=async(client:any,work:any)=>{
      const query=client.query;
      client.query=function(sql:any,values:any){if(fail&&typeof sql==='string'&&sql.startsWith('UPDATE billing_events SET processed_at')&&values?.[0]===payload.id){fail=false;throw new Error('Simulated connection failure before event commit');}return query.apply(this,arguments as any);};
      try{return await originalAtomic(client,work);}finally{client.query=query;}
    };
    try{assert.equal((await deliver(payload)).statusCode,503);}finally{(billing as any).atomic=originalAtomic;}
    assert.equal(fail,false);assert.deepEqual(await monthly(ctx.workspaceId),{count:0,amount:0});
    assert.equal((await db.query('SELECT * FROM billing_credit_grants WHERE invoice_id=$1',[invoice.id])).rowCount,0);
    assert.equal((await db.query("SELECT 1 FROM product_milestones WHERE workspace_id=$1 AND milestone='paid_conversion'",[ctx.workspaceId])).rowCount,0,'failed grant commits do not publish a paid conversion');
    await delivered(payload);assert.deepEqual(await monthly(ctx.workspaceId),{count:1,amount:100});
  });

  await t.test('older-subscription invoice and duplicate refunds are review-only without arbitrary credit clawback',async()=>{
    const {ctx}=await owner('review-only'),customer=await attachCustomer(ctx),old=mock.subscription(customer,'canceled'),active=mock.subscription(customer);
    const current=mock.invoice(customer,active.id);await delivered(event('invoice.paid',current));
    const older=mock.invoice(customer,old.id);await delivered(event('invoice.paid',older));await delivered(event('invoice.paid',older));
    const charge={id:`ch_${randomUUID()}`,customer,amount_refunded:500};mock.chargeRecords.set(charge.id,charge);
    await delivered(event('charge.refunded',charge));await delivered(event('charge.refunded',{...charge,amount_refunded:1000}));
    const dispute={id:`dp_${randomUUID()}`,charge:charge.id};await delivered(event('charge.dispute.created',dispute));await delivered(event('charge.dispute.created',dispute));
    assert.deepEqual(await monthly(ctx.workspaceId),{count:1,amount:100});
    const items=await db.query('SELECT * FROM billing_review_items WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal(items.rowCount,3);
    const audits=await db.query("SELECT * FROM audit_events WHERE workspace_id=$1 AND action='billing.review-required'",[ctx.workspaceId]);assert.equal(audits.rowCount,3);
    assert.ok(items.rows.every(item=>item.status==='pending'));
  });

  await t.test('billing actions require an owner browser session, never an MCP token or revoked member',async()=>{
    const {ctx,token}=await owner('permissions');await attachCustomer(ctx);
    await assert.rejects(billing.checkout({...ctx,role:'member'},{planId:'pro'}),{code:'OWNER_REQUIRED'});
    await assert.rejects(billing.portal({...ctx,authKind:'mcp'}),{code:'OWNER_REQUIRED'});
    const connection=await auth.issueToken(ctx,'Billing-denied agent',['projects:read']);
    const response=await app.inject({method:'POST',url:'/api/billing/checkout',headers:{authorization:`Bearer ${connection.token}`},payload:{planId:'pro'}});
    assert.equal(response.statusCode,403);assert.equal(response.json().error.code,'OWNER_REQUIRED');
    await db.query("UPDATE workspace_members SET status='revoked' WHERE workspace_id=$1 AND user_id=$2",[ctx.workspaceId,ctx.userId]);
    const denied=await app.inject({method:'POST',url:'/api/billing/portal',headers:{authorization:`Bearer ${token}`}});assert.equal(denied.statusCode,403);
  });
});
