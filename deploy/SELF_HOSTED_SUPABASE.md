# AppScreen on self-hosted Supabase

Status: local integration preparation, not a completed deployment. No existing service, database, bucket, credential, domain or Auth setting was changed during this assessment.

## Verified assessment — 2026-09-08

- Coolify's existing Supabase service `supabase-esvc222xtty65n9ewx9yljcq` runs on `luma-dock`, the same server as the static AppScreen site. Core Auth, database and Storage containers report healthy.
- The configured gateway domains are `https://supabase.app.ai-orbit-studio.com` and `https://supabase-app.ai-orbit-studio.com`. Both returned HTTP 200 with an empty `keys` array at `/auth/v1/.well-known/jwks.json`. This establishes that AppScreen's default public-key verifier has no keys to use; it does not by itself prove the algorithm or issuer of a real session.
- A bounded read-only database transaction found 47 public tables, existing Auth users, stored files and three buckets. Only schema metadata and existence checks were inspected, not customer records. The transaction ended with `ROLLBACK`. Treat this as an actively used backend, not a fresh AppScreen instance.
- The database container reported a 97 GiB root filesystem with 65 GiB available, 7,937 MiB system memory with 1,601 MiB available, and swap already in use. These are a point-in-time container-visible host resource check, not a load test or reserved capacity guarantee.

## Recommended isolation

Use a **separate AppScreen Supabase instance**, with its own database volume, keys, Auth users, private Storage and backups. Reuse the existing server only after capacity is increased or sufficient headroom is independently established. Supabase lists 4 GB RAM as the minimum for its full stack and 8 GB+ recommended; AppScreen's web process and sandboxed rendering worker require additional headroom. The observed spare memory does not support assuming another full stack can safely run here. Do not stop other applications, delete images/volumes, reduce their limits or change server plans automatically. [Supabase requirements](https://supabase.com/docs/guides/self-hosting/docker#system-requirements)

Self-hosted Supabase runs as one project. Adding a Coolify project label, a database schema or a bucket does not create an independent Auth project. [Self-hosting model](https://supabase.com/docs/guides/self-hosting)

A lower-resource alternative is a separate `appscreen` database within the existing PostgreSQL cluster plus a new private bucket, sharing existing Auth. AppScreen has no `auth.users` foreign keys or joins, so the current browser and scoped-token paths can support that architecture. However, this explicitly shares user accounts, recovery policy and installation-wide Storage administration credentials. Existing Supabase users could create AppScreen workspaces. This is **not** the default recommendation and requires the owner's informed choice. Never run AppScreen migrations in the existing app's `postgres` database: generic `public.projects`, `assets`, `notifications` and other names, policies and functions can collide. A different `search_path` alone does not isolate explicitly qualified migration SQL.

## Browser authentication compatibility

- Default: `SUPABASE_AUTH_VERIFICATION=jwks`. Use this when the intended issuer publishes asymmetric public signing keys. Failed verification never falls back to another mode.
- Explicit compatibility: `SUPABASE_AUTH_VERIFICATION=auth-server` for HS256 browser tokens. AppScreen sends the exact bearer to the configured Supabase `/auth/v1/user` endpoint with the public API key and requires successful server validation and a matching user identity. It also checks issuer, audience, expiration and account restrictions. No Supabase JWT signing secret is supplied to AppScreen. Supabase documents this server-verification approach through `getUser(jwt)`. [Authenticated user verification](https://supabase.com/docs/reference/javascript/auth-getuser)
- Confirm a real test session's issuer equals `${SUPABASE_URL}/auth/v1`. Configure the correct canonical gateway URL; do not disable issuer checks or copy tokens into tickets, logs or chat.
- Keep `APPSCREEN_MCP_OAUTH=false` with `auth-server`. AppScreen's scoped `ask_` connections remain separate and available. OAuth requires asymmetric verification and the reviewed AppScreen Auth hook deployment. Never attach that hook to another app's shared Auth service.
- This mode changes application code only until explicitly set on both production processes. It does not rotate Supabase keys, create accounts or alter existing sessions.

## Provisioning sequence after the hosting choice

1. Confirm adequate host capacity, an isolated AppScreen resource and exact HTTPS gateway/candidate domains. Record backups and the existing static deployment rollback target. Creating resources, security-sensitive access and domain changes need the applicable owner approval; a resource name in this document is not that approval.
2. Provision a separate supported Supabase stack with independent private volumes, secure generated credentials and a reviewed version set. Do not clone the live stack's data or secrets. Leave PostgreSQL private and expose only the intended HTTPS gateway; keep Studio behind its access protection. Preserve all existing stacks and networks.
3. Configure AppScreen-only Auth Site URL and exact confirmation/recovery redirects, real Auth mail delivery and the appropriate verification mode. Test actual issued tokens without printing credentials. Keep hosted AI, billing, MCP OAuth and service email disabled during the initial rollout.
4. Create the private `appscreen-private` bucket using `deploy/ensure-storage.mjs --create` only against this new target. Verify the existing MIME/privacy policy and 500 MiB archive ceiling; check Storage's global upload ceiling as well. AppScreen's individual source uploads remain limited to 20 MiB.
5. Provision the AppScreen migration/runtime database roles and private connectivity. Verify ownership/RLS behavior and pg-boss schema privileges; ordinary table grants alone are not proof of a functioning runtime role. Never use an installation-wide superuser or broad BYPASSRLS credential as a convenience. Apply AppScreen migrations only to the verified new database. Startup does not apply application migrations; worker startup does initialize/migrate its own queue schema.
6. Supply the new instance's URL, public key, private Storage key and AppScreen database/signing configuration only to the candidate web and worker's protected runtime settings. Never use Docker build arguments, browser-side storage or committed environment files for secrets.
7. Follow [the Coolify candidate rollout](COOLIFY.md): actual Linux image build, browser sandbox check, web/worker readiness, signup/confirmation/recovery, two-workspace isolation, upload/edit/save/reload and PNG/ZIP export. HTTP route checks alone are insufficient. Switch the live AppScreen domain only after the candidate journey and the cutover approval pass.

## Remaining decisions

The existing Supabase cannot be treated as unused. Choose sufficient capacity for a dedicated AppScreen instance, or explicitly accept shared Auth and Storage administration for the lower-resource alternative. No new server subscription, plan upgrade or production resource has been purchased or created.

## Local verification

The compatibility change passed 14 focused offline authentication tests, three Compose configuration tests, ten configuration-isolation/deployment tests, and TypeScript checking. Tests use synthetic identities/keys and mocked signature-verifying Auth responses; they do not prove real self-hosted signup or send customer credentials to a provider. No database test suite or worker was started. A real candidate account/export journey and production-like Linux build remain required before deployment.
