-- Transactional service email is opt-in and server-only. No historic inbox
-- backfill. Outbox insertion shares the transaction of its source notification.
CREATE TABLE public.email_preferences (
 workspace_id uuid NOT NULL,
 user_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL CHECK(version > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,user_id),
 FOREIGN KEY(workspace_id,user_id) REFERENCES public.workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_email_identity UNIQUE(id,workspace_id,recipient_user_id);
CREATE TABLE public.email_outbox (
 id uuid PRIMARY KEY,
 notification_id uuid NOT NULL UNIQUE,
 workspace_id uuid NOT NULL,
 recipient_user_id text NOT NULL,
 preference_version integer NOT NULL CHECK(preference_version > 0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','retry','accepted','delivered','delayed','bounced','complained','suppressed','failed','skipped','review-needed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid, lease_until timestamptz,
 first_attempt_at timestamptz,
 payload jsonb,
 recipient_hash text CHECK(recipient_hash ~ '^[a-f0-9]{64}$'),
 provider_message_id uuid UNIQUE,
 error_code text CHECK(error_code ~ '^[A-Z_]{2,60}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(notification_id,workspace_id,recipient_user_id) REFERENCES public.notifications(id,workspace_id,recipient_user_id) ON DELETE CASCADE,
 CHECK((payload IS NULL AND recipient_hash IS NULL AND first_attempt_at IS NULL) OR (payload IS NOT NULL AND recipient_hash IS NOT NULL AND first_attempt_at IS NOT NULL)),
 CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX email_outbox_due ON public.email_outbox(next_attempt_at,created_at) WHERE status IN ('queued','retry','sending');
CREATE TABLE public.email_events (
 event_id text PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 200),
 provider_message_id uuid NOT NULL,
 type text NOT NULL CHECK(type IN ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed')),
 recipient_hash text NOT NULL CHECK(recipient_hash ~ '^[a-f0-9]{64}$'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_events_message ON public.email_events(provider_message_id);
-- Hashes remain personal data; they are not exposed by browser/MCP/report APIs.
CREATE TABLE public.email_suppressions (
 recipient_hash text PRIMARY KEY CHECK(recipient_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(reason IN ('bounced','complained','suppressed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['email_preferences','email_outbox','email_events','email_suppressions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;
 END LOOP;
END $$;
