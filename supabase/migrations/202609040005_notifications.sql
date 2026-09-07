-- Server-only in-app delivery. Contents are fixed templates in application code;
-- source IDs are validated by the transactional helper, never supplied by a client.
CREATE TABLE public.notifications (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 recipient_user_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('design-ready','needs-review','job-failed','export-ready','payment-needs-attention','support-reply')),
 event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),
 project_id uuid, job_id uuid, request_id uuid,
 message_id uuid REFERENCES public.support_messages(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), read_at timestamptz,
 UNIQUE(workspace_id,recipient_user_id,event_key),
 FOREIGN KEY(workspace_id,recipient_user_id) REFERENCES public.workspace_members(workspace_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,workspace_id) REFERENCES public.projects(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(job_id,workspace_id) REFERENCES public.agent_jobs(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(request_id,workspace_id) REFERENCES public.account_requests(id,workspace_id) ON DELETE CASCADE,
 CHECK (
  (kind IN ('design-ready','needs-review','job-failed','export-ready') AND project_id IS NOT NULL AND job_id IS NOT NULL AND request_id IS NULL AND message_id IS NULL)
  OR (kind='support-reply' AND request_id IS NOT NULL AND message_id IS NOT NULL AND project_id IS NULL AND job_id IS NULL)
  OR (kind='payment-needs-attention' AND project_id IS NULL AND job_id IS NULL AND request_id IS NULL AND message_id IS NULL)
 )
);
CREATE INDEX notifications_recipient_history ON public.notifications(workspace_id,recipient_user_id,created_at DESC,id DESC);
CREATE INDEX notifications_unread_history ON public.notifications(workspace_id,recipient_user_id,created_at DESC,id DESC) WHERE read_at IS NULL;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notifications FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON TABLE public.notifications FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON TABLE public.notifications FROM authenticated; END IF;
END $$;
-- No direct Supabase client policies, including SELECT: browser-vs-MCP session
-- distinction and current recipient membership are enforced by the API.
