# AppScreen SaaS on the existing host

Preparation only. No Coolify resource, Supabase project, DNS route, secret or production database was changed by adding these files. The Coolify dashboard was inspected on 2026-09-08: `appscreen` runs on `luma-dock`, uses `/Dockerfile` with port 80, and its latest successful deployment is commit `75b182b`. Confirm the intended Supabase project before using this runbook.

## What changes at the public address

The legacy `Dockerfile`, static Compose files and existing publishing workflow still build the standalone editor. Rebuilding that image cannot expose the SaaS login or landing page. Do not replace those defaults until the SaaS candidate has passed verification.

The opt-in `docker-compose.saas.yml` builds `Dockerfile.saas` for two processes:

| Process | Responsibility | Exposure |
| --- | --- | --- |
| `web` | Landing page, accounts, workspace, editor, API and scoped MCP | Container port 8001 through the HTTPS proxy |
| `worker` | Durable jobs, rendering, PNG/ZIP and editable exports | Private; no public domain or HTTP listener |

The SaaS server serves `/`, `/login`, `/signup` and `/app` from the customer shell. `/editor` serves the existing editor. `/api/config` and `/health` must return JSON; an editor HTML response or plain `healthy` response identifies the wrong deployment. These route checks do not prove signup, email delivery, tenant isolation or export functionality.

Both processes share one runtime configuration. The initial Compose file hard-disables development accounts, embedded jobs, hosted AI, MCP OAuth, service email and payment keys. Enabling those later requires an explicit reviewed configuration change, not simply adding a secret in the dashboard. Direct scoped MCP connections and manual design/export remain available once the real account/storage setup is working.

## Prepare a candidate without replacing the live editor

1. Confirm the exact Coolify project/server and intended Supabase project. Review server capacity and database/storage backups. Use an isolated staging database and Auth/storage project for candidate testing; do not connect an unverified worker to the production job queue.
2. Obtain approval for the exact release source. Local uncommitted files are not fetched by Coolify. The repository requires approval of the proposed commit message before committing; the old GitHub container workflow still builds the static image, not this SaaS candidate.
3. In an approved separate candidate application, select the **Docker Compose** build pack, repository root as Base Directory, and `/docker-compose.saas.yml` as Compose Location. Use the reviewed branch/commit and disable automatic deployments during rehearsal. Use the normal managed-proxy mode, not Raw Compose. Let Coolify create the network; do not add custom proxy labels or custom networks here. [Coolify build-pack guide](https://coolify.io/docs/applications/build-packs/docker-compose)
4. Assign an approved HTTPS staging domain to **web only** and configure that service's container port as 8001. The visitor-facing URL remains the ordinary HTTPS origin; `APP_BASE_URL` must be that exact public origin **without** an internal `:8001` suffix. Never assign the live domain to both old and new applications at once. Leave worker without a domain or host port. [Coolify domain and private-service routing](https://coolify.io/docs/knowledge-base/docker/compose)
5. Set the six required settings below through protected runtime settings. Disable **Build Variable** for credentials and **Inject Build Args to Dockerfile**; this image needs no application secrets during build. Do not paste resolved Compose output, environment dumps or credentials into tickets/logs. [Coolify environment-variable guidance](https://coolify.io/docs/knowledge-base/environment-variables)

| Required setting | Value to select, never commit |
| --- | --- |
| `APP_BASE_URL` | Exact approved public HTTPS origin |
| `DATABASE_URL` | Intended PostgreSQL direct/session connection with verified TLS |
| `APPSCREEN_SIGNING_SECRET` | One random secret, at least 48 characters, shared by both processes |
| `SUPABASE_URL` | Intended project's HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Matching public Auth key |
| `SUPABASE_SERVICE_ROLE_KEY` | Matching server-only private-storage key |

The same file supplies shared quota defaults and the private bucket name. Review them for your policy; they are not a paid pricing plan. Configure real Supabase Auth Site URL, exact confirmation/recovery callbacks, asymmetric signing keys and auth email delivery as described in [SAAS_SETUP.md](../SAAS_SETUP.md). Production cannot use the localhost demo account. Use a separate deployment database credential for migrations where appropriate; do not put its elevated privileges into the long-running services.

## Build, initialize and verify

Run these only in the **approved candidate checkout/host** with its intended values already securely injected. They are not instructions to run against the existing production database. The commands below avoid a repository `.env`; Coolify's dashboard must supply its matching runtime values. Do not print a fully expanded Compose configuration with real secrets.

```sh
# Checks configuration without printing secret values or starting containers.
docker compose --env-file /dev/null -f docker-compose.saas.yml config --quiet
docker compose --env-file /dev/null -f docker-compose.saas.yml build

# Non-mutating private bucket and sandbox checks against the candidate setup.
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps web node deploy/ensure-storage.mjs
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps worker node deploy/verify-browser.mjs

# Explicit schema write: only after backup/target approval, using the reviewed
# deployment-role connection in DATABASE_URL for this one command.
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps web npm run db:migrate
```

Create a missing private bucket only through the separately approved setup in `SAAS_SETUP.md`; startup inspection never creates it. Web/worker startup verifies application migration history and refuses pending or changed migrations. The worker additionally starts pg-boss, whose default startup creates or migrates its `appscreen_queue` schema. The application migration command does not initialize that queue schema: review and authorize those queue writes and required role permissions before starting the worker. A runtime role that can read application migration history may still lack the queue permissions needed to start. There is no separate automatic application-migration service in this Compose file.

Let Coolify start the candidate stack after those gates pass. Verify the two processes use the reviewed source/image, and record both image IDs. Check web JSON health, worker startup and the sandbox result on the actual Linux host. One GiB of worker shared memory is configured; host user namespaces/seccomp support is still required. Do not bypass a sandbox failure with root, privileged mode or `--no-sandbox`. A web health check cannot establish worker readiness.

Run the read-only verifier against the exact candidate origin:

```sh
npm run deploy:verify -- https://your-approved-candidate-host
```

Then use disposable staging accounts to check landing navigation, real signup/confirmation, sign-in, recovery, sign-out, upload five images, create a manual campaign, edit/save/reload, and export PNG/ZIP/editable backup. Confirm a second workspace cannot access the first workspace's private data. Inspect worker logs and the exported images, not just HTTP status. The HTTP verifier does not run this account/export journey, consume credits or contact model/payment/email providers.

## Cutover and rollback require approval

- Record a known-good static image/configuration and the verified candidate image. Back up the intended production database/private files, approve any production migration separately, and prepare the correct production Auth configuration and shared runtime settings. Never promote staging data or staging credentials by accident.
- After approval, configure the candidate for the production origin and verified production backend, migrate the intended database through the controlled step, and switch the existing domain's proxy target to **web:8001**. Keep the rollback configuration available; avoid simultaneously routing that domain to two applications. Validate HTTPS and all SaaS routes again immediately.
- Do not configure the old nginx HTML fallback in front of the SaaS API. Do not cache authenticated pages/API responses in the proxy. Check any existing domain cache rules before enabling real accounts.
- Rehearse rollback. Switching back to the static editor preserves the original UI but removes cloud account/workspace access; it is not a SaaS recovery plan. After customers use SaaS, prefer a known-compatible SaaS image for rollback. Do not reverse migrations, delete buckets or erase browser storage to roll back.

## Preparation evidence — 2026-09-08

- Added the missing `font-library.js` to the SaaS image and its allowlisted build context.
- Added runtime-asset regression checks, opt-in web/worker Compose configuration and a GET-only route verifier with synthetic tests.
- Local verification passed 384 unit tests and 351 SaaS tests against the dedicated test database, with no skipped checks. A temporary local SaaS server passed all 19 public route checks. Docker's static build check completed without warnings; it does not build or execute the image.
- The public domain passed 10 of 19 SaaS route checks: root/login/signup still served the static editor, and customer-shell assets were missing. This confirms that a successful static deployment did not deploy the SaaS runtime.
- The pre-existing editor/font work remains uncommitted and separate from these deployment edits.
- The local Docker VM had approximately 2.2 GiB free at inspection; a full production-like image build was not attempted on this constrained shared runtime. No images, volumes or other applications were removed. Build success and sandboxed Chromium on the chosen host remain release gates.
- No production deployment, migrations, provider activation or end-to-end hosted account test is claimed here. Confirm the target resources before proceeding. Commercial rights, operational readiness and paid-AI/billing launch gates in `SAAS_SETUP.md` still apply.
