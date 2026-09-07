-- A staff decision is NOT delivery evidence and cannot requeue or suppress mail.
ALTER TABLE public.email_outbox ADD COLUMN delivery_version integer NOT NULL DEFAULT 1 CHECK(delivery_version > 0);
CREATE FUNCTION public.appscreen_email_delivery_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.status,NEW.attempts,NEW.error_code,NEW.provider_message_id,NEW.first_attempt_at,NEW.recipient_hash)
    IS DISTINCT FROM (OLD.status,OLD.attempts,OLD.error_code,OLD.provider_message_id,OLD.first_attempt_at,OLD.recipient_hash) THEN
  NEW.delivery_version := OLD.delivery_version + 1;
  NEW.updated_at := clock_timestamp();
 ELSE
  NEW.delivery_version := OLD.delivery_version;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.appscreen_email_delivery_version() FROM PUBLIC;
CREATE TRIGGER email_outbox_delivery_version BEFORE UPDATE ON public.email_outbox
 FOR EACH ROW EXECUTE FUNCTION public.appscreen_email_delivery_version();

CREATE TABLE public.email_incident_reviews (
 outbox_id uuid PRIMARY KEY REFERENCES public.email_outbox(id) ON DELETE CASCADE,
 delivery_version integer NOT NULL CHECK(delivery_version > 0),
 version integer NOT NULL CHECK(version > 0),
 disposition text NOT NULL CHECK(disposition IN ('investigating','closed-no-resend')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.email_incident_reviews ENABLE ROW LEVEL SECURITY;
-- Explicit metadata projection. Private reason and actor are recorded only in
-- the existing staff audit trail, never in queues or customer workspace exports.
CREATE VIEW public.email_incident_state WITH (security_invoker=true) AS
 SELECT o.id,o.workspace_id,o.status,o.error_code,o.attempts,o.created_at,o.updated_at,o.delivery_version,
 COALESCE(r.version,0) AS review_version,
 CASE WHEN r.delivery_version=o.delivery_version THEN r.disposition ELSE 'open' END AS review_state,
 (r.outbox_id IS NOT NULL AND r.delivery_version<>o.delivery_version) AS previous_review_stale
 FROM public.email_outbox o LEFT JOIN public.email_incident_reviews r ON r.outbox_id=o.id
 WHERE o.status IN ('review-needed','failed','bounced','complained','suppressed','delayed')
 OR (o.status='accepted' AND o.updated_at<statement_timestamp()-interval '24 hours');
CREATE INDEX email_outbox_incident_order ON public.email_outbox(created_at DESC,id DESC)
 WHERE status IN ('review-needed','failed','bounced','complained','suppressed','delayed','accepted');
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['email_incident_reviews','email_incident_state'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;
 END LOOP;
END $$;
