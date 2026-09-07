import pg from 'pg';
import { emailHealth } from './email-health.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
try {
  const { rows } = await db.query(`SELECT
    count(*) FILTER (WHERE status='queued')::int AS queued,
    count(*) FILTER (WHERE status='queued' AND updated_at<now()-interval '2 minutes')::int AS overdue_queued,
    count(*) FILTER (WHERE status='running')::int AS running,
    count(*) FILTER (WHERE status='running' AND heartbeat_at<now()-interval '1 minute')::int AS stale_running,
    count(*) FILTER (WHERE status='failed' AND updated_at>now()-interval '1 hour')::int AS failed_last_hour
    FROM agent_jobs`);
  const email=await emailHealth(db);
  console.log(JSON.stringify({ ...rows[0], email, note: 'Queue health only; an idle queue does not prove worker liveness. Email acceptance is not delivery confirmation.' }));
  if (rows[0].overdue_queued || rows[0].stale_running || email.needsAttention) process.exitCode = 1;
} catch { console.error('Queue health query failed; inspect database connectivity.'); process.exitCode = 1; }
finally { await db.end(); }
