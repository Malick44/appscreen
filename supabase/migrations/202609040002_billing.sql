-- Checkout intents are committed before contacting Stripe. A process crash must
-- never replace the idempotency key of an uncertain external write.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS customer_request_started_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS customer_request_payload jsonb;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reconciliation_required boolean NOT NULL DEFAULT false;
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), customer_id text NOT NULL,
 price_id text NOT NULL, request_payload jsonb NOT NULL, session_id text UNIQUE,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','open','complete','expired')),
 session_url text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_one_pending_checkout
 ON billing_checkout_attempts(workspace_id) WHERE status IN ('creating','open');

CREATE TABLE IF NOT EXISTS billing_credit_grants (
 invoice_id text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), subscription_id text NOT NULL,
 price_id text NOT NULL, period_start bigint NOT NULL, period_end bigint NOT NULL,
 amount integer NOT NULL CHECK(amount>=0), ledger_reference text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(period_end>period_start),
 UNIQUE(workspace_id,subscription_id,price_id,period_start,period_end)
);
CREATE TABLE IF NOT EXISTS billing_review_items (
 review_key text PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id), event_id text,
 reason text NOT NULL, object_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_review_items ENABLE ROW LEVEL SECURITY;
-- Billing mutations are server-only; no direct authenticated-client write policy.
