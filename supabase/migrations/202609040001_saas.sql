-- Idempotent base migration. Runtime queries also check workspace membership explicitly.
CREATE SCHEMA IF NOT EXISTS app_private;
CREATE TABLE IF NOT EXISTS public.workspaces (
 id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.workspace_members (
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 email text NOT NULL DEFAULT '', role text NOT NULL CHECK(role IN ('owner','member')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE INDEX IF NOT EXISTS members_user_idx ON public.workspace_members(user_id);
CREATE TABLE IF NOT EXISTS public.projects (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), name text NOT NULL,
 active_revision_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz, UNIQUE(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS public.assets (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), project_id uuid NOT NULL,
 name text NOT NULL, storage_key text NOT NULL UNIQUE, mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 width integer NOT NULL, height integer NOT NULL, sha256 text NOT NULL, kind text NOT NULL DEFAULT 'source',
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES public.projects(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS assets_project_idx ON public.assets(project_id,workspace_id);
CREATE TABLE IF NOT EXISTS public.campaign_revisions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), project_id uuid NOT NULL,
 parent_revision_id uuid, document jsonb NOT NULL, qa jsonb NOT NULL DEFAULT '{}', label text NOT NULL DEFAULT 'Draft',
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,workspace_id), UNIQUE(id,project_id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES public.projects(id,workspace_id),
 FOREIGN KEY(parent_revision_id,project_id,workspace_id) REFERENCES public.campaign_revisions(id,project_id,workspace_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='projects_active_revision_fk') THEN
  ALTER TABLE public.projects ADD CONSTRAINT projects_active_revision_fk FOREIGN KEY(active_revision_id,id,workspace_id)
   REFERENCES public.campaign_revisions(id,project_id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.subscriptions (
 workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id), customer_id text UNIQUE, subscription_id text UNIQUE,
 plan_id text NOT NULL DEFAULT 'trial', status text NOT NULL DEFAULT 'trialing', current_period_end timestamptz,
 cancel_at_period_end boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.credit_ledger (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), amount integer NOT NULL,
 reason text NOT NULL, reference text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.agent_jobs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), project_id uuid NOT NULL,
 user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('design','revision','export','render')),
 status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'queued', input jsonb NOT NULL,
 result jsonb, error jsonb, idempotency_key text NOT NULL, request_hash text NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz,
 UNIQUE(workspace_id,idempotency_key), UNIQUE(id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES public.projects(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS jobs_workspace_status_idx ON public.agent_jobs(workspace_id,status);
CREATE TABLE IF NOT EXISTS public.credit_reservations (
 job_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, amount integer NOT NULL CHECK(amount>=0),
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','settled','released')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,workspace_id) REFERENCES public.agent_jobs(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS public.agent_job_steps (
 job_id uuid NOT NULL REFERENCES public.agent_jobs(id), stage text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,stage)
);
CREATE TABLE IF NOT EXISTS public.job_events (
 id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.agent_jobs(id), workspace_id uuid NOT NULL,
 event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,workspace_id) REFERENCES public.agent_jobs(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS public.usage_events (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, job_id uuid NOT NULL, data jsonb NOT NULL,
 reference text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,workspace_id) REFERENCES public.agent_jobs(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS public.billing_events (
 id text PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, processed_at timestamptz, error_code text,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.api_tokens (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes text[] NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.upload_tickets (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, user_id text NOT NULL,
 token_hash text NOT NULL UNIQUE, name text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
 FOREIGN KEY(project_id,workspace_id) REFERENCES public.projects(id,workspace_id)
);
ALTER TABLE public.upload_tickets ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS public.audit_events (
 id uuid PRIMARY KEY, workspace_id uuid REFERENCES public.workspaces(id), actor_id text NOT NULL,
 action text NOT NULL, target_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.account_requests (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deletion','support')), status text NOT NULL DEFAULT 'pending',
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.write_receipts (
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 action text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id,action,request_key)
);
ALTER TABLE public.write_receipts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_private.actor_id() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('app.actor_id',true),''),
  NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')
$$;
CREATE OR REPLACE FUNCTION app_private.is_member(target uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=target
  AND user_id=app_private.actor_id() AND status='active')
$$;
REVOKE ALL ON FUNCTION app_private.is_member(uuid) FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workspaces','workspace_members','projects','assets','campaign_revisions','subscriptions','credit_ledger','agent_jobs','credit_reservations','agent_job_steps','job_events','usage_events','billing_events','api_tokens','upload_tickets','audit_events','account_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  GRANT USAGE ON SCHEMA app_private TO authenticated;
  GRANT EXECUTE ON FUNCTION app_private.actor_id() TO authenticated;
  GRANT EXECUTE ON FUNCTION app_private.is_member(uuid) TO authenticated;
  FOREACH t IN ARRAY ARRAY['projects','assets','campaign_revisions','subscriptions','credit_ledger','agent_jobs','job_events'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS workspace_read ON public.%I',t);
   EXECUTE format('CREATE POLICY workspace_read ON public.%I FOR SELECT TO authenticated USING (app_private.is_member(workspace_id))',t);
   EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
  END LOOP;
 END IF;
END $$;
-- No direct client mutation policies: validated writes and ledger changes go through the API.
-- Storage is private; uploads/downloads are authorized by the API with server credentials.
