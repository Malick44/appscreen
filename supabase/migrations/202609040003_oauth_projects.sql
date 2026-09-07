-- OAuth identity, code exchange, PKCE and refresh rotation are handled by Supabase Auth.
-- AppScreen separately owns scoped workspace consent and immediate access revocation.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS brief jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS design_preferences jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS public.oauth_grants (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 client_id text NOT NULL, client_name text NOT NULL, scopes text[] NOT NULL,
 version integer NOT NULL DEFAULT 1, resource text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,client_id)
);
CREATE TABLE IF NOT EXISTS public.oauth_authorization_requests (
 id text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES public.workspaces(id), user_id text NOT NULL,
 client_id text NOT NULL, client_name text NOT NULL, redirect_uri text NOT NULL, identity_scopes text NOT NULL,
 consent_nonce_hash text NOT NULL, expires_at timestamptz NOT NULL, decided_at timestamptz,
 decision text, grant_id uuid REFERENCES public.oauth_grants(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.oauth_grants ADD COLUMN IF NOT EXISTS upstream_revocation_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public.oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_authorization_requests ENABLE ROW LEVEL SECURITY;

-- Enable this hook in Supabase Auth only after configuring the OAuth consent path.
-- It never promotes OAuth clients into browser owner sessions or grants database access.
CREATE OR REPLACE FUNCTION public.appscreen_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE claims jsonb:=event->'claims'; client text:=COALESCE(event->>'client_id',event->'claims'->>'client_id'); permission public.oauth_grants;
BEGIN
 IF client IS NULL OR client='' THEN RETURN jsonb_build_object('claims',claims); END IF;
 SELECT * INTO permission FROM public.oauth_grants
  WHERE user_id=COALESCE(event->>'user_id',claims->>'sub') AND client_id=client
   AND revoked_at IS NULL AND expires_at>now();
 IF NOT FOUND THEN
  RETURN jsonb_build_object('error',jsonb_build_object('http_code',403,'message','Approve AppScreen agent access before connecting.'));
 END IF;
 claims:=claims||jsonb_build_object('aud',permission.resource,'client_id',client,
  'appscreen_grant_id',permission.id,'appscreen_grant_version',permission.version,
  'appscreen_workspace_id',permission.workspace_id,'appscreen_scopes',to_jsonb(permission.scopes));
 RETURN jsonb_build_object('claims',claims);
END $$;
REVOKE ALL ON FUNCTION public.appscreen_access_token_hook(jsonb) FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON FUNCTION public.appscreen_access_token_hook(jsonb) FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON FUNCTION public.appscreen_access_token_hook(jsonb) FROM authenticated;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN
  GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
  GRANT EXECUTE ON FUNCTION public.appscreen_access_token_hook(jsonb) TO supabase_auth_admin;
 END IF;
 -- Direct user RLS reads remain available; OAuth tokens must use scoped server tools.
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  FOREACH t IN ARRAY ARRAY['projects','assets','campaign_revisions','subscriptions','credit_ledger','agent_jobs','job_events'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS workspace_read ON public.%I',t);
   EXECUTE format('CREATE POLICY workspace_read ON public.%I FOR SELECT TO authenticated USING (app_private.is_member(workspace_id) AND (NULLIF(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''client_id'') IS NULL)',t);
  END LOOP;
 END IF;
END $$;
