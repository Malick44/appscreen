# AppScreen SaaS production release gate

This checklist is mandatory before the production domain is pointed at the SaaS runtime.

## 1. Source and image

- Release source is a reviewed commit on `main`.
- `.github/workflows/saas-ci.yml` is green for that commit.
- The SaaS image was built from `Dockerfile.saas`, not the legacy `Dockerfile`.
- Record the exact commit SHA and image digest before cutover.

## 2. Deployment topology

- Coolify build pack: Docker Compose.
- Compose file: `/docker-compose.saas.yml`.
- Public route is assigned to `web` only.
- `web` internal port: `8001`.
- `worker` has no public domain or host port.
- No nginx SPA fallback sits in front of `/api/*` or `/health`.

## 3. Backend isolation

- AppScreen uses an approved isolated database target.
- Application migrations have NOT been pointed at another application's existing `public` schema.
- Auth and Storage ownership/isolation choice is documented.
- Private bucket is verified before startup.
- Backup and rollback target are recorded.

## 4. Required runtime configuration

Both `web` and `worker` receive the same approved values for:

- `APP_BASE_URL`
- `DATABASE_URL`
- `APPSCREEN_SIGNING_SECRET`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- one complete Storage credential configuration:
  - `SUPABASE_SERVICE_ROLE_KEY`, or
  - both `SUPABASE_STORAGE_URL` and `SUPABASE_STORAGE_SERVICE_ROLE_KEY`

Secrets are runtime-only. Do not pass application secrets as Docker build arguments.

Initial rollout remains intentionally disabled for hosted AI, Stripe billing, service email and MCP OAuth unless a later reviewed release explicitly enables them.

## 5. Pre-start checks

Run against the candidate target only:

```sh
docker compose --env-file /dev/null -f docker-compose.saas.yml config --quiet
docker compose --env-file /dev/null -f docker-compose.saas.yml build
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps web node deploy/ensure-storage.mjs
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps worker node deploy/verify-browser.mjs
```

After database backup/target approval:

```sh
docker compose --env-file /dev/null -f docker-compose.saas.yml run --rm --no-deps web npm run db:migrate
```

Do not bypass Chromium sandbox failure with root, privileged mode, or `--no-sandbox`.

## 6. Anonymous route verification

The candidate must satisfy:

```sh
npm run deploy:verify -- https://candidate.example.com
```

Expected behavior includes:

- `/` -> SaaS landing page
- `/login` -> SaaS login page
- `/signup` -> SaaS signup page
- `/app` -> authenticated application shell or expected auth redirect
- `/api/config` -> JSON, never editor HTML
- `/health` -> JSON with `status: ok`, never the legacy plain-text `healthy`

Any static editor fallback on account or API routes is a release blocker.

## 7. Real account journey

Using disposable candidate accounts:

- signup
- email confirmation when enabled by the selected Auth configuration
- signin
- recovery
- signout
- upload five images
- create a campaign manually
- edit, save, reload
- PNG export
- ZIP export
- editable backup export
- worker job completion verified from logs/queue
- second workspace cannot access first workspace private data

Inspect produced images and worker logs; HTTP 200 alone is insufficient.

## 8. Production cutover

Only after all previous sections pass:

- Record known-good rollback target.
- Apply approved production migration to the intended AppScreen database.
- Set `APP_BASE_URL` to the exact production HTTPS origin.
- Route production domain to `web:8001`.
- Ensure the legacy static application no longer receives the same domain.
- Re-run anonymous verifier and account/export smoke tests immediately.

## 9. Rollback

Prefer rollback to the last compatible SaaS image after customer data exists. Returning to the standalone editor removes cloud account/workspace access and is not a full SaaS recovery strategy.

Never reverse migrations, delete buckets, or erase customer data as part of an emergency proxy rollback.
