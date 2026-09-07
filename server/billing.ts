import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { invariant, AppError } from './errors.js';
import { recordMilestone } from './product-metrics.js';
import { enqueueNotification } from './notifications.js';

const idOf = (value:any):string|undefined => typeof value==='string'?value:value?.id;
const isLive = (subscription:any) => !['canceled','incomplete_expired'].includes(subscription.status);
const priority:Record<string,number> = {active:0,trialing:1,past_due:2,unpaid:3,incomplete:4,paused:5,canceled:6,incomplete_expired:7};
type Client = pg.PoolClient;

// Current Stripe contracts:
// https://docs.stripe.com/api/idempotent_requests (keys can be pruned after 24h)
// https://docs.stripe.com/api/checkout/sessions/object (open/complete/expired)
// https://docs.stripe.com/webhooks (unordered and duplicate events)
// https://docs.stripe.com/api/invoice-line-item/object (billing periods belong to lines)
export class Billing {
  stripe:Stripe|null;
  constructor(public services:AppServices, stripe?:Stripe|null) {
    this.stripe=stripe===undefined?(services.config.enableBilling?new Stripe(services.config.stripeKey,{timeout:20_000,maxNetworkRetries:1}):null):stripe;
  }
  requireOwner(ctx:Context) {
    invariant(ctx.role==='owner'&&ctx.authKind!=='mcp','OWNER_REQUIRED','Manage billing from the workspace owner account.',403);
    invariant(this.stripe,'BILLING_UNAVAILABLE','Billing is not configured yet.',503);
  }
  private async locked<T>(key:string, work:(client:Client)=>Promise<T>):Promise<T> {
    const client=await this.services.db.connect();
    let discard=false;
    try { return await this.withLock(client,key,work); }
    catch(error) { discard=true;throw error; }
    finally { client.release(discard); }
  }
  private async withLock<T>(client:Client,key:string,work:(client:Client)=>Promise<T>):Promise<T> {
    // A session lock permits committing the intent before a remote API write.
    // Nested event/workspace locks share this connection: a burst of webhooks
    // must not exhaust the pool while each event waits for a second connection.
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
      return await work(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
    }
  }
  private async atomic<T>(client:Client,work:()=>Promise<T>):Promise<T> {
    await client.query('BEGIN');
    try { const value=await work(); await client.query('COMMIT'); return value; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
  }
  private async paginated(fetch:(args:any)=>Promise<any>,args:any) {
    const result:any[]=[];let starting_after:string|undefined;
    for(let page=0;page<100;page++) {
      const response=await fetch({...args,limit:100,...(starting_after?{starting_after}:{})});
      result.push(...response.data);
      if(!response.has_more)return result;
      invariant(response.data.length,'BILLING_DATA_INVALID','Billing records could not be reconciled.',503);
      starting_after=response.data.at(-1).id;
    }
    throw new AppError('BILLING_REVIEW_REQUIRED','Billing history requires a support review before continuing.',409);
  }
  private async review(client:Client,workspaceId:string|null,key:string,reason:string,objectId:string,eventId?:string,metadata:any={}) {
    const inserted=await client.query('INSERT INTO billing_review_items(review_key,workspace_id,event_id,reason,object_id,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING review_key',[key,workspaceId,eventId||null,reason,objectId,metadata]);
    if(inserted.rowCount)await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),workspaceId,'billing-system','billing.review-required',objectId,{reason,eventId,...metadata}]);
    else await client.query('UPDATE billing_review_items SET event_id=COALESCE($2,event_id),metadata=$3,updated_at=now() WHERE review_key=$1',[key,eventId||null,metadata]);
  }
  private async reconcileCustomerLocked(client:Client,workspaceId:string,customerId:string) {
    const all=await this.paginated(args=>this.stripe!.subscriptions.list(args),{customer:customerId,status:'all'});
    invariant(all.every(sub=>idOf(sub.customer)===customerId),'BILLING_DATA_INVALID','Subscription customer mismatch.',503);
    const live=all.filter(isLive);
    const sorted=[...all].sort((a,b)=>(priority[a.status]??5)-(priority[b.status]??5)||(b.created||0)-(a.created||0)||a.id.localeCompare(b.id));
    const selected=sorted[0]||null;
    let requiresReview=live.length>1;
    await this.atomic(client,async()=>{
      if(selected) {
        const allowed=selected.items?.data?.some((item:any)=>idOf(item.price)===this.services.config.stripePriceId);
        const item=selected.items?.data?.find((item:any)=>idOf(item.price)===this.services.config.stripePriceId)||selected.items?.data?.[0];
        const periodEnd=item?.current_period_end||selected.current_period_end;
        await client.query('UPDATE subscriptions SET subscription_id=$1,plan_id=$2,status=$3,current_period_end=$4,cancel_at_period_end=$5,reconciliation_required=$6,updated_at=now() WHERE workspace_id=$7 AND customer_id=$8',[selected.id,allowed?'pro':'unknown',allowed?selected.status:'unpaid',periodEnd?new Date(periodEnd*1000):null,!!selected.cancel_at_period_end,live.length>1,workspaceId,customerId]);
      } else {
        // Preserve the local trial before any Stripe subscription exists. If a
        // previously known subscription disappeared, fail closed and flag review.
        const local=await client.query('SELECT subscription_id FROM subscriptions WHERE workspace_id=$1',[workspaceId]);
        if(local.rows[0]?.subscription_id) {
          requiresReview=true;
          await client.query("UPDATE subscriptions SET status='unpaid',reconciliation_required=true,updated_at=now() WHERE workspace_id=$1",[workspaceId]);
          await this.review(client,workspaceId,`missing-subscription:${customerId}`,'subscription-missing',customerId);
        } else await client.query('UPDATE subscriptions SET updated_at=now() WHERE workspace_id=$1',[workspaceId]);
      }
      if(live.length>1)await this.review(client,workspaceId,`duplicate-subscriptions:${customerId}:${live.map(s=>s.id).sort().join(',')}`,'duplicate-subscriptions',customerId,undefined,{subscriptionIds:live.map(s=>s.id)});
    });
    return {selected,live,all,requiresReview};
  }
  async syncCustomer(customerId:string) {
    invariant(this.stripe,'BILLING_UNAVAILABLE','Billing is unavailable.',503);
    const found=await this.services.db.query('SELECT workspace_id FROM subscriptions WHERE customer_id=$1',[customerId]);
    if(!found.rowCount)return null;
    return this.locked(`billing-workspace:${found.rows[0].workspace_id}`,client=>this.reconcileCustomerLocked(client,found.rows[0].workspace_id,customerId));
  }
  async syncSubscription(subscriptionId:string) {
    invariant(this.stripe,'BILLING_UNAVAILABLE','Billing is unavailable.',503);
    const subscription=await this.stripe.subscriptions.retrieve(subscriptionId);
    const customerId=idOf(subscription.customer);
    invariant(customerId,'BILLING_DATA_INVALID','Subscription has no customer.',503);
    // Never write this event's subscription as the workspace's current one.
    // The complete customer subscription inventory is authoritative instead.
    await this.syncCustomer(customerId);
    return subscription;
  }
  private async customerLocked(client:Client,ctx:Context) {
    const result=await client.query('SELECT * FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId]);
    const local=result.rows[0];invariant(local,'BILLING_ACCOUNT_MISSING','Billing account was not initialized.',409);
    if(local.customer_id)return local.customer_id as string;
    if(local.customer_request_started_at&&Date.now()-new Date(local.customer_request_started_at).getTime()>23*60*60*1000) {
      await this.atomic(client,()=>this.review(client,ctx.workspaceId,`customer-uncertain:${ctx.workspaceId}`,'customer-creation-uncertain',ctx.workspaceId));
      throw new AppError('BILLING_REVIEW_REQUIRED','An earlier billing setup is still unconfirmed. Contact support before trying again.',409);
    }
    const payload=local.customer_request_payload||{email:ctx.email,metadata:{workspaceId:ctx.workspaceId}};
    await client.query('UPDATE subscriptions SET customer_request_started_at=COALESCE(customer_request_started_at,now()),customer_request_payload=$2 WHERE workspace_id=$1',[ctx.workspaceId,payload]);
    const customer=await this.stripe!.customers.create(payload,{idempotencyKey:`appscreen-customer:${ctx.workspaceId}`});
    await client.query('UPDATE subscriptions SET customer_id=$1 WHERE workspace_id=$2',[customer.id,ctx.workspaceId]);
    return customer.id;
  }
  private async portalFor(customerId:string) {
    const session=await this.stripe!.billingPortal.sessions.create({customer:customerId,return_url:`${this.services.config.baseUrl}/app/billing`});
    return {url:session.url,destination:'portal'};
  }
  private async rememberSession(client:Client,attemptId:string,session:any) {
    invariant(['open','complete','expired'].includes(session.status),'BILLING_DATA_INVALID','Checkout returned an unknown state.',503);
    await client.query('UPDATE billing_checkout_attempts SET session_id=$2,status=$3,session_url=$4,expires_at=$5,updated_at=now() WHERE id=$1',[attemptId,session.id,session.status,session.url||null,session.expires_at?new Date(session.expires_at*1000):null]);
  }
  async checkout(ctx:Context,args:any) {
    this.requireOwner(ctx);invariant(args.planId==='pro','INVALID_PLAN','Choose an available plan.');
    return this.locked(`billing-workspace:${ctx.workspaceId}`,async client=>{
      await this.services.assertMembership(ctx,client);
      const customerId=await this.customerLocked(client,ctx);
      const current=await this.reconcileCustomerLocked(client,ctx.workspaceId,customerId);
      if(current.live.length) return this.portalFor(customerId);
      invariant(!current.requiresReview,'BILLING_REVIEW_REQUIRED','Your existing subscription could not be confirmed. Contact support before starting another checkout.',409);
      const price=await this.stripe!.prices.retrieve(this.services.config.stripePriceId);
      invariant(price.active&&price.recurring?.interval==='month'&&price.recurring.interval_count===1,'PRICE_INVALID','The subscription price is not configured correctly.',503);
      invariant(this.services.config.priceAmount===null||price.unit_amount===this.services.config.priceAmount,'PRICE_INVALID','The displayed and checkout prices do not match.',503);
      invariant(price.currency===this.services.config.currency,'PRICE_INVALID','The displayed and checkout currencies do not match.',503);
      let attempt=(await client.query("SELECT * FROM billing_checkout_attempts WHERE workspace_id=$1 AND status IN ('creating','open','complete') ORDER BY created_at DESC LIMIT 1",[ctx.workspaceId])).rows[0];
      let remote:any=null;
      if(attempt?.session_id)remote=await this.stripe!.checkout.sessions.retrieve(attempt.session_id);
      if(attempt&&!remote) {
        const sessions=await this.paginated(a=>this.stripe!.checkout.sessions.list(a),{customer:customerId});
        remote=sessions.find(session=>session.metadata?.checkoutAttemptId===attempt.id)||null;
        if(!remote&&Date.now()-new Date(attempt.created_at).getTime()>23*60*60*1000) {
          await this.atomic(client,()=>this.review(client,ctx.workspaceId,`checkout-uncertain:${attempt.id}`,'checkout-creation-uncertain',attempt.id));
          throw new AppError('BILLING_REVIEW_REQUIRED','An earlier checkout is still unconfirmed. Contact support before starting another.',409);
        }
      }
      if(remote) {
        invariant(idOf(remote.customer)===customerId&&remote.mode==='subscription','BILLING_DATA_INVALID','Checkout belongs to another billing account.',503);
        await this.rememberSession(client,attempt.id,remote);
        if(remote.status==='open') {invariant(remote.url,'BILLING_PROCESSING','Checkout is still being prepared.',409);return {url:remote.url,checkoutId:remote.id,reused:true};}
        if(remote.status==='complete') {
          const sid=idOf(remote.subscription), sub=sid?await this.stripe!.subscriptions.retrieve(sid):null;
          if(!sub||isLive(sub))return this.portalFor(customerId);
        }
        attempt=null;
      }
      if(!attempt) {
        // Also guard against a session created before this process stored its ID,
        // or an open session made by an earlier application version.
        const sessions=await this.paginated(a=>this.stripe!.checkout.sessions.list(a),{customer:customerId});
        if(sessions.some(session=>session.mode==='subscription'&&session.status==='open'))throw new AppError('CHECKOUT_ALREADY_OPEN','An existing checkout must be completed or expire before starting another. Open billing management for help.',409);
        for(const complete of sessions.filter(session=>session.mode==='subscription'&&session.status==='complete')) {
          const sid=idOf(complete.subscription);
          const sub=sid?(current.all.find(item=>item.id===sid)||await this.stripe!.subscriptions.retrieve(sid)):null;
          if(!sub||isLive(sub))return this.portalFor(customerId);
        }
        const id=randomUUID();
        const payload={mode:'subscription',customer:customerId,line_items:[{price:price.id,quantity:1}],client_reference_id:ctx.workspaceId,metadata:{workspaceId:ctx.workspaceId,checkoutAttemptId:id},subscription_data:{metadata:{workspaceId:ctx.workspaceId}},success_url:`${this.services.config.baseUrl}/app/billing?checkout=success`,cancel_url:`${this.services.config.baseUrl}/app/billing?checkout=cancelled`,allow_promotion_codes:false};
        attempt=(await client.query('INSERT INTO billing_checkout_attempts(id,workspace_id,customer_id,price_id,request_payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,ctx.workspaceId,customerId,price.id,payload])).rows[0];
      }
      invariant(attempt.price_id===price.id,'CHECKOUT_PRICE_CHANGED','Finish or expire the previous checkout before selecting the new price.',409);
      const session=await this.stripe!.checkout.sessions.create(attempt.request_payload,{idempotencyKey:`appscreen-checkout:${attempt.id}`});
      await this.atomic(client,async()=>{
        await this.rememberSession(client,attempt.id,session);
        const receipt=await client.query("SELECT id FROM audit_events WHERE workspace_id=$1 AND action='billing.checkout' AND target_id=$2",[ctx.workspaceId,session.id]);
        if(!receipt.rowCount)await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.workspaceId,ctx.userId,'billing.checkout',session.id]);
      });
      invariant(session.status==='open'&&session.url,'BILLING_PROCESSING','Checkout is not ready. Open billing management to check its status.',409);
      return {url:session.url,checkoutId:session.id,reused:false};
    });
  }
  async portal(ctx:Context) {
    this.requireOwner(ctx);await this.services.assertMembership(ctx);
    const s=await this.services.db.query('SELECT customer_id FROM subscriptions WHERE workspace_id=$1',[ctx.workspaceId]);
    invariant(s.rows[0]?.customer_id,'NO_BILLING_ACCOUNT','Start a subscription before opening billing management.',409);
    return this.portalFor(s.rows[0].customer_id);
  }
  async receive(raw:Buffer,signature:string) {
    invariant(this.stripe,'BILLING_UNAVAILABLE','Billing is unavailable.',503);let event:Stripe.Event;
    try { event=this.stripe.webhooks.constructEvent(raw,signature,this.services.config.stripeWebhookSecret); }
    catch { throw new AppError('WEBHOOK_SIGNATURE_INVALID','Invalid payment event signature.',400); }
    await this.services.db.query('INSERT INTO billing_events(id,type,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[event.id,event.type,event]);
    try { await this.process(event); }
    catch {
      await this.services.db.query("UPDATE billing_events SET error_code='PROCESSING_FAILED',attempts=attempts+1,next_attempt_at=now()+interval '1 minute' WHERE id=$1 AND processed_at IS NULL",[event.id]);
      // The inbox is durable, but a non-2xx also keeps Stripe's delivery retry active.
      throw new AppError('BILLING_EVENT_RETRY','Payment event received; reconciliation is temporarily unavailable. Please retry.',503);
    }
    return {received:true};
  }
  private async invoiceLines(invoice:any) {
    if(invoice.lines&&!invoice.lines.has_more)return invoice.lines.data;
    return this.paginated(args=>this.stripe!.invoices.listLineItems(invoice.id,args),{});
  }
  private async grantInvoice(client:Client,workspaceId:string,invoice:any,current:any,eventId:string) {
    const sid=idOf(invoice.parent?.subscription_details?.subscription||invoice.subscription);
    // Modern Invoice objects expose status rather than the removed `paid`
    // boolean. Refetching the object also avoids trusting a stale event body.
    if(!sid||invoice.status!=='paid'||!['subscription_create','subscription_cycle'].includes(invoice.billing_reason))return;
    const lines=await this.invoiceLines(invoice);
    const eligible=lines.filter((line:any)=> {
      const parent=line.parent?.subscription_item_details;
      const price=idOf(line.pricing?.price_details?.price||line.price);
      const lineSubscription=idOf(parent?.subscription||line.subscription);
      const subscriptionLine=line.parent?.type==='subscription_item_details'||line.type==='subscription';
      return subscriptionLine&&price===this.services.config.stripePriceId&&!line.proration&&!parent?.proration&&(!lineSubscription||lineSubscription===sid);
    });
    if(!eligible.length)return;
    if(current.selected?.id!==sid) {
      await this.review(client,workspaceId,`older-paid-invoice:${invoice.id}`,'paid-invoice-for-other-subscription',invoice.id,eventId,{subscriptionId:sid});
      return;
    }
    const periods=new Map<string,any>();
    for(const line of eligible) {
      const {start,end}=line.period||{};
      invariant(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&end>start,'BILLING_DATA_INVALID','The paid invoice has no valid subscription period.',503);
      periods.set(`${start}:${end}`,{start,end});
    }
    invariant(periods.size===1,'BILLING_DATA_INVALID','The invoice covers multiple subscription periods and requires review.',503);
    const {start,end}=[...periods.values()][0];
    const reference=`subscription-period:${sid}:${this.services.config.stripePriceId}:${start}:${end}`;
    const legacy=await client.query('SELECT reference FROM credit_ledger WHERE reference=$1',[`invoice:${invoice.id}`]);
    const grant=await client.query('INSERT INTO billing_credit_grants(invoice_id,workspace_id,subscription_id,price_id,period_start,period_end,amount,ledger_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING invoice_id',[invoice.id,workspaceId,sid,this.services.config.stripePriceId,start,end,this.services.config.monthlyCredits,legacy.rowCount?legacy.rows[0].reference:reference]);
    if(grant.rowCount&&!legacy.rowCount)await client.query("INSERT INTO credit_ledger(id,workspace_id,amount,reason,reference) VALUES($1,$2,$3,'subscription',$4) ON CONFLICT(reference) DO NOTHING",[randomUUID(),workspaceId,this.services.config.monthlyCredits,reference]);
    // A zero-dollar/fully discounted invoice may also be marked paid. It can
    // grant the plan allowance without representing a paid conversion. This
    // metric is not cash revenue or a refund-adjusted accounting measure.
    if(grant.rowCount&&Number.isSafeInteger(invoice.amount_paid)&&invoice.amount_paid>0)await recordMilestone(client,this.services.config,workspaceId,'paid_conversion');
  }
  async process(event:Stripe.Event) {
    invariant(this.stripe,'BILLING_UNAVAILABLE','Billing is unavailable.',503);
    return this.locked(`billing-event:${event.id}`,async eventClient=>{
      const inbox=await eventClient.query('SELECT payload,processed_at FROM billing_events WHERE id=$1',[event.id]);
      invariant(inbox.rowCount,'BILLING_EVENT_MISSING','Payment event was not durably received.',409);
      if(inbox.rows[0].processed_at)return;
      event=inbox.rows[0].payload;const object:any=event.data.object;
      let customerId:string|undefined,invoice:any=null,checkout:any=null,review:any=null;
      if(event.type.startsWith('customer.subscription.'))customerId=idOf(object.customer)||(idOf((await this.stripe!.subscriptions.retrieve(object.id)).customer));
      else if(event.type.startsWith('invoice.')) {invoice=await this.stripe!.invoices.retrieve(object.id);customerId=idOf(invoice.customer);}
      else if(event.type.startsWith('checkout.session.')) {checkout=await this.stripe!.checkout.sessions.retrieve(object.id);customerId=idOf(checkout.customer);}
      else if(event.type==='charge.refunded'||event.type==='charge.dispute.created') {
        customerId=idOf(object.customer);
        if(!customerId&&idOf(object.charge))customerId=idOf((await this.stripe!.charges.retrieve(idOf(object.charge)!)).customer);
        review={key:`${event.type}:${object.id}`,reason:event.type,objectId:object.id};
      }
      const owner=customerId?(await eventClient.query('SELECT workspace_id FROM subscriptions WHERE customer_id=$1',[customerId])).rows[0]:null;
      const finish=async(client:Client,workspaceId:string|null,current:any)=>{
        await this.atomic(client,async()=>{
          if(invoice&&event.type==='invoice.paid'&&workspaceId)await this.grantInvoice(client,workspaceId,invoice,current,event.id);
          if(checkout&&workspaceId) {
            const attempt=await client.query('SELECT id FROM billing_checkout_attempts WHERE workspace_id=$1 AND (session_id=$2 OR id::text=$3)',[workspaceId,checkout.id,checkout.metadata?.checkoutAttemptId||'']);
            if(attempt.rowCount)await this.rememberSession(client,attempt.rows[0].id,checkout);
          }
          if(review)await this.review(client,workspaceId,review.key,review.reason,review.objectId,event.id,{type:event.type});
          if(workspaceId&&invoice&&event.type==='invoice.payment_failed'&&invoice.status!=='paid'&&['past_due','unpaid','incomplete'].includes(current?.selected?.status)&&idOf(invoice.parent?.subscription_details?.subscription||invoice.subscription)===current.selected.id) {
            const owners=await client.query("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND status='active' AND role='owner'",[workspaceId]);
            for(const owner of owners.rows)await enqueueNotification(client,{kind:'payment-needs-attention',workspaceId,recipientUserId:owner.user_id,billingEventId:event.id},{emailEnabled:this.services.config.emailEnabled});
          }
          await client.query('UPDATE billing_events SET processed_at=now(),error_code=NULL,next_attempt_at=NULL WHERE id=$1',[event.id]);
        });
      };
      if(owner&&customerId)await this.withLock(eventClient,`billing-workspace:${owner.workspace_id}`,async client=>{
        const current=await this.reconcileCustomerLocked(client,owner.workspace_id,customerId!);
        await finish(client,owner.workspace_id,current);
      });
      else await finish(eventClient,null,null);
    });
  }
  async reconcile() {
    if(!this.stripe)return;
    const pending=await this.services.db.query('SELECT payload FROM billing_events WHERE processed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY received_at LIMIT 50');
    for(const {payload} of pending.rows)try {await this.process(payload);}catch{await this.services.db.query("UPDATE billing_events SET error_code='PROCESSING_FAILED',attempts=attempts+1,next_attempt_at=now()+interval '1 minute' WHERE id=$1 AND processed_at IS NULL",[payload.id]);}
    const customers=await this.services.db.query("SELECT customer_id FROM subscriptions WHERE customer_id IS NOT NULL AND updated_at<now()-interval '1 hour' LIMIT 50");
    for(const record of customers.rows)await this.syncCustomer(record.customer_id).catch(()=>{});
  }
}
