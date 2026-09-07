# SaaS implementation tracking

Active goal: implement the full SaaS conversion, end-to-end design agent, user-selected templates/locks, and Codex/Claude Code MCP access described in BACKEND_AI_AGENT_PLAN.md and the follow-up discussion. This file tracks evidence; unchecked items are not complete.

## First complete live pipeline delivery — September 6, 2026 (local)

- Run `05a7580d-3437-48aa-b1ef-965c18dd3874`, job
  `7e33429a-7474-4bc2-b152-ba635f72598e`, completed actual provider analysis,
  storyboard, deterministic composition/rendering, three visual reviews and two
  bounded repair rounds. All 19 rehearsal checks passed. Output is a separate
  draft; the manual base and customer demo campaigns remain untouched.
- Delivered five opaque RGB 1320 × 2868 PNGs, contact sheet, ordered campaign ZIP
  and editable project ZIP. Both archives verify; the editable backup retains
  all five original synthetic images byte for byte. All four connected device
  borders/placements retain the exact selected Tidal Relay template. Replaying
  admission and the terminal job makes no new model requests or credit charges;
  the synthetic workspace settled its five-credit design charge once.
- **Quality remains review-needed, not publish-ready.** The AI fixed two initial
  caption/device overlaps. Main and independent visual reviewers inspected all
  five outputs and agreed that marketing captions are readable and shared frames
  intact, but Week rows split between panels 3/4 and top banner letters are cut
  on panels 2/5. Bottom captions are safe but generic. Independent rubric 9/12
  misses the >=10 quality threshold. Exact geometry was not silently unlocked.
- This attempt made seven generations plus seven token-count requests. Measured
  token-usage estimate: **$1.358680**. Across all three attempts: **$1.855665**.
  The single shared ledger retains **$4.132789** conservatively within the
  original $5 total, leaving **$0.867211** unreserved. It closed cleanly, with no
  uncertainty. These estimates are not provider invoices. Paid testing stopped.
- Independent read-only audit recomputed all three reports' costs and the ledger
  hash chain, then verified all eight export artifact hashes/sizes, PNG decoding,
  both ZIPs, original source bytes, saved version-1 placement identities and four
  shared-frame handoffs. It found no blocker to delivery **for review**. Credit
  settlement/replay comes from the real harness evidence, not a second independent
  replay against the database.
- Evidence and downloadable artifacts:
  `<local-temp>/appscreen-live-ai-biNWPf/`.
  The unchanged `live-report.json` SHA-256 is
  `573188502a63f140b29ed2e00ee448fd4394eb60b5de3a23d890d9e4c6776e63`.
  `visual-review.md` and `independent-visual-review.md` distinguish pipeline
  success from quality acceptance. A single synthetic campaign does not close
  the real-AI launch gate or represent actual customer/provider acceptance.
- The live run used its retained **Tidal Relay version 1** preparation. During
  evaluation, separate workspace changes advanced the current template catalog
  to version 5 / Tidal Relay version 2 with fixed sequence variants. This turn
  did not edit or revert those template changes. Historical outputs are compared
  to their saved approved base, not regenerated with the newer factory. The
  full 678-test suite was rerun successfully after detecting that change;
  the new catalog has not received this live AI/visual acceptance.
- Latest full suite: **678 tests** plus TypeScript, zero failures/skips/cancels.
  The app remains healthy at `http://127.0.0.1:8001`; customer AI, billing and
  OAuth are off. No production deployment, client connection, credential
  provisioning, unrelated cleanup, commit or push was performed.
- Next scoped improvements: a reviewed overflow-safe template/reflow option for
  critical content, stronger benefit copy within caption safe areas, and stopping
  unchanged repair loops when exact locks make the remaining issues unfixable.
  Actual hosted services, payment lifecycle, client interoperability, commercial
  policies and rights remain separate launch gates.

## Shared synthetic evaluation allowance — September 6, 2026 (local)

- Following the discussion of a total retry allowance, the user's latest
  “continue” is being applied conservatively as **$5 total including the original
  attempt**, not an additional $5 for every new fixture. Customer images,
  production AI, billing, provider provisioning and deployment remain outside
  this approval. The original attempt's report and exclusive receipt are retained.
- The local runner now requires a pinned private aggregate ledger and reserves
  each generation durably before dispatch. It cannot create/reset that ledger.
  Prior reservations, successful calls and uncertain requests all retain their
  holds. Corruption, crashes, partial writes and abandoned runs fail closed;
  clean close removes only this process's ownership lock. This is single-host
  synthetic evaluation accounting, not a production distributed budget service.
- The optional spend-guard reservation hook retains the original request checks
  and disables submission on timeout, rejection or changed client configuration.
  It exposes only numeric accounting fields, not images, prompts or credentials.
- Final-render QA is now merged with earlier critique findings instead of being
  overwritten. Delivery warnings and explicit review-required flags survive
  replay. A completed pipeline still requires independent image review.
- Full `npm test` passes TypeScript, 322 unit checks and 347 server/integration
  checks: **669 total**, zero failures/skips/cancellations. This includes 15
  durable-ledger cases, 108 spend-guard cases, 19 rehearsal guard cases and 32
  engine cases. All database checks use only isolated loopback `appscreen_test`.
- One aggregate ledger was created at
  `<local-temp>/appscreen-live-ai-budget-RqfcR5/`.
  Its pinned manifest hash is
  `85ddde7687e22b8e34500a0e312415f657508eb48b0eb99700795961480fa901`.
  Independent review verified the original report hash and full 454,725 microUSD
  seed, leaving 4,545,275 microUSD before the new attempt. A separate disposable
  fake-client rehearsal verified on-disk reservation before dispatch and cap
  refusal across fresh runs without real provider calls.
- Controlled second attempt `694bf6f4-576f-4901-9098-8f66f1bba9bc` made one
  successful model analysis call, then safely stopped with `INVALID_EVIDENCE`:
  returned evidence IDs did not satisfy the required source namespace. The
  real worker persisted `usage_budget` successfully, confirming the earlier
  JSON checkpoint repair. No AI draft or export was delivered. Ten synthetic
  credits are available, none reserved; customer AI remains off.
- The second attempt's usage estimate is **$0.2473675** and its retained hold
  is **$0.454825**. The ledger closed cleanly, retaining **$0.909550** across
  both attempts and leaving **$4.090450** of the original total allowance.
  Evidence remains under
  `<local-temp>/appscreen-live-ai-ZDX0UW/`.
  `live-report.json` SHA-256:
  `6e7260c382fd3c7e8af67bac563ce82c91c02c3bddd6934f331fc6391d3d80bf`.
  These are usage estimates/conservative reservations, not provider invoices.
- The namespace failure is now repaired without relaxing provenance: fresh
  provider observations contain statements but no model-created evidence IDs.
  Trusted code assigns deterministic IDs after exact source validation. Saved
  checkpoints retain their original schema and checks; private/unusable flags,
  statement text and warnings are preserved. Overlong/reserved source IDs are
  rejected before image reads or paid dispatch. Copy edits now require an exact
  validated evidence-owner map, not ambiguous source-prefix matching.
- Final full suite after this repair: TypeScript plus **678 tests** (331 unit,
  347 server/integration), zero failures/skips/cancellations. Independent review
  also exercised strict SDK schema output, malformed observation rejection,
  legacy checkpoint replay and overlapping source-ID ownership. Only local
  synthetic fixtures and the isolated test database were used by these tests.

## First bounded live AI attempt — September 6, 2026 (local)

- The user replied “continue” to the explicit single synthetic-only $5 evaluation
  request. The prepared run `afcc8e8d-c1fb-4f1d-ac66-a8b0a0d1cb13` was executed
  once after re-fetching unchanged official Standard pricing on September 7 UTC.
  Only the specifically approved AppScreen key setting was read; no provider
  configuration was changed or provisioned and customer AI remains disabled.
- OpenAI returned one completed analysis response: 12,378 input tokens, including
  12,375 cache-write tokens, and 1,898 output tokens. The verified rate-card
  calculation is **$0.2496175**; the conservative retained reservation is
  **$0.454725**. These are model-usage accounting, not a provider invoice. Two
  network requests mean one token count and one generation, not two generations.
- The job failed after saving provider usage but before saving the array-valued
  `usage_budget` checkpoint. PostgreSQL's driver encodes a raw JavaScript array
  as a PostgreSQL array, which the JSONB column rejects. A read-only reproduction
  returns `22P02`; explicit JSON serialization round-trips arrays, empty arrays
  and objects correctly. This failure path was missed by the prior in-memory
  engine tests and needs real worker/database regression coverage.
- No storyboard, AI campaign, output PNG or editable AI backup was delivered.
  The synthetic workspace's ten credits are available again, with zero reserved.
  Original preparation, manual previews, the exclusive receipt and failed
  `live-report.json` remain in
  `<local-temp>/appscreen-live-ai-n1pS9p/`.
  Independent review agrees with the recorded failure and usage calculation.
- This one-use approval was consumed. At that point no paid retry or substitute
  run was allowed without a new decision, despite the unused allowance. The later
  total-budget continuation is recorded above; this original receipt remains used.
  Fixing and testing the local persistence bug does not turn this attempt into a
  successful live end-to-end design evaluation.
- The checkpoint boundary is now repaired: it explicitly serializes JSON and
  casts the parameter to JSONB, rejects undefined input, and retains lease and
  transactional checks. Real PostgreSQL regressions cover the old `22P02`
  failure, silent empty-array corruption, nested objects/scalars, rollback and
  stale-worker denial.
- That offline worker test also exposed a second defect: an exact-template
  campaign rebuilt device/placement IDs while retaining scene IDs, so durable
  revision validation rejected unchanged geometry as `LOCKED`. Matching existing
  exact-mode campaigns now retain canonical IDs, geometry, shared appearances,
  elements and manual settings. Unlocked source assignment, copy and colors can
  still change; the requested locale is retained. The core lock validator was
  not weakened.
- The actual worker and actual engine now complete a fresh five-source exact
  draft and package its artifacts in the real test database using a simulated
  provider and renderer. Stage replay makes no additional provider calls or
  usage writes; a separately simulated interruption resumes saved analysis and
  settles credits once. External fetches are blocked and zero were attempted.
  These are local persistence/integration checks, not a second live model run or
  new visual-output acceptance.
- Final full `npm test` after both fixes passes TypeScript, 284 unit checks and
  346 server/integration checks: **630 tests total**, with zero failures, skipped
  or cancelled tests. Only the isolated loopback `appscreen_test` database was
  used, with dotenv loading disabled and external services off.

## AI safety and real MCP transport — September 6, 2026 (local)

- Final full `npm test` passes TypeScript, 282 unit tests and 339 server/integration
  tests (621 total, zero failures/skips/cancellations). It ran only against the
  isolated loopback `appscreen_test` database with dotenv loading disabled and
  providers off. This includes 18 offline approval/fixture/report safeguards.
- The local SaaS remains healthy at `http://127.0.0.1:8001`; AI, billing, service
  email and native OAuth remain disabled. Existing Desktop captures and both
  Voice Reader demo campaigns were left untouched.
- The engine now checks every image-bearing campaign preview against selected
  sources and the actual rendered locale, including backgrounds and image layers.
  Unselected images stop refinement before provider dispatch; private/unusable
  analysis prevents those pixels being sent again, even through another source
  ID for the same asset. Resumed analysis checkpoints are schema/identity checked.
  The worker reports incomplete consent as `needs-input` and requests credit
  release. Twenty-seven engine tests and the focused worker regression pass;
  independent review found no remaining blocker in these reviewed paths. This is
  not a guarantee that initial model analysis detects all private data.
- A single-run spend guard has 88 passing focused tests, including mocked HTTP
  transport through the actual installed OpenAI SDK and production adapter.
  Exact immutable request counting, conservative input/cache-write/output
  reservations, serialized dispatch, zero automatic retries, permanent stops on
  uncertainty and unknown-cost reporting are covered. It is an isolated
  evaluation guard, not durable production budget enforcement or an invoice.
- The real MCP HTTP rehearsal passes 98 checks using SDK 1.30.0 and protocol
  `2025-11-25`: discovery, scoped direct operations, exact-template protection,
  connected edits, repeat-safe writes, actual PNG/ZIP/backup downloads, source
  fidelity, foreign-tenant denials and revoked-client rejection. Three synthetic
  source images were used in fresh `appscreen_test` workspaces; no customer
  screenshots, model calls or persistent client configuration were involved.
  Evidence: `<local-temp>/appscreen-mcp-client-NjrYA2/report.json`.
  Main-agent visual inspection agreed with the retained `needs-input` warnings
  for intentionally low-resolution sources and an overlapping caption. This
  proves protocol behavior, not polished campaign quality or actual agent-app use.
- Installed Codex CLI 0.153.4 and Claude Code 2.1.263 were inspected through
  version/help output only. No connection was installed; actual client workflows
  remain acceptance work. Native OAuth can remain outside the initial release.
- The fixed five-source AI preparation runner uses only clearly marked synthetic
  FocusBoard images and an independently regenerated manual base. It defaults to
  offline preparation with no credential read. Live execution requires separate
  one-use approval, verified same-UTC-day pricing, immutable fixture checks and
  an exclusive receipt before reading the specifically approved project key.
  Rejected attempts cannot replace the first attempt's report. At this milestone
  no real provider call had occurred; the subsequent authorized attempt and its
  failure are recorded above.
- Offline preparation completed at `2026-09-07T01:19:18Z` (UTC), run
  `afcc8e8d-c1fb-4f1d-ac66-a8b0a0d1cb13`, in
  `<local-temp>/appscreen-live-ai-n1pS9p/`.
  All five synthetic 1179 × 2556 sources and 1320 × 2868 opaque outputs decoded;
  the manual base passes deterministic QA with four connected handoffs. Main-agent
  inspection of all five originals, the campaign contact sheet and full-size
  third output found clear fixture labels, readable captions and intact connected
  borders. Provider requests, credential reads and external fetches were zero.
  The preview is manually composed from fixed test code, not AI-generated work.
- The AppScreen workflow informed original-image, border/seam and editable-export
  verification; official OpenAI documentation informed image handling and the
  spending rehearsal. [Six launch gates](deploy/LAUNCH_GATES.md) distinguish local
  evidence from still-required provider, hosting, business-policy and rights
  decisions. Docker's Linux disk remains full; no unrelated files were deleted,
  providers provisioned, retention policy invented or production activated.

## Real screenshot local demo — September 6, 2026

- Latest full `npm test` run after portable import and imported-editor hardening: typecheck passes, 185 unit checks and 320 server/integration checks pass (505 total, zero failures/skips/cancellations). Tests used only the isolated `appscreen_test` database with dotenv loading disabled and live providers off.
- Five user-selected Desktop captures now upload successfully through the real browser UI into the separate `Voice Reader · Five-screen demo` campaign (`e4646281-3a15-44e4-accf-be58a99cc8d9`). The existing `test` campaign and source files were preserved. AI, billing, and service email remain disabled.
- Real UI testing found two exact-template save defects: editor metadata cleanup discarded a legitimate terminal singleton's overflow flag, and PostgreSQL JSONB object-key ordering made unchanged nested borders/shadows appear changed. Canonical-singleton preservation and semantic object equality now fix headline-only saves without relaxing actual geometry/overflow locks. Regression coverage includes actual 3-/5-screen browser bridge roundtrips with stored-key ordering and denial of genuine constrained edits.
- The five-screen Tidal Relay exact-mode campaign was edited, saved, and applied through the UI. Applied revision: `efd263fc-5876-4fe9-b0e9-c12e1eda246e`. Footer captions were shortened to keep borders unobstructed. Both main-agent and independent visual review found no accidental headline/device overlap or headline clipping.
- PNG export job `66d52a71-43a8-443d-bd86-dae723802c07` completed ready without layout warnings. All five PNGs independently decoded as opaque RGB 1320 × 2868; archive CRCs, order, and extracted bytes were verified. The new secondary `Prepare editable backup` action uses the existing no-AI project-export path, explicit working/retry feedback, and a distinct repeat-safe request identity. Live backup job `b0c7915b-5e95-431a-9aba-dcff2536fe5b` completed ready; the valid campaign document retains all four shared border connections, and its five embedded originals match the Desktop files byte for byte.
- Deliverables and a handoff README are in `<local-desktop>/AppScreen-demo-pOGJ8p/`. This is a manually prepared local demo, not real hosted-AI generation or production readiness. The AI Studio and file-import captures still show empty input forms; replace them with populated captures and review third-party imagery rights before publishing.
- The two legacy-editor handoff issues found in the initial demo are now fixed. Cloud-imported rows show decoded source dimensions instead of `undefined`, preserve known legacy device labels, and keep dimension units together while connection badges wrap. The cloud editor's existing backup icon now saves the current snapshot and requests the real portable project export; standalone IndexedDB backup behavior is unchanged. Button busy/retry labels and live status explain progress, conflicts and immutable snapshot retries without claiming a merely requested job is ready. Backup-progress navigation preserves local sign-in and blocks departure with unsaved changes, including before the editor's dirty debounce.
- Eighteen focused label/backup regressions and independent code review cover immediate edits, duplicate clicks, failed/conflicting saves, immutable retries after later edits, and project detachment. A late failed cloud save can no longer dirty a different local project or expose stale recovery controls. Save failures retain their specific recovery guidance.
- Real-browser re-open → editor backup → campaign download succeeded. Latest unchanged applied revision: `1cc277a2-9712-433a-be0d-689ad9b5a02e`; backup job `f6f12f6d-43ad-49ea-8af3-5004f6e7e4fb` is ready. `<local-desktop>/AppScreen-demo-pOGJ8p/editor-backup-verified.zip` passes ZIP CRC and campaign-schema checks, contains all five Desktop originals byte for byte, and matches the original approved design completely apart from revision metadata, including all four device/border connections. Main-agent visual inspection verified the updated labels and editor feedback. The frontend-design and AppScreen skills kept these fixes within the existing visual system and original-image backup workflow. AI remains off and the demo still has 100 credits; no real-provider or production verification is claimed.

### Editable backup import-as-copy

- The campaign dashboard now accepts the app's editable-project ZIP through `POST /api/projects/import`. The cloud editor's import icon leads to this flow and guards unsaved changes; standalone legacy JSON import remains unchanged. Confirmation states explicitly that this creates a new private campaign, never replaces an existing one, and uses no AI or credits.
- Archive admission checks bounded compressed/expanded sizes, safe exact paths, duplicates, ZIP structure and CRCs, campaign compatibility, all referenced assets and fully decoded PNG/JPEG pixels before creating a campaign. Campaign/revision/asset identities are regenerated; source/scene/device identities, geometry, appearance and locks are preserved. Runtime images, external resource references and unsupported local-only rendering features are rejected. Imported text remains inert in legacy editor markup; cloud restores do not auto-fetch arbitrary imported fonts/icons.
- Imports bind the selected account/workspace and immutable file/name to a retry receipt. Atomic quota admission, a two-import process capacity gate, membership rechecks, scoped asset cleanup and ambiguous-commit recovery are covered by real-database tests. Only an opaque hashed retry key and random request ID are stored in tab session storage—no image, filename, account ID or token. Those opaque receipts survive sign-out in the same tab so an uncertain request can be recovered after returning to the original account; in-memory file/name selections clear on account change.
- Eighty focused backend cases pass. Independent review found no remaining blocking issue in the reviewed import scope. Seventeen frontend controller tests and separate isolated desktop/mobile browser QA cover disabled busy controls, Escape/focus, retry/reload, safe names, success without automatic navigation and visible 44px mobile actions. The main agent inspected the mobile error/Retry view. Evidence: `<local-temp>/appscreen-backup-import-ui-axoqlT/`.
- Real browser sign-in → select `editor-backup-verified.zip` → import → reopen editor → PNG export → editable re-export succeeded in a separate demo tab. New campaign: `Voice Reader · Restored backup demo` (`286ab62f-1c8e-4c3d-b2e0-a1307c160dd8`); applied imported revision: `71031d07-37f8-4ab0-8cd2-9a1639adc346`. Original campaigns and Desktop captures were not changed. All five original images match the original backup and Desktop files byte for byte; the complete design matches after remapping asset IDs and excluding campaign/revision identity and the requested new name. All five exported opaque RGB 1320 × 2868 PNGs are byte-identical to the original approved PNGs, including the four connected borders. ZIP CRCs and full pixel decoding pass.
- Restored-copy artifacts are retained separately in `<local-desktop>/AppScreen-demo-pOGJ8p/restored-copy/`. PNG job `2e7c1e62-4f55-4078-8d74-32d2306f22ae` and editable-backup job `299a47c4-783c-4aad-867a-d158456910bb` are ready. No AI consent was selected; the demo still has 100 AI credits. This is a portable campaign recovery check, not a whole-account disaster restore, live-provider test or production launch. The AppScreen skill required checking restored originals and output fidelity; frontend-design guidance kept the confirmation and actionable retry feedback within the existing visual system.

## Verified locally — September 5, 2026

- Latest full `npm test` run with the dedicated test database: TypeScript passes, 130 core/agent/MCP/frontend unit checks pass, and 240 server/integration checks pass with no skips (370 total). Separate opt-in rehearsals cover operations UI, ten-screen capacity and recovery as recorded below. Earlier headless local-browser QA additionally passes 58 behavior checks plus 31 post-polish desktop/mobile layout checks and 18 final recovery-copy checks. Counts describe local fixtures, not production verification.
- Running SaaS/API and durable worker at `http://127.0.0.1:8001`, with isolated task PostgreSQL on loopback port 55432. Existing editor server on 8000 is preserved. Development sign-in is explicitly local-only; hosted AI, Stripe and service-email sending are disabled.
- Core, provider-adapter, MCP and frontend unit checks pass, including actual headless Canvas output, template continuity/locks, recovery, MFA, reconnect and download behavior. Model responses and Supabase MFA are simulated in these tests; this is not a live AI or identity-provider verification.
- Database-backed API/MCP integration checks use the separate `appscreen_test` database. Coverage includes tenant isolation, private media, scoped/revoked tokens, checksum/decoded-image verification, repeat-safe writes, concurrent-save conflicts, exact-template geometry/property locks, and denial of private server files.
- Browser QA completed sign-in → project creation → screenshot upload → Tidal template draft → individual device edit → cloud save → reload → apply draft → five-screen export. All five exported store PNGs were independently decoded as 1320 × 2868 with no alpha; the ZIP contains the five ordered PNGs and a manifest. The test fixture correctly received a review-needed warning for missing headlines/low-resolution source material.
- The MCP adapter exposes direct design tools separately from hosted paid-AI jobs. Scoped-token creation/revocation and Codex/Claude connection guides exist; actual client installation is not performed. Native Supabase OAuth consent, audience/scope checks, versioned grants and explicit per-client reconnect are implemented; 21 local OAuth/security checks pass. OAuth remains disabled pending real provider and client verification, including the underlying Auth account-mutation boundary.
- Restricted operations UI/API is implemented: server-configured user-ID allowlist, verified MFA requirement, metadata-only job views, and atomic/audited credit corrections with explicit confirmation and repeat-safe receipts. Generated-JWKS and real-database tests verify denial, revocation/demotion, privacy, reserved-credit protection and cross-tenant idempotency. No live staff MFA setup is claimed.
- Billing hardening includes durable checkout intents, subscription reconciliation, atomic invoice/period credit grants, retryable webhook failures and deduplicated review records. Twenty deep real-database cases use simulated Stripe, including notification rollback/retry and stale payment-failure suppression; no real Stripe lifecycle has been exercised.
- Account export now streams a ZIP containing every workspace project/revision, original image bytes, safe account/credit metadata and bounded derived image artifacts. Checksums, snapshot consistency, concurrent export limits, disconnects/timeouts, failure auditing and the actual HTTP route are tested. Omissions are listed in the manifest; no automated account restore is claimed.
- Recovery UX handles failed/expired callbacks, provider-confirmed password updates and verified staff TOTP step-up. A synthetic live account ZIP download succeeded. The `/recover` direct-load/refresh route is fixed. Actual recovery email delivery remains unverified.
- Headless Chromium verified the actual local UI at 1440px and 390px without touching the locked desktop: sign-in loading states, focus/cancellation, read-only connection defaults, masked token/revocation, failed-export retry, validated ZIP download and protected routes. Account card spacing and a wrapped download label were corrected. Synthetic QA accounts/projects were retained; temporary agent tokens were revoked. Browser screenshots and a report are under `<local-temp>/appscreen-ui-smoke-AAXO5m/` (layout) and `appscreen-ui-smoke-3L9jbJ/` (full behavior).
- The completed operations UI rehearsal passes 130/130 desktop/mobile checks with no JavaScript errors or external requests. It covers actual customer/staff conversations, audited private access, reply/status confirmation, internal-note privacy, inbox read failure/retry and report layouts. Twenty screenshots and the report are retained in `<local-temp>/appscreen-operations-ui-mtcVRL/`; the only error response is the intentionally injected read-state failure.
- Deletion requests now have durable status, explicit confirmation, idempotent retries and a KEEP DATA cancellation path. Legacy duplicates and stale cancellation retries cannot silently affect a later request. This is request management only: no erasure, retention policy, Auth-account removal or subscription cancellation is implemented by this flow.
- Support now has workspace-visible conversation history, customer follow-ups, version-conflict protection and repeat-safe staff replies/status changes. An operator queue contains metadata only; private detail requires an explicit audited reason. Escalation notes and staff IDs are excluded from customer views. Fourteen deep database cases cover authorization, visibility, transitions and atomic reply/audit/notification behavior. Staffing and external escalation delivery still require setup.
- Durable in-app notifications cover job readiness/failure/review, public support replies and reconciled payment failures. Admission commits with the source event; duplicates, stale attempts, revocation and read-state races are tested. Fifteen notification tests include real HTTP boundaries and the export-with-review-warning regression. This is in-app delivery, not email or external alert delivery.
- Service email now has an opt-in/versioned inbox preference, transactional outbox, verified-current Supabase recipient lookup, immutable Resend retry payload/key, crash leases, bounded retry window, signed event deduplication and bounce/complaint suppression. Independent review found and fixed the simultaneous send-response/webhook race and permanent-rejection-after-ambiguous-send classification; real-database regressions cover both. A metadata-only audited operator endpoint and on-demand queue monitor expose delivery attention states. The adapter, identity and webhook tests are simulated: no email was sent, no provider/domain was provisioned, and sending remains disabled.
- Email preferences desktop/mobile browser QA passed unavailable opt-in/saved opt-out, loading failure/retry, explicit save, uncertain retry, stale-version reload, visible focus and 44px controls without real accounts or external requests. Screenshots are retained in `<local-temp>/appscreen-email-ui-EtHFgK/`; the frontend-design skill preserved the existing AppScreen visual system. The main agent also inspected the mobile layout.
- Staff email incident review now has separate delivery evidence and investigation/closed-without-resend decisions, a server-only versioned review table, metadata-only paginated API and atomic private audit/receipt writes. New delivery evidence invalidates old decisions; exact retries report their original receipt without reapplying it. Thirteen database cases use locally signed synthetic AAL2 identities and cover denied customer/MCP access, concurrent/stale edits, a waiting review racing an evidence update, signed late delivery, private projections and rollback. They do not verify hosted MFA or real email delivery. Account ZIP regression excludes staff review records/reasons. Sending, delivery evidence and suppressions are not mutated by reviews. Actual provider investigation, retention and external alerting remain open.
- `/app/operator/email` browser QA passes desktop/mobile layouts, explicit confirmation, 44px controls, modal focus/close restoration, frozen uncertain retry across navigation/reload even when the incident leaves the filter, stale decision blocking, queue failures, staff revocation and sign-out cleanup. Twelve new UI unit groups are included in the full suite. The separate `node saas/tests/email-operations.browser-qa.mjs` runner uses an ephemeral file server and intercepts all APIs; four synthetic POSTs, zero unmocked requests and zero page errors. Evidence is retained in `<local-temp>/appscreen-email-review-ui-QEvHU3/`. The frontend-design skill preserved existing tokens and separated delivery evidence from staff decisions; main-agent visual inspection includes the viewport-sized mobile confirmation. Independent backend/migration review found no actionable issues. No provider/account delivery was exercised.
- Server-confirmed first-use milestones and an audited operator report are implemented without screenshot/prompt/name/email payloads. Reports separate production/nonproduction cohorts, explain missing historical capture and unmetered token counts, and derive operational alerts from unresolved state. Eight deep metrics cases plus two independent billing-metric review cases verify transaction rollback, event deduplication, cohort boundaries and positive paid-invoice amounts. Zero-dollar invoices do not inflate paid conversions; entitlements remain unchanged. Currency cost has not been measured.
- Workspace ZIPs additionally include customer-visible support cases/replies, only the requesting user's notification metadata and content-free milestones. A same-snapshot test excludes staff internal notes/identities, other members' inboxes, foreign workspaces and later writes.
- Workspace ZIPs now also include only the requesting user's current-workspace email preference and basic delivery metadata. New snapshot/field-list tests exclude other recipients, provider IDs, payloads, recipient digests, raw events, suppressions and later changes. Exact metadata-file overhead is checked. A parallel HTTP backup test now retries only the expected temporary capacity response from the separate capacity fixture; the production two-export limit is unchanged.
- Real browser QA found static JavaScript downloads were consuming the API rate limit and could strand the loading screen. The shared public-resource allowlist now exempts only static/SPA GET/HEAD requests; API/MCP and tighter mutation limits remain enforced by a dedicated regression test. Intended production proxy/distributed rate-limit behavior remains a deployment verification requirement.
- Parallel integration testing exposed repeated-migration DDL deadlocks during account creation. An applied SHA-256 migration ledger now prevents replay; production web/worker startup only verifies schema history. Concurrent migration/account-admission and read-only startup checks pass. First adoption of an untracked database requires a controlled maintenance window.
- Public template preview URLs now return composition diagrams built from template geometry, clearly labeled as placeholder previews. Existing local projects and concurrent local-editor additions were preserved.
- Template compatibility is now shared by catalog list/detail, manual creation/application, fresh job admission, retries, the agent and renderer. The live local catalog reports 17 cloud-compatible templates and one local-only template; 3D devices and layered lifestyle photos have separate explanations. Unsupported explicit choices and immutable local-only designs are rejected before new credit reservations/queue admission. API/MCP regressions prove no job, usage or ledger write on rejection; this is not actual Codex/Claude client verification.
- Historical paths were independently reviewed and fixed: old auto request hashes still replay without accepting changed substantive input, retry checks inspect stored composition/repair documents before re-reserving credits, worker base-draft creation ignores retained auto IDs, and resumed composition checkpoints are validated before another provider call. Two historical worker fixtures construct a supported base and intentionally cancel before model dispatch; they do not fabricate a completed AI design. Unknown saved template IDs remain valid preference data, so switching to automatic selection does not break brief autosave.
- Template selection now retains unsupported/unknown saved choices visibly, explains recovery in the existing visual system, focuses actionable errors before either start, and preserves selected-card keyboard focus/scroll. Both automatic start paths ignore retained IDs. Six focused frontend tests and isolated desktop/mobile browser QA cover missing metadata, disabled-control bypass, 44px starts and no horizontal overflow. The main agent inspected the mobile blocked-start image. Evidence: `<local-temp>/appscreen-template-ui-LURgKh/`. The frontend-design skill kept the existing AppScreen styling; no real account/provider writes were made in browser QA.
- The opt-in local restore rehearsal now passes all ten grouped checks: a fresh PostgreSQL source/target pair, 39 table fingerprints, 15 private objects (3,453,417 bytes), effective grants/schema/sequence state, dormant jobs/checkpoints/credits, real HTTP workspace/token denials and stale-save conflicts. Three localized/decorated overflow PNGs and their ordered ZIP are byte-identical after restore; the original layout warning remains explicit. The saved dump, manifest and object copy are read back for recovery. Report: `<local-temp>/appscreen-restore-drill-FdN2Q8/report.json`. Both temporary connection copies were revoked; synthetic databases/files remain. This is not managed Supabase/Auth, off-site encrypted or lost-host recovery.
- The opt-in ten-screen capacity rehearsal passes 183/183 assertions across four real worker exports with exact Tidal Relay geometry. It verifies all nine device/frame handoffs, full opaque 1320×2868 pixel decoding, source markers, ZIP CRCs/manifests, portable source bytes and cold/warm determinism. Copy-only refinement resolves the baseline's six warnings; an intermediate automated-QA false-negative is retained in visual evidence. Final local ZIP job: 3.648 seconds, ZIP 6,077,380 bytes. Sampled Node+Chromium RSS peak: 1,296,121,856 bytes, not a production/container memory requirement. Report and agent visual review: `<local-temp>/appscreen-ten-screen-rmXDoN/`. No paid AI, external fetch, queue consumer or customer data was used.
- Main headline/subheadline QA now checks actual rendered ink/decorations against the rounded, rotated, sheared device body and visible border. Eight new headless browser tests reproduce the Tidal caption false-negative, reject empty-corner/space/shadow false positives, cover crop/opacity/localization/clipping, preserve document/pixels, and bound scratch canvases to two reusable 256px tiles. Warnings do not move devices or prevent exporting intentional overlaps. This is not complete visual judgment or QA for every decorative text element; scope and tolerances are documented in `deploy/LAYOUT_QA.md`.
- The ten-screen rehearsal was repeated after the QA change: 183/183 checks, six baseline warnings and zero refined warnings, with all 20 exported scene PNGs and both contact sheets byte-identical to the earlier evidence. The main agent inspected the refined overview. Final local ZIP job: 3.595 seconds; sampled Node+Chromium RSS peak: 1,292,976,128 bytes (not a container memory requirement). Current report: `<local-temp>/appscreen-ten-screen-K0YS7g/report.json`. Historical reports remain unchanged; this run used only synthetic data and no external providers.
- Importing configuration no longer implicitly reads `.env`; explicit environment loading remains in web/worker/migration entrypoints. A subprocess fixture verifies the isolation boundary. Recovery guards reject remote/non-test connections, connection-option overrides, existing/custom target names and missing synthetic-only confirmation.
- A dated, hash-identified commercial asset inventory exists in `deploy/ASSET_LICENSE_REVIEW.md`. It found a missing authoritative application license notice, unclear artwork provenance and a Samsung model license conflict requiring historical permission evidence. Hosted packaging serves the device models even though the worker refuses 3D; they cannot be described as excluded from distribution. Commercial clearance and full Linux binary/dependency review remain open.
- The public `/third-party-notices` page now reproduces the supplied Supabase MIT and bundled Inter OFL texts with escaped rendering and explicit partial-coverage language. Exact allowlisted plain-text routes and a license link on the browser bundle are verified against the installed files; adjacent package/private files remain inaccessible. This addresses those two notice-delivery paths, not the unresolved application/model/artwork permissions.
- Public notices desktop/mobile browser QA verifies exact displayed text including whitespace, a failed-source/retry flow, preserved unaffected text, keyboard footer focus and wrapped 44px source links. No sign-in, writes, external requests or browser errors occurred. Four screenshots and the report are in `<local-temp>/appscreen-notices-ui-RCc6uu/`; the frontend-design skill kept this supporting page within the existing visual system.

This is a working local integration milestone, **not a production-ready SaaS or a completed goal**. Remaining gates include live-provider quality/cost evaluation, actual OAuth/client and billing sandbox verification, privacy/retention and deletion fulfillment, actual recovery/billing/service email and external alert delivery, support staffing/escalation coverage, backup/restore drills, Linux deployment verification, production credentials and business policy approval. In-app support, metrics and notifications exist but do not establish these external delivery/operational gates. New local-only 3D/layered-photo features are explicitly unsupported by the cloud renderer until qualified.

## Remaining execution priorities

1. Complete real-provider five-source design → render → visual inspect/repair → editable result → export verification, with approved bounded cost. Customer AI remains disabled; approval for one synthetic live-provider test was requested, not assumed.
2. Finish privacy-approved deletion fulfillment and retention, approved real service/recovery/billing email verification, provider-side email investigation/reconciliation and retention tooling, external alert delivery, support staffing and escalation ownership. Staff review recording is implemented; closing a review is not a delivery fix. The proposed seven-day deletion cancellation window was asked about, not approved or enabled. A saved request is not completed deletion; an in-app reply or provider acceptance is not delivered email. Resend is a proposed adapter, not an approved/provisioned provider account.
3. Verify actual Supabase sign-in/MFA/recovery/storage and OAuth native-account boundaries, plus Codex and Claude PKCE/refresh/reconnect/revocation.
4. Configure the selected Stripe test account/product and verify real checkout, renewal, cancellation, payment failure and event ordering. Finalize commercial terms and allowances from measured costs.
5. Build/test the Linux image, extend the successful local synthetic restore to managed database/Auth/private Storage and independent off-site recovery, repeat ten-screen measurements in the actual container, verify production proxy/distributed abuse limits, then obtain explicit authorization for controlled production activation. The last Docker disk check found the VM overlay 100% full while the host-backed data volume had space. No unrelated Docker data was removed.
6. Resolve application/model/artwork license provenance and complete binary/dependency notices before commercial distribution. A partial notice page or README attribution is not blanket commercial clearance.

## Required delivery

- [ ] Versioned campaign document, source/scene separation, legacy import without loss.
- [ ] Canonical connected devices and separate transitive appearance groups; preserve manual per-device controls.
- [ ] All qualified 2D templates available with automatic/exact/inspiration selection and editable property locks; local-only 3D/layered-photo templates remain explicitly unavailable to cloud jobs, as deferred by the initial scope.
- [ ] Shared deterministic renderer, thumbnail/full-size QA, correct opaque PNGs/ZIP/portable backup.
- [ ] Private workspace accounts, onboarding, projects dashboard, cloud revisions, offline cache/conflict handling.
- [ ] Authenticated validated uploads and workspace-scoped assets/downloads.
- [ ] Durable database jobs/checkpoints/events/cancellation/retry and restart recovery.
- [ ] Subscription checkout/portal, verified idempotent billing callbacks, entitlements and atomic credit accounting.
- [ ] Complete real-provider analysis/storyboard/layout/render/inspect/repair pipeline; no fake-success fallback.
- [ ] Natural-language refinements, scope and lock protection, revision compare/apply/undo.
- [ ] Remote MCP shared tools, scoped authentication, direct editing versus explicitly billed hosted-agent jobs.
- [ ] Customer account recovery, billing feedback, data export/deletion and support reporting.
- [ ] Operator audit/reconciliation, quotas, privacy/retention, backups and restore verification.
- [ ] Commercial asset/license provenance, required notices/attribution and business policy review.
- [ ] Owned deployment artifacts, production configuration validation, smoke/integration/security tests.
- [ ] Full customer journey and legacy visual regression checks.
- [ ] Real cloud/provider end-to-end verification and explicitly authorized production activation.

## Current ownership

- Root: backend, PostgreSQL migrations, Supabase auth/storage, billing/credits, job worker, integration, deployment/test audit.
- Core agent: campaign schema, template operations, renderer, legacy editor bridge.
- Frontend agent: SaaS customer experience and actionable control states.
- Agent/MCP agent: provider orchestration and external-agent tool interface.

## External setup (not assumed)

Production Supabase, Stripe prices/account/webhook secret, public OAuth registration, hosting account/domain, finalized commercial policies/pricing, and deployment authorization must be verified before launch. Local development and mocked/provider integration tests do not prove production readiness. Existing local provider credentials must never be printed or shipped to browsers.
