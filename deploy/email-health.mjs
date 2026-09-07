/** Metadata-only health evidence; absence of overdue work is not proof of
 * worker liveness or delivery. No provider calls, retries, or mutations. */
export async function emailHealth(db) {
  const {rows}=await db.query(`SELECT
    count(*) FILTER(WHERE status IN ('queued','retry','sending'))::integer AS pending,
    count(*) FILTER(WHERE status IN ('queued','retry','sending') AND created_at<clock_timestamp()-interval '10 minutes')::integer AS overdue,
    count(*) FILTER(WHERE status='review-needed')::integer AS review_required,
    count(*) FILTER(WHERE status='failed' AND updated_at>clock_timestamp()-interval '1 hour')::integer AS failed_last_hour,
    count(*) FILTER(WHERE status IN ('accepted','delayed') AND updated_at<clock_timestamp()-interval '24 hours')::integer AS missing_delivery_confirmation,
    (SELECT count(*)::integer FROM public.email_incident_state WHERE review_state<>'closed-no-resend') AS open_incidents
    FROM public.email_outbox`);
  const metrics=rows[0];
  return {...metrics,needsAttention:Boolean(metrics.overdue||metrics.open_incidents)};
}
