# Customer workspace

The hosted customer shell uses the existing vanilla JavaScript stack. It does not replace the Canvas editor.

- `index.html`, `app.js`, `styles.css`: public pages, account flows, campaign dashboard, uploads/brief/template modes/locks, jobs, revisions, exports, usage/billing, support and account requests, scoped MCP tokens.
- `session.js`: Supabase browser authentication (the backend serves the installed SDK locally) and explicitly configured localhost development sessions. Server API keys are never requested or stored here.
- `auth.mjs`: recovery callback checks, provider-verified password access, request acceptance/error messages, and confirmed password-update handling. Callback codes/tokens are removed from the URL; a non-secret failure marker prevents a failed link from using an unrelated old session after refresh.
- `api.js`: bearer-authenticated requests, timeouts, structured error handling.
- `editor-cloud.js`, `editor-cloud.css`: cloud revision load/save through `AppScreenCloudBridge`; guarded autosaves, draft apply, local-project detachment, and an explicit copy-to-cloud action. The standalone editor remains usable without the backend.
- `utils.mjs`: display normalization, safe URL/text handling, and client-side upload admission. The backend must independently validate and authorize everything.
- `brief.mjs`: brief and design-preference hydration/serialization, preserving explicitly cleared values.
- `oauth.mjs`: escaped client-consent markup and HTTPS/loopback-only redirect admission.
- `download.mjs`: safe ZIP download naming and complete-archive checks before offering a browser save.
- `mfa.mjs`: staff-only TOTP enrollment and challenge/verification; QR/setup keys stay in the current page’s memory/DOM, never app storage or logs. Verified AAL2 is followed by a server session refresh before operations is unlocked.
- `lifecycle.mjs`: current deletion-request status, explicit request/cancel confirmation, and session-scoped idempotency keys. Active requests take precedence over earlier replayed receipts in the UI.
- `operator.mjs`: restricted operational metadata views and a reviewed, explicitly confirmed credit-adjustment flow. Rendering allowlists exclude customer screenshots, prompts, results, and support messages.
- `engagement.mjs`: in-app inbox, customer support history/conversation, metadata-only staff queue, audited private-detail gate, reply/status review, and tab-memory-only retry intents. Untrusted text is escaped; staff notes and identities are excluded from customer projections.
- `report.mjs`: bounded reporting windows, content-free milestone/activity summaries, and allowlisted operational-alert links. Missing token aggregates are unavailable, not zero or a monetary estimate.
- `notices.mjs`: partial third-party notice coverage for the installed Supabase JavaScript client and bundled Inter font. Full source texts are fetched from approved public paths, escaped without rewriting, and shown with individual failure/retry states.

## Routes

Public: `/`, `/pricing`, `/help`, `/privacy`, `/terms`, `/third-party-notices`, `/login`, `/signup`, `/recover`, `/auth/callback`, `/reset-password`.

Authenticated: `/app`, `/app/projects/:id`, `/app/billing`, `/app/settings`, `/app/connections`, `/app/inbox`, `/app/support`, `/app/support/:id`.

Operator-only: `/app/operator`, `/app/operator/jobs/:id`. Navigation requires server-returned `session.operator === true` or the restricted `operatorMfaRequired` staff step-up marker. The marker shows only an authenticator verification page, never operations data. APIs independently enforce the operator allowlist and AAL2 requirements. Credit adjustments first show the workspace, signed amount and reason, require typed `ADJUST CREDITS`, and display the server receipt rather than an inferred balance. An uncertain retry reuses the same idempotency key.

Additional operator pages: `/app/operator/support`, `/app/operator/support/:id`, `/app/operator/report?days=7|30|90`. The support queue contains metadata only. Entering a reason and explicitly opening a case invokes the audited private-detail endpoint. A staff reply or status change requires a separate reviewed confirmation. Successful writes and navigation discard the opened detail; reopening requires another recorded reason. Historical-case recovery and escalation require an internal note, which is never included in the customer view.

Agent approval: `/oauth/consent?authorization_id=ID` requires Supabase sign-in and `config.mcp.oauthEnabled`. Sign-in preserves the requested approval path. Other installations show an unavailable state without an approval action.

Canvas editor: `/editor?project=ID&revision=ID`; `/editor` without a project stays a local editor and offers an explicit cloud copy when signed in.

## Important behavior

- A generated or manually created draft does not replace the current revision automatically.
- The editor saves immutable revisions. Applied-version autosaves use `expectedRevisionId`; draft saves remain drafts until explicitly applied. Conflicts stop cloud saving instead of overwriting other work.
- Switching to a local project detaches cloud syncing. Existing local projects are not deleted during migration. Hosted editor sessions hide legacy browser-provider-key AI controls and link to the campaign’s server-backed agent; local sessions retain their existing controls.
- Briefs, template choices, locks, and selected sources autosave with visible syncing/saved feedback. Optimistic `expectedUpdatedAt` conflicts pause syncing and retain unsaved fields in the tab until the customer explicitly reloads. Starting generation flushes pending brief changes.
- File uploads use the actual multipart API, then display server-returned assets. PNG/JPEG decoding checks are duplicated server-side.
- Long-running jobs are polled from the backend. Polling never performs the job in the browser or fabricates progress percentages.
- Missing AI, billing, authentication, template previews, or support configuration is shown explicitly. Prices come from the backend. The frontend never invents ratings, customers, prices, or completed jobs.
- MCP access supports expiring, scoped bearer tokens with one-time display. Configured Supabase OAuth installations also expose explicit client approval/denial with identity permissions, workspace scopes, and paid AI off by default. Unconfigured installations do not advertise available OAuth setup. Revocation confirms local denial and flags upstream retry when needed.
- An OAuth reconnect requires choosing exactly one existing connection and confirming its reset. Versioned retries do not reset other connections, expand scopes, or extend expiry; the user restarts authorization from the agent after confirmation.
- Account export downloads a complete binary ZIP of the current workspace, including archived projects, revisions, original images and image artifacts. A valid end-of-directory record is required before browser-save feedback. It is not an automatic restore package.
- Campaigns → **Import editable backup** accepts the app's editable-project ZIP as a new private campaign; existing campaigns are never replaced. The hosted editor's import icon opens the same flow after checking unsaved changes. PNG download ZIPs, whole-workspace archives and legacy JSON are not accepted by this cloud path. The local editor retains its legacy JSON importer.
- Import validates the archive and original images, applies quotas and creates fresh campaign/revision/asset identities while preserving the design and connected devices. It uses no AI. Limits: 100 MiB compressed, 200 MiB expanded, 2 MiB campaign JSON, 101 ZIP entries, plus normal per-image byte/pixel limits. Two imports can run per server process; excess requests receive retryable busy feedback.
- An uncertain import keeps the file, name and request fixed for retry. After closing/reloading, reselect the same file/name in the same tab and original account. Session storage contains only opaque hashed scope/file/name keys and random request IDs; those receipts survive sign-out to prevent duplicate uncertain imports. Files and names stay in memory and clear on account changes. Clearing session storage removes that recovery protection; inspect existing campaigns before starting another import after a lost receipt.
- Deletion remains request-only: typed `DELETE` records an intent; typed `KEEP DATA` cancels currently pending requests, including old duplicates. Earlier cancel replays cannot cancel newer requests. No automatic erasure, retention fulfillment, or billing cancellation is claimed.
- The inbox is a dated event history, not email or a live incident list. Open its linked destination for the current state. Mark-as-read is idempotent and never claims to resolve a payment issue, failed job, or support case. The optional sidebar unread-count request cannot block loading the main page.
- Support writes use server versions and stable keys for unchanged retries. Conflict errors retain the text for review; no automatic overwrite or resend with a new version occurs. Reply intents and private text stay in tab memory, not browser storage, and clear on sign-out or account/workspace changes.
- Staff reports clearly label nonproduction activity, the first captured milestone, and lack of historical backfill. Same-cohort milestone counts are not presented as a sequential funnel. Alert conditions are live snapshots on refresh, not external notifications.
- Third-party notices reproduce `/third-party/supabase-license.txt` (the installed package’s MIT notice) and `/render/fonts/LICENSE.txt` (the bundled Inter OFL notice). This is explicitly partial coverage, not a completed commercial-rights audit or a statement of the application’s own copyright holder/license.
- Privacy and terms are clearly labeled pre-launch drafts requiring the operator’s legal review. They are not approved commercial policies.

## Checks

Run `node --test saas/tests/*.test.mjs` for utility admission/security/display tests. These are not proof of live authentication, billing, rendering, or AI quality.

Run `node saas/tests/backup-import.browser-qa.mjs` for isolated synthetic desktop/mobile import confirmation, focus, pending/retry/reload and account-change checks. It mocks all API traffic and refuses external requests; it does not use the user browser or real campaigns.

Run `node saas/tests/notices-ui-smoke.mjs` for a read-only public-page check on the localhost backend. It verifies the complete displayed Supabase/Inter license texts against their source files, injected-load-failure recovery, desktop/mobile wrapping, source-link targets, and keyboard footer focus. It does not sign in, create records, or allow external requests.

Run `node saas/tests/real-api-smoke.mjs` explicitly against the real localhost backend to check development sign-in, brief/template/lock persistence, optimistic conflict, SVG template previews, usage, and scoped-token creation/revocation. This creates a clearly named synthetic QA workspace and does not run AI, billing, or deletion requests. It refuses non-loopback servers and non-development authentication.

`node saas/tests/preview-server.mjs` serves a **visual-only** public-page harness at `http://127.0.0.1:8021`. It has no account, project, payment, AI, or persistence APIs. It must not be used as an alternative implementation of the real backend.

`tests/source-fixture.svg` is an explicitly labeled synthetic QA screenshot source. It contains no customer data and is not a marketed example of a real app.

Use the real backend for integration checks: isolated development sign-in, create project, upload fixture, choose template and modes, manual draft, editor load, save/reload, apply/conflict, export, and connection revocation. Production Supabase confirmation/recovery, Stripe checkout/renewal/cancellation, and paid AI runs require configured services and their own verification.

Observed local checks (September 2026): public desktop/mobile layouts, real development sign-in, upload, manual connected template draft, individual-device edit, cloud save/reload, explicit apply, and export previews succeeded. Real synthetic workspace ZIP streaming/filename/completeness and ordinary-customer operator denial passed. Deletion request/replay/cancel preserved project data and newer active requests; synthetic pending requests were cancelled after testing. The deterministic tests cover auth SDK initialization failures, password update outcomes, MFA, reconnect selection, and lifecycle replay display. Real Supabase email delivery/recovery, OAuth handshake, and staff MFA verification still require configured-service testing. New UI states require final interactive visual checks when the Mac is unlocked.

Authentication behavior follows the installed Supabase SDK and its official [password flow](https://supabase.com/docs/guides/auth/passwords), [reset request](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail), and [TOTP MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp) documentation. Production redirect allowlists, email delivery, provider password policies, and operator enrollment must be verified on the deployed service.
