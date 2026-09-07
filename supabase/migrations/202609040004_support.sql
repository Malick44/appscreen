-- Support conversation state is separate from deletion-request lifecycle data.
-- Existing support requests retain their original message in details.message.
ALTER TABLE public.account_requests ADD COLUMN IF NOT EXISTS support_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.account_requests ADD COLUMN IF NOT EXISTS support_updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS account_requests_id_workspace_unique
 ON public.account_requests(id,workspace_id);
CREATE INDEX IF NOT EXISTS account_requests_workspace_history
 ON public.account_requests(workspace_id,kind,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_queue_history
 ON public.account_requests(status,created_at DESC,id DESC) WHERE kind='support';

CREATE TABLE IF NOT EXISTS public.support_messages (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, workspace_id uuid NOT NULL,
 author_id text NOT NULL,
 author_kind text NOT NULL CHECK(author_kind IN ('customer','support')),
 visibility text NOT NULL CHECK(visibility IN ('customer','internal')),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 3000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(visibility<>'internal' OR author_kind='support'),
 FOREIGN KEY(request_id,workspace_id) REFERENCES public.account_requests(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON public.support_messages(request_id,created_at,id);
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_messages FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON TABLE public.support_messages FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON TABLE public.support_messages FROM authenticated;
 END IF;
END $$;
-- No browser mutation/read policies. Customer and operator projections are
-- authorized independently by the API; internal notes are never customer data.
