import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import type { Context } from './auth.js';
import type { AppServices } from './services.js';
import { Operations } from './operator.js';
import { transaction } from './db.js';
import { invariant } from './errors.js';

const milestone=z.enum(['signup','first_upload','first_campaign','first_export','paid_conversion']);
type Milestone=z.infer<typeof milestone>;

/** Called by trusted server state transitions, in their existing transaction.
 * No event ingestion endpoint or client-selected analytics properties exist. */
export async function recordMilestone(client:PoolClient,config:Pick<Config,'production'>,workspaceId:string,event:Milestone) {
  z.string().uuid().parse(workspaceId);milestone.parse(event);
  await client.query('INSERT INTO product_milestones(workspace_id,milestone,environment) VALUES($1,$2,$3) ON CONFLICT(workspace_id,milestone) DO NOTHING',[workspaceId,event,config.production?'production':'nonproduction']);
}

const definitions=[
  'Signup means a newly created AppScreen workspace, not a website visit or an unverified identity-provider registration.',
  'Each milestone counts once per workspace. Milestones shown belong to workspaces signed up in this window; they are not a strictly ordered funnel.',
  'First upload is a validated, stored original screenshot. An upload ticket or failed upload does not count.',
  'First campaign is a completed campaign render with ready status and no review-needed warning, including a manually designed campaign.',
  'First export is a completed requested store PNG or ZIP export, including an export flagged for review. It is not a measured file download or store submission.',
  'Paid conversion means the first verified subscription invoice accepted for a credit grant with a positive recorded amount paid. Zero-dollar invoices, checkout visits, trials and active-status events alone do not count. This is not cash revenue or a refund-adjusted accounting measure.',
  'Collection starts with this release; historical use is not backfilled. Production and nonproduction milestone cohorts are separate.',
  'Job activity and operational alerts describe this installation. Token counts reflect recorded provider usage, not measured currency cost; missing counts are disclosed.',
];
const tokenSQL=(key:string)=>`CASE WHEN jsonb_typeof(data->'${key}')='number' AND data->>'${key}' ~ '^(0|[1-9][0-9]{0,14})$' THEN (data->>'${key}')::numeric ELSE NULL END`;

export class ProductMetrics {
  private operations:Operations;
  constructor(private services:AppServices,private clock?:()=>Date){this.operations=new Operations(services);}
  async report(ctx:Context,input:unknown={}) {
    await this.operations.authorize(ctx);
    const {days}=z.object({days:z.coerce.number().refine(n=>[7,30,90].includes(n)).default(30)}).strict().parse(input);
    return transaction(this.services.db,async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.operations.authorize(ctx,client);
      const member=await client.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND status='active' FOR SHARE",[ctx.workspaceId,ctx.userId]);
      invariant(member.rowCount,'OPERATOR_REQUIRED','Operator workspace access is no longer active.',403);
      const environment=this.services.config.production?'production':'nonproduction';
      // Match the database timestamps even if web and database hosts have a
      // small clock skew. A clock override exists only for isolated tests.
      const until=this.clock?this.clock():(await client.query('SELECT now() AS until')).rows[0].until;
      invariant(until instanceof Date&&Number.isFinite(until.getTime()),'REPORT_CLOCK_INVALID','The report clock is unavailable.',503);
      const times={until,since:new Date(until.getTime()-days*86_400_000)};
      // A single transaction uses a single connection; don't queue concurrent
      // client.query calls (unsupported by future pg versions).
      const [cohort,capture,jobs,usage,signals]=[
        await client.query(`WITH cohort AS (SELECT workspace_id FROM product_milestones WHERE milestone='signup' AND environment=$1 AND occurred_at >= $2 AND occurred_at <= $3)
          SELECT count(*) FILTER(WHERE m.milestone='signup')::integer AS signups,
          count(*) FILTER(WHERE m.milestone='first_upload')::integer AS "firstUpload",
          count(*) FILTER(WHERE m.milestone='first_campaign')::integer AS "firstCampaign",
          count(*) FILTER(WHERE m.milestone='first_export')::integer AS "firstExport",
          count(*) FILTER(WHERE m.milestone='paid_conversion')::integer AS "paidConversion"
          FROM product_milestones m JOIN cohort c USING(workspace_id) WHERE m.environment=$1 AND m.occurred_at <= $3`,[environment,times.since,times.until]),
        await client.query('SELECT min(occurred_at) AS started FROM product_milestones WHERE environment=$1',[environment]),
        await client.query(`SELECT kind,CASE WHEN status IN ('queued','running','ready','needs-input','failed','cancelled') THEN status ELSE 'other' END AS status,count(*)::integer AS count FROM agent_jobs WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1,2 ORDER BY 1,2`,[times.since,times.until]),
        await client.query(`WITH measured AS (SELECT ${tokenSQL('input_tokens')} AS input,${tokenSQL('output_tokens')} AS output FROM usage_events WHERE created_at >= $1 AND created_at <= $2)
          SELECT COALESCE(sum(input),0)::text AS input_tokens,COALESCE(sum(output),0)::text AS output_tokens,count(*) FILTER(WHERE input IS NULL OR output IS NULL)::integer AS unmetered FROM measured`,[times.since,times.until]),
        await client.query(`SELECT 'JOBS_WAITING' AS code,count(*)::integer AS count,min(created_at) AS oldest FROM agent_jobs WHERE status='queued' AND created_at < $1::timestamptz-interval '10 minutes'
          UNION ALL SELECT 'WORKER_HEARTBEAT_STALE',count(*)::integer,min(COALESCE(heartbeat_at,updated_at)) FROM agent_jobs WHERE status='running' AND COALESCE(heartbeat_at,updated_at) < $1::timestamptz-interval '5 minutes'
          UNION ALL SELECT 'BILLING_EVENT_RETRY',count(*)::integer,min(received_at) FROM billing_events WHERE processed_at IS NULL AND (error_code IS NOT NULL OR received_at < $1::timestamptz-interval '10 minutes')
          UNION ALL SELECT 'BILLING_REVIEW_REQUIRED',count(*)::integer,min(created_at) FROM billing_review_items WHERE status='pending'
          UNION ALL SELECT 'SUPPORT_ESCALATED',count(*)::integer,min(created_at) FROM account_requests WHERE kind='support' AND status='escalated'
          UNION ALL SELECT 'SUPPORT_WAITING',count(*)::integer,min(created_at) FROM account_requests WHERE kind='support' AND status='pending' AND created_at < $1::timestamptz-interval '1 day'
          UNION ALL SELECT 'DELETION_PENDING',count(*)::integer,min(created_at) FROM account_requests WHERE kind='deletion' AND status='pending'`,[times.until]),
      ];
      const templates:Record<string,{severity:'warning'|'critical';message:string;href:string}>={
        JOBS_WAITING:{severity:'warning',message:'Jobs have waited more than 10 minutes. Check queue admission and worker availability.',href:'/app/operator'},
        WORKER_HEARTBEAT_STALE:{severity:'critical',message:'Running jobs have no recent worker heartbeat. Check worker recovery before retrying work.',href:'/app/operator'},
        BILLING_EVENT_RETRY:{severity:'critical',message:'Payment events need retry or reconciliation. Check billing health; do not grant credits from a redirect.',href:'/app/operator'},
        BILLING_REVIEW_REQUIRED:{severity:'warning',message:'Billing records require an operator review. Automatic credit corrections have not been made.',href:'/app/operator'},
        SUPPORT_ESCALATED:{severity:'warning',message:'Support cases need escalation review.',href:'/app/operator/support'},
        SUPPORT_WAITING:{severity:'warning',message:'Cases opened more than one day ago are currently pending. Recently reopened cases may be included; this is not a response-time or SLA measurement.',href:'/app/operator/support'},
        DELETION_PENDING:{severity:'warning',message:'Deletion requests need manual review. This signal does not indicate erasure or subscription cancellation.',href:'/app/operator'},
      };
      // Refuse to silently round a currency-like metric or huge corrupted count.
      const safeNumber=(value:string)=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
      const inputTokens=safeNumber(usage.rows[0].input_tokens),outputTokens=safeNumber(usage.rows[0].output_tokens);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,metadata) VALUES(gen_random_uuid(),$1,$2,$3,$4)',[ctx.workspaceId,ctx.userId,'operator.report.view',{days,environment}]);
      return {window:{days,from:times.since.toISOString(),to:times.until.toISOString()},environment,captureStartedAt:capture.rows[0].started?.toISOString()||null,
        cohort:cohort.rows[0],activity:{jobs:jobs.rows,inputTokens,outputTokens,unmeteredUsageEvents:usage.rows[0].unmetered},
        alerts:signals.rows.filter(r=>r.count>0).map(r=>({code:r.code,count:r.count,oldestAt:r.oldest?.toISOString()||null,...templates[r.code]})),definitions};
    });
  }
}
