# AppScreen SaaS setup

This is a deployment runbook, not a record of a production deployment. Existing static-site `Dockerfile` and Compose files remain unchanged. The hosted application uses `Dockerfile.saas`: choose the opt-in `docker-compose.saas.yml` for a reviewed Coolify/Compose target or `deploy/render.yaml` for Render. Do not deploy both by default.

For the existing public domain, start with [the staged Coolify deployment guide](deploy/COOLIFY.md). It covers keeping the current editor online, required account/storage settings, verification and an approved cutover. Rebuilding the legacy static image does not deploy the SaaS landing/login pages. `npm run deploy:verify -- https://your-approved-host` checks the route/asset distinction without signing in or changing data; it does not replace account and export testing.

## Architecture and prerequisites

The web service serves the customer workspace, editor, API and MCP endpoint. A separate worker handles durable jobs, AI calls, rendering and exports. PostgreSQL stores tenant permissions, immutable revisions, credits and jobs; private Supabase Storage holds original screenshots and artifacts. Supabase Auth handles accounts and optional native OAuth. Stripe is configured separately for subscriptions. Neither the browser nor an external MCP client receives server provider keys.

Use Node 22.22.3 and the checked-in `package-lock.json`. The image pins the Node base digest and installs Chromium from locked Playwright 1.59.1, matching the tested renderer. Do not run `npm update` during deployment. When patching Node, Playwright or fonts, update the pins deliberately and rerun render/ZIP regressions. Reproducible application/browser inputs do not replace OS image vulnerability scans or a regular patch schedule.

## Local development

The original editor is at `http://localhost:8000`; the SaaS normally runs at `http://127.0.0.1:8001`. Use a dedicated local PostgreSQL database and the non-secret names/defaults in `.env.saas.example`. Supply values through an ignored local file or the process environment; do not replace an existing `.env` containing other work. If using a separate ignored file, set `DOTENV_CONFIG_PATH` to that file when starting the service.

```sh
npm ci
npx playwright install chromium
npm run db:migrate
npm run dev:saas
```

Local-only account testing requires `APPSCREEN_DEV_AUTH=true`; embedded local jobs require `APPSCREEN_EMBEDDED_WORKER=true`. Both must be false in production. Leave `APPSCREEN_ENABLE_AI=false` until paid provider testing is authorized. The normal local workflow supports real manual drafts and exports without making an AI call.

## Template availability and job admission

Catalog list/detail exposes `cloudCompatible` and `cloudLimitations`. Explicit cloud choices require compatibility; 3D devices and layered lifestyle photos currently remain local-editor-only. Flat uploaded backgrounds are not layered photos. These flags describe renderer capabilities, not a guarantee of visual quality or complete asset readiness.

Saved template preferences are retained even when a template is removed or becomes unsupported. The UI explains the issue before starting; “Choose for me” ignores the retained ID without deleting the preference. Manual creation/application, new jobs and retries enforce compatibility server-side before admitting new work. Existing idempotency receipts still report the original job, including historical auto requests; changed substantive input remains a conflict. A receipt replay is not permission to rerun a failed design.

Resumed staged documents are checked before further model work. A stopped job whose immutable input or saved composition uses unsupported features needs a new supported draft; retries cannot re-reserve credits for it. These checks do not enable AI or make production provider calls. The current local regression evidence is in `IMPLEMENTATION_STATUS.md`.

## Supabase: database, authentication and private files

For an existing self-hosted installation, first follow [the isolation and compatibility checklist](deploy/SELF_HOSTED_SUPABASE.md). A running Supabase installation is not necessarily an unused AppScreen backend. Do not apply these migrations or replace Auth settings in another application's database.

1. Choose a project and region near the worker. Use a direct PostgreSQL connection, or the session pooler when IPv4 connectivity requires it. Do not substitute the transaction pooler for this long-running job service. Keep TLS verification enabled. Allow sufficient connections for each web/worker database pool and pg-boss. [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. Run `npm run db:migrate` once with the intended database supplied at runtime. Applied files in `supabase/migrations/` are SHA-256 tracked and append-only; add a new ordered file for later changes. Use an appropriately privileged deployment account; never expose it through the browser. Production web/worker startup only verifies history and fails if migrations are pending, missing or changed. Its runtime database role still needs validated application-data writes and pg-boss permissions, but no application-schema migration authority. Review exact role grants on the intended provider. Pause existing writes/workers when first adopting an untracked database. See [migration and recovery procedures](deploy/OPERATIONS.md).
3. In an AppScreen-dedicated Supabase instance, configure Auth Site URL to the exact HTTPS AppScreen origin. Add the required confirmation/recovery callback URLs on that origin, configure the selected sign-in methods and production email delivery, and verify confirmation, sign-out and password recovery with test accounts. Do not replace shared Auth settings belonging to another app. Production verification defaults to asymmetric `jwks`; explicitly reviewed HS256 self-hosted browser sessions can use `SUPABASE_AUTH_VERIFICATION=auth-server`, with MCP OAuth disabled. There is no automatic fallback and no installation-wide JWT signing secret is needed by AppScreen.
4. Create the `appscreen-private` bucket with `public=false`, MIME types `image/png`, `image/jpeg`, `application/zip`, and a reviewed maximum file size of 524288000 bytes. The service's source-upload limit is separately 20 MiB. The larger bucket ceiling accommodates campaign/project archives; it does not increase a customer's workspace quota. If your provider plan limits files below this, resolve that limit before launch.
5. Either use the Dashboard or run the following explicit setup command with the Storage credential pair and optional `SUPABASE_STORAGE_BUCKET` already in the trusted process environment. For one installation, use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. For separate Auth and Storage installations, set both `SUPABASE_STORAGE_URL` and `SUPABASE_STORAGE_SERVICE_ROLE_KEY`; the script uses that pair exclusively. The script never changes an existing bucket. Omit `--create` to inspect only.

```sh
node deploy/ensure-storage.mjs --create
node deploy/ensure-storage.mjs
```

Auth and Storage can use separate installations. Keep `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` pointed at AppScreen's Auth instance, and set both Storage overrides on web and worker. `SUPABASE_STORAGE_URL` must be a canonical HTTPS origin without a trailing slash, path, query or credentials. Startup rejects a partial override rather than combining credentials across installations. If both overrides are empty, Storage uses the legacy Auth URL/service-role pair. With split Storage and service email disabled, `SUPABASE_SERVICE_ROLE_KEY` may be empty; enabling service email requires the Auth instance's admin key. A separate bucket does not narrow an installation-wide Storage service-role key, so review that scope before sharing an existing Storage installation.

No public object policy is needed. All object reads/writes go through the authorized server; service-role credentials bypass Storage RLS and must remain server-only. Do not grant anonymous/authenticated users blanket bucket access. Both deployment processes verify privacy and MIME policy at startup, without creating resources. [Private bucket behavior](https://supabase.com/docs/guides/storage/buckets/fundamentals), [bucket setup](https://supabase.com/docs/guides/storage/buckets/creating-buckets)

## Render deployment

Review `deploy/render.yaml` as a Blueprint; creating services is an explicit operator action and incurs hosting charges. It defines a paid web process and a separate, larger worker with automatic deploys disabled. Select an appropriate region/size after measuring a ten-screen export; the included plan choices are starting configurations, not capacity guarantees. Render workers poll jobs without a public listener. [Docker deployments](https://render.com/docs/docker), [background workers](https://render.com/docs/background-workers)

Supply required secrets via Render's protected environment settings, not the repository or Docker build arguments. The Dockerfile uses an allowlisted build context, never `COPY .`, and never consumes secret build arguments. `Dockerfile.saas.dockerignore` intentionally takes precedence over the legacy ignore file, which excludes Node manifests. [Docker context rules](https://docs.docker.com/build/concepts/context/#dockerignore-files)

Both processes must have identical values for:

| Setting | Required value/purpose |
| --- | --- |
| `APP_BASE_URL` | Exact public HTTPS web origin, including the custom domain if used. The worker fetches only bundled renderer files from this origin. |
| `DATABASE_URL` | Same PostgreSQL database with verified TLS. |
| `APPSCREEN_SIGNING_SECRET` | Same cryptographically random secret, at least 48 characters; provision through a secret manager. Do not independently generate one per process. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Intended Auth project; publishable key is the only client-visible key. |
| `SUPABASE_AUTH_VERIFICATION` | Same explicit mode on both processes: `jwks` by default, or reviewed `auth-server` for HS256 browser sessions with MCP OAuth disabled. |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth admin key; also supplies Storage access in the legacy single-installation setup. Optional with split Storage and service email disabled. |
| `SUPABASE_STORAGE_URL`, `SUPABASE_STORAGE_SERVICE_ROLE_KEY` | Optional paired overrides for a separate Storage installation. Set both or neither on both processes. |
| `SUPABASE_STORAGE_BUCKET` | Verified private bucket in the selected Storage installation. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Approved server project key and reviewed model; required only when enabling hosted AI. Current admission/UI checks require both web and worker to have the key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` | One consistent Stripe environment; leave unset while billing is disabled. |
| Credit, upload, storage and concurrency limits | Same business policy in both processes. |

The Blueprint defaults to a single Supabase installation and prompts for service-specific secret values because Render does not accept `sync:false` entries inside environment groups. For split Auth/Storage, add both Storage overrides to each service's protected runtime settings. Fill optional AI/billing values only when enabling them. If managing secrets in an existing shared group instead, remove duplicate service overrides in your deployment configuration. [Blueprint reference](https://render.com/docs/blueprint-spec)

### Browser sandbox: mandatory launch gate

Build and test the container on the intended Linux host:

```sh
docker build -f Dockerfile.saas -t appscreen-saas:reviewed .
docker run --rm --shm-size=1g appscreen-saas:reviewed node deploy/verify-browser.mjs
```

The worker runs as non-root `node`, uses `chromiumSandbox:true`, and refuses to start if a sandboxed render fails. The host must permit the required user namespaces/seccomp operations and adequate shared memory. Confirm those capabilities with the intended Render environment before accepting paid design jobs. The standard Render Blueprint cannot configure a custom Docker seccomp profile; its success on a particular host is not assumed here. If that host rejects Chromium's sandbox, use a compatible isolated worker host after infrastructure review. Do not add `--no-sandbox`, root, `--privileged` or broad capabilities as a shortcut. The worker only loads allowlisted application code, not arbitrary customer websites. [Playwright container requirements](https://playwright.dev/docs/docker)

Web startup verifies storage and database connectivity. Render's `/health` check is web-only; a background worker intentionally has no HTTP health endpoint. Use worker process status/logs and a real canary export in addition to queue checks. [Render health checks](https://render.com/docs/health-checks)

## Enable paid AI and billing in stages

Deploy with `APPSCREEN_ENABLE_AI=false` and `APPSCREEN_MCP_OAUTH=false`. First complete the no-AI upload → draft → editor save/reload → apply → PNG/ZIP/project-backup flow. Confirm a second workspace cannot read or alter those assets/revisions.

Also rehearse **Campaigns → Import editable backup**: import the generated editable-project ZIP into a new private campaign, reopen its editor, and compare exported PNGs and original image bytes. This route never overwrites a campaign and does not accept whole-account archives, store PNG ZIPs or legacy JSON. It is not an account/disaster restore. The archive limits are 100 MiB compressed / 200 MiB expanded, 2 MiB JSON and 101 entries, plus configured per-image limits. A two-import per-process gate bounds concurrent parsing; production proxy/body/time limits and multi-instance abuse controls still require deployment verification. Client retries bind account, workspace, file and name to a stable receipt; do not clear browser session storage during an uncertain import. After reload, reselect the same file/name in that tab and original account. Inspect campaigns before retrying with a new receipt if that storage was lost.

Before enabling AI, provision a server key in the intended provider project, set spend limits, and authorize a bounded real design test. Enable `APPSCREEN_ENABLE_AI=true` in both processes only after evaluating source fidelity, text claims, exact/inspiration locks and the <=2-repair path. Check the stored usage and customer credit ledger. Failed/cancelled jobs release customer reservations, but provider work already performed may still incur operator costs.

Before enabling real subscriptions, configure a recurring Stripe Price, checkout return URLs and the signed webhook at `/api/billing/webhook`. Use Stripe test mode to verify checkout duplication, renewal, cancellation, failed payments, out-of-order events and reconciliation. `PRO_PRICE_AMOUNT` and currency shown in the UI must match the configured price; do not invent pricing. Complete policy/legal review before accepting live payments. Consult the current billing implementation/runbook for its event subscriptions and reconciliation procedures.

## Customer operations available locally

The customer workspace includes an in-app notification inbox and versioned support conversations; staff have an audited private-case view, reply/escalation controls and a content-free operations report. Migrations add server-only support messages, notifications, first-use milestones and opt-in email delivery. Apply them through the normal controlled migration step; never edit already applied SQL. In-app notices are transactional and retry-safe. The service-email outbox and Resend adapter are implemented but disabled; actual recovery/billing/service email, external alert delivery, support staffing and privacy/retention approval remain launch requirements. See [the operations runbook](deploy/OPERATIONS.md).

## Service email — implemented, disabled by default

Staff email review is available at `/app/operator/email` after the append-only `202609050008_email_incident_reviews.sql` migration. It separates delivery evidence from staff investigation/closed-without-resend decisions, rejects stale edits and records repeat-safe private audit reasons. It never sends mail, changes provider evidence, removes suppressions or fulfils retention/deletion requests. Current open incidents drive the on-demand queue monitor; raw delivery counts are retained. Review data is excluded from customer workspace ZIPs. Actual provider investigation, email delivery, retention and external alerting still require approval and verification.

`node saas/tests/email-operations.browser-qa.mjs` runs isolated desktop/mobile checks without a database or real account. Its temporary server serves app files only; every API request is synthetic and external requests fail. It verifies confirmations, keyboard focus, frozen retries across navigation/reload, stale feedback and sign-out cleanup, and saves screenshots to a new temporary folder. This is UI evidence, not verification of hosted MFA, email delivery or provider-side incident resolution. Pending review reasons are retained in tab-scoped session storage for exact retries, cleared on confirmed outcome or successful sign-out; do not enter personal data or credentials.

The inbox contains explicit email preferences. Default is off; enabling applies only to new campaign, support and payment-attention notices in that workspace. The browser cannot supply a destination, message body or template. Delivery resolves the user's current confirmed Supabase Auth email server-side; stale membership addresses and development accounts cannot receive mail. No screenshot, prompt, support body, payment identifier, signed asset link or provider secret is included in the static messages.

Do not enable delivery as part of a routine deploy. After provider/sender approval, configure a dedicated Resend sending domain/address, complete its required domain authentication, and supply `APPSCREEN_EMAIL_FROM`, `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` through the approved server secret store. The web and worker must share the same sender/origin/configuration; keep API keys server-only. Register `/api/webhooks/email` on the exact approved HTTPS AppScreen origin for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`. Raw-body signatures are verified with Svix. Provider setup and domain verification have **not** been performed. [Resend sending](https://resend.com/docs/api-reference/emails/send-email), [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)

Only then enable `APPSCREEN_EMAIL_ENABLED=true` in an approved isolated environment and test with a consenting, controlled, verified account. Confirm opt-in, real receipt, link destination, preferences, suppression, duplicate/out-of-order event handling, worker restart and uncertain-send recovery. Disable sending afterward unless production activation was separately approved. Configuration validation and mock tests are not delivery or domain-verification evidence. Supabase continues to own authentication and recovery emails; this outbox does not issue password/reset tokens or replace Auth SMTP configuration.

The worker retains immutable send intent and retries with the same provider key. Automatic retries stop before the provider's 24-hour idempotency window expires; uncertain old sends require operator review, not a fresh key. Accepted means provider acceptance, delivered means acceptance by the recipient's mail server—not inbox placement or reading. Turning email off cannot recall in-flight or already accepted messages. The detailed runbook covers failure handling, privacy and recovery constraints. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [delivery events](https://resend.com/docs/webhooks/event-types)

## MCP connections and native OAuth

Scoped, expiring bearer connections can be created in AppScreen's Connections page. The direct-designer path lets Codex or Claude upload screenshots and edit/render drafts without an AppScreen-hosted model call. Hosted design/refinement requires the separate `ai:run` scope and an authorized credit ceiling. See `server/mcp/README.md` for connector configuration and tool permissions.

OAuth is optional and remains disabled in the deployment defaults. Supabase handles identity, client registration, PKCE/code exchange and refresh tokens; AppScreen stores the owner's additional workspace permission decision. Do not advertise production OAuth until all gates below have recorded evidence.

### Configure the intended test provider

1. Use an operator-authorized non-production Supabase project and disposable test accounts. Configure its Site URL to the exact AppScreen HTTPS origin, enable the native OAuth server, set authorization path `/oauth/consent`, and enable dynamic client registration if needed by the installed clients. Register exact callbacks for pre-registered clients; do not guess them from examples. [Supabase OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
2. For MCP OAuth, require `SUPABASE_AUTH_VERIFICATION=jwks` and an asymmetric JWT signing key exposed by `/auth/v1/.well-known/jwks.json`; verify both browser and OAuth tokens with the intended issuer. The opt-in `auth-server` compatibility mode is for HS256 browser sessions only and cannot enable MCP OAuth. Migrate an AppScreen-dedicated legacy instance using the provider's signing-key procedure, then refresh test sessions before testing. Never rotate another application's shared signing keys or copy a JWT signing secret into AppScreen to bypass this requirement. [Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys)
3. Apply the reviewed migrations with `npm run db:migrate`; enable the `public.appscreen_access_token_hook` custom access-token hook. Check that only `supabase_auth_admin` can execute the hook, with schema access; `anon`, `authenticated` and `PUBLIC` must not have execute rights. Confirm the hook preserves ordinary browser claims and binds OAuth tokens to the exact `/mcp` resource, client, workspace, grant version and selected scopes. [Auth hook permissions](https://supabase.com/docs/guides/auth/auth-hooks), [custom access-token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
4. Only then enable `APPSCREEN_MCP_OAUTH=true` in that controlled test environment. The native identity scope is `openid`; AppScreen permissions such as `ai:run` are a separate explicit consent decision, not invented provider scopes. Keep hosted AI permission off unless the test specifically authorizes its cost.

### Mandatory provider and client launch gates

Record provider/project configuration, installed client versions, test account IDs, timestamps and redacted results. Do not retain raw access tokens, codes, refresh tokens or client secrets in evidence.

- In **both actual Codex and Claude Code**, verify discovery, DCR or a registered public client, exact callback/issuer handling, PKCE S256 code exchange, denial/cancel, code replay rejection, refresh and refresh-token revocation. Test a named and an unnamed client. A local mock provider passing is not this evidence. Codex's registration and callback behavior varies with provider metadata; use its displayed callback and supported login flow. [Official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp), [Claude Code MCP guide](https://code.claude.com/docs/en/mcp)
- With a read-only OAuth grant, prove project writes, hosted AI, billing, connection creation, operator endpoints and other workspaces are denied. Test token audience/client/version tampering. Revoke access and confirm existing tokens, previously issued media links, upload tickets and open event streams stop working; refresh must not restore a revoked or expired local grant.
- **Test the underlying Supabase Auth boundary, not just AppScreen's API.** Using only the disposable account's OAuth access token, verify native Auth rejects account metadata, email/password, identity and MFA mutations, and unauthorized grant/session management. Also verify direct Data API and Storage access cannot bypass AppScreen scopes. Database RLS and AppScreen audience checks do not establish the native Auth endpoint's behavior. The current local suite does not test the hosted provider's account-mutation protection; this remains an unresolved launch gate, not a confirmed production vulnerability. If any mutation succeeds, stop and keep OAuth disabled until the provider boundary is fixed or a separately reviewed identity design is used. [Supabase OAuth token/RLS guidance](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- Verify ordinary owner sign-in, account recovery and sign-out still work after enabling the token hook. Bearer connections must continue to work independently while OAuth is disabled or unavailable.

### Reconnecting safely

Previously approved upstream consent can return a callback without client identity. AppScreen deliberately discards that callback/code, because it cannot establish which local permissions may be renewed. This also applies when an existing local grant is still valid: existing access is unchanged, but a new authorization does not silently extend it.

The owner must choose exactly one known connection and confirm clearing its previous approval. The browser sends `POST /api/connections/:id/reconnect` with the current `expectedVersion` and `confirmation:"reconnect"`. Local access is revoked immediately; only that client's native approval is removed. Scopes and expiry are never extended by reset. After success the owner restarts sign-in from the agent and explicitly chooses permissions on the fresh consent page. This extra restart is a deliberate UX limitation until the provider supplies sufficient verified identity for reused consent.

If native revocation fails, local access stays revoked and the UI reports `upstreamRevocationPending`; retry using the returned version or reload before retrying. A changed version must be reloaded, and an in-progress change must finish before another approval/reset. Per-user/client serialization prevents an older reset from revoking a newly approved version. Never clear all provider grants as a reconnect shortcut. If there is no known local connection to select, the operator must identify and remove only the intended provider approval, or the user can use an expiring scoped bearer token.

Enable and advertise OAuth in production only after these provider/client gates pass. Unit tests, metadata discovery and local signed-JWT tests are necessary but insufficient.

## Verification and operational handoff

```sh
npm run typecheck
npm run test:unit
npx tsx --test server/tests/deployment.test.ts server/tests/worker.test.ts
```

Run `npm test` with both `TEST_DATABASE_URL` and `DATABASE_URL` supplied through the trusted process environment and pointed at the same dedicated test database. Set `DOTENV_CONFIG_PATH=/dev/null` to keep real environment files out of the test process. Never aim fixture tests at production. Without `TEST_DATABASE_URL`, database-dependent tests skip; skipped checks are not release evidence. The import and worker checkpoint tests also verify that `DATABASE_URL` matches before they run; the checkpoint test requires `127.0.0.1:55432/appscreen_test` and the dotenv override. The real renderer test starts its own local HTTP server and inspects PNGs. `node server/tests/ui-smoke.mjs` is a separate opt-in headless browser regression against loopback development sign-in; it creates clearly labeled synthetic data, blocks external service requests and revokes temporary connection tokens. It does not test production email, OAuth or payment providers. Container validation is separate: at initial preparation the local Docker build was stopped by insufficient Docker VM disk space, so a successful production-like container build is still a launch gate, not a claimed result.

### External-agent and AI rehearsals

`npx tsx server/tests/mcp-client-smoke.ts` uses the actual MCP SDK over HTTP with
fresh synthetic test workspaces and temporary scoped connections. It exercises
template/device edits, PNG/ZIP/editable exports, tenant denials and revocation.
It does not modify installed Codex/Claude settings, run their models or prove
native OAuth interoperability. The report separates protocol success from
intentional layout warnings.

`npx tsx server/tests/live-ai-smoke.ts --prepare` is offline-only by default and
accepts only a loopback `TEST_DATABASE_URL` whose database is `appscreen_test`.
It creates a new private temporary directory, five fixed synthetic FocusBoard
screens, an exact Tidal Relay manual base and a preparation report. It does not
load dotenv, read a provider credential, enable customer AI or consume jobs.
Inspect originals and the contact sheet before any live evaluation.

Live execution requires explicit approval for the intended AppScreen key file,
synthetic sources and total test allowance. The current runner additionally
requires one pinned private ledger with a maximum $5 aggregate model-token
allowance **including earlier attempts**. Initialize it once with the independently
verified earlier report hash and full retained reservation; never create a new
ledger to reset an exhausted or uncertain allowance. The explicit environment
binding contains the directory, budget ID and manifest hash plus
`APPSCREEN_LIVE_AI_TOTAL_CONFIRM=synthetic-total-usd5-including-prior`.

Every attempt still needs a fresh prepared run ID, same-UTC-day pricing review,
unchanged synthetic inputs and an exclusive one-use receipt. Aggregate ownership
and that receipt precede the only approved credential read. Every generation is
counted, then durably reserved before dispatch. All holds remain, including
successful and ambiguous calls. Only a cleanly closed process lock is removed;
partial writes, crashes, changed evidence or unclosed runs stop subsequent work.
Do not delete receipts/locks, overwrite failed reports or automatically recover an
uncertain ledger. A controlled new attempt must use the same reviewed ledger and
fit the remaining total allowance; SDK retries remain disabled.

Only the official Responses/token-count endpoints are permitted, with redirects
blocked. Pricing and preparation expire; configuration alone is not spending
permission. These single-host guards apply to this isolated rehearsal, not ordinary
production jobs or distributed workers, and do not guarantee an invoice. A single
synthetic success is not the representative quality, refinement, recovery or
invoice reconciliation required for launch.

Additional opt-in rehearsals (never point them at customer data):

```sh
# Supply TEST_DATABASE_URL securely for a migrated loopback-only test database.
npx tsx server/tests/operations-ui-smoke.ts
npx tsx server/tests/render-capacity-smoke.ts

# Select the exact local PostgreSQL container serving that test database.
APPSCREEN_RESTORE_DRILL_CONFIRM=synthetic-only \
  RESTORE_DRILL_POSTGRES_CONTAINER=appscreen-saas-postgres-bind \
  npx tsx server/tests/restore-drill-smoke.ts
```

The operations rehearsal checks customer/staff support, inbox retries and responsive reports. The capacity rehearsal measures four actual ten-screen worker exports: an intentionally warning-bearing baseline and a copy-only refinement, each with editable backup and store ZIP. It preserves both results, validates all PNG pixels, archive CRCs/manifests and shared-device geometry, and records scoped Node/Chromium RSS samples. It is not a production load test or a live-AI quality evaluation; visual review remains required even when automated warnings clear.

The restore rehearsal **only creates fresh synthetic source/target databases**, verifies the chosen container matches the loopback PostgreSQL installation, and restores a persisted logical dump plus checksummed private local files into its empty target. It cannot accept a customer archive or an existing restore target. It tests actual recovered API permissions/conflicts and identical exports without starting queue consumers or replaying copied jobs. Reports, private files and named rehearsal databases are retained for review; cleanup is a separate explicit-target operation. This is not managed Supabase/Auth recovery, an encrypted off-site backup, or a disaster-recovery time guarantee. See the recovery runbook for those remaining gates.

Importing `server/config.ts` does not load a working-directory `.env`. Only the actual web, worker and migration entrypoints do so explicitly. Rehearsals pass isolated configuration with provider keys empty; this does not alter normal deployment environment loading.

Before release, record the commit/image digest, test outcomes, one ten-screen export's memory/time, image sizes/alpha behavior, checkpoint recovery after worker restart, credit settlement, support routing and the last successful restore drill. Enable AI/billing only after the relevant checks. Roll back to a known-compatible application image; do not automatically reverse or delete schema/data during rollback. Follow `deploy/OPERATIONS.md` for monitoring, backup and recovery.

The factual inventory in `deploy/ASSET_LICENSE_REVIEW.md` records unresolved application/model/artwork provenance and attribution issues. A working renderer or a partial notices page does not establish commercial distribution rights. Resolve those issues and complete the binary/dependency notice review before public sale.
