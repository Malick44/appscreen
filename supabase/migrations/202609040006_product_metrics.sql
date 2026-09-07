-- Minimal first-use milestones; no names, emails, prompts, image contents,
-- provider IDs, URLs, or arbitrary analytics properties are stored here.
CREATE TABLE public.product_milestones (
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
 milestone text NOT NULL CHECK (milestone IN ('signup','first_upload','first_campaign','first_export','paid_conversion')),
 environment text NOT NULL CHECK (environment IN ('production','nonproduction')),
 occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,milestone)
);
CREATE INDEX product_milestones_cohort_idx ON public.product_milestones(environment,milestone,occurred_at);
ALTER TABLE public.product_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_milestones FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.product_milestones FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.product_milestones FROM authenticated; END IF;
END $$;
-- No historical backfill: old records do not establish these event semantics.
