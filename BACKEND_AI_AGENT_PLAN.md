# AppScreen: SaaS conversion and AI campaign plan

Historical planning baseline, prepared September 4, 2026 from the local codebase and running editor. Implementation has since progressed; use [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for dated test evidence and [the launch gates](deploy/LAUNCH_GATES.md) for remaining acceptance decisions. This plan defines the user's objective—convert AppScreen into a commercial SaaS—but is not evidence of provider provisioning, live model results or production readiness. Code findings and line references below describe the original planning snapshot.

## Recommendation

Build a hosted, multi-tenant SaaS whose core paid feature is turning raw app screenshots into polished, editable store campaigns. Keep the existing editor and its Canvas design engine inside a new customer-facing product shell. Add accounts, private workspaces, subscriptions, enforceable AI credits, cloud projects, and a durable background design worker. The agent should produce an editable campaign document, render it using the same engine as the editor, inspect the results, and repair specific problems before delivering exports.

The first technical proof is simple: **five real phone screenshots plus a short brief become a coherent five-screen campaign, editable in AppScreen and downloadable as PNGs and a ZIP—even if the user closes the tab while generation runs.** The first paid SaaS release must additionally support signup, private ownership, checkout, correct access/credit enforcement, subscription management, and support/recovery. A working AI demo alone is not the SaaS launch gate.

### Selected stack

| Responsibility | Recommendation | Reason for this app |
| --- | --- | --- |
| Editor | Keep vanilla JavaScript and Canvas; extract shared modules incrementally | Preserve the device controls, overflow templates, and existing project compatibility. No React/Next.js rewrite is required. |
| API | Node.js + TypeScript + Fastify; shared Zod document/tool schemas | One language across design logic and backend; explicit contracts for uploads, revisions, jobs, and AI operations. |
| Accounts and data | Supabase Auth + managed PostgreSQL | Centralize login, workspace membership, projects, revisions, and job records. |
| Assets | Supabase Storage, private buckets | Store originals, previews, and exports separately from project JSON. |
| Hosting | Render Docker web service + background worker | Keep the API responsive while AI and Chromium rendering run independently. Serve the editor and API on the same origin initially. |
| Job queue | pg-boss on PostgreSQL | Durable jobs and retries without adding Redis to the MVP. |
| Payments | Stripe Checkout + Billing + customer portal, subject to business eligibility | Hosted purchase/subscription management, with AppScreen enforcing access and credits server-side. |
| AI | OpenAI Node SDK / Responses API, vision inputs, structured outputs and restricted application tools | Analyze the captures, plan a campaign, edit a validated document, and inspect rendered previews. |
| Rendering | Playwright + pinned Chromium in the worker, loading our own render-only page | Reuse the browser Canvas engine rather than maintain a second graphics implementation. |

This is an architectural recommendation, not a claim that every deployment setting has been proven. Validate the database connection and a headless render in the target container during the first milestone. Render supports [Docker services](https://render.com/docs/docker) and [queue-consuming background workers](https://render.com/docs/background-workers). Supabase provides [Auth](https://supabase.com/docs/guides/auth) and [private storage with expiring download URLs](https://supabase.com/docs/guides/storage/buckets/fundamentals). [pg-boss](https://github.com/timgit/pg-boss) supplies PostgreSQL-backed job processing and retries.

Use a direct database connection for the long-lived worker where reachable, or Supabase's session pooler when required by network connectivity. Test queue migrations and restart recovery against that exact connection; do not assume transaction pooling is interchangeable. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

Tradeoff: this introduces Supabase and Render alongside the AI provider, but avoids operating authentication, file storage, PostgreSQL, and servers ourselves. Docker keeps the runtime portable if hosting changes later. Select the model and concurrency limits using quality/cost measurements; do not inherit the editor's hardcoded model defaults blindly. No vector database, general browser agent, or multi-agent framework is needed for v1.

## SaaS product scope

Initial audience hypothesis: independent app developers and small app studios. The promise is “Upload your app screenshots; get a polished store campaign you can still edit.” Validate that positioning with early users rather than treating it as established market research.

Build the customer journey around:

- Public product, examples, pricing, help, and policy pages.
- Signup/login, account recovery, and a short first-campaign onboarding flow.
- A private project dashboard with recent campaigns, job progress, recoverable drafts, and “Create campaign.”
- The existing editor, with cloud saving and AI design/refinement alongside manual controls.
- Usage and billing: remaining credits, renewal information, receipts, payment method management, and clear cancellation.
- Account settings, data export/deletion, and a problem-report action carrying the affected job ID.

Suggested route boundaries are `/` for the public site, `/app` for projects, `/app/projects/:id` for the editor, and `/app/billing` and `/app/settings` for account management. No frontend-framework rewrite is needed to establish these boundaries.

### Workspaces and customer isolation

Create one personal workspace at signup. Projects, assets, revisions, jobs, exports, subscriptions, and credit balances belong to that workspace—not directly to a browser or an unverified user-supplied owner ID. Add `workspaces` and `workspace_members` from the first database migration; initially expose only the owner experience. Invitations and collaborative editing can come later without changing the tenancy foundation.

Enforce active membership and resource ownership in the API and database/storage policies. Scope child references to the same workspace, not merely to valid IDs. The worker loads the trusted job/workspace context from the database and rechecks permission before privileged operations. Access revocation must prevent new downloads, edits, and jobs. Team-role and ownership-transfer behavior must be defined before invitations ship.

### Monetization recommendation

Start with a limited trial and one monthly paid plan with an included AI-credit allowance. Include manual editing and repeat downloads of already generated assets without extra AI charges. Price new campaigns and user-requested AI refinements clearly; include automatic repairs in the quoted action price. Optional, explicitly purchased credit packs can follow once recurring usage is understood. Do not enable surprise overages or advertise unlimited AI.

Exact prices, credit allowances, trial budget, storage limits, credit expiry/rollover, and retention periods remain business decisions. Set them from measured provider/render/storage costs and customer testing before public sale. Confirm payment-provider availability for the business's actual legal entity and country before provisioning.

Use [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/overview) and its [customer portal](https://docs.stripe.com/customer-management) for recurring billing and self-service payment/subscription management. AppScreen still owns its feature-entitlement policy and usage accounting.

Billing and credit requirements belong in the foundation:

1. Keep provider customer/subscription IDs, a local entitlement snapshot, billing-event inbox, and append-only credit ledger. Separate customer credit charges from raw provider cost records.
2. Before queuing a job, atomically verify membership, plan permissions, quotas, and available credits; reserve the quoted credits in the same transaction as job creation. Concurrent requests cannot spend the same balance twice.
3. Settle each action once according to the published price, release unused reservations, and do not charge again for worker retries or automatic repair. Recommended default: release the reservation if cancellation/failure occurs before a usable result is delivered; internal provider costs may still have occurred. Reconcile abandoned reservations against job state.
4. Verify payment-webhook signatures against the raw request body, durably record events, and process them idempotently. Stripe can deliver duplicate and out-of-order events, so reconcile authoritative subscription state instead of trusting arrival order. See [Stripe webhook guidance](https://docs.stripe.com/webhooks).
5. Grant recurring credits once per eligible paid invoice/billing period, not once per callback. A checkout return URL must not grant paid access. Validate fulfillment using server-side payment/subscription state; see [subscription webhook guidance](https://docs.stripe.com/billing/subscriptions/webhooks).
6. Define trial expiry, payment failure, cancellation-at-period-end, downgrade, refund, and exhausted-credit behavior. Pending/failed initial payment does not enable paid generation. Preserve existing projects under the disclosed retention policy; a subscription cancellation is not an instruction to delete user work. Honor already reserved in-flight jobs under the published policy.
7. Reconcile billing state periodically and alert on mismatches. Owners alone can open billing sessions. Never expose billing mutations to the design agent.

Checkout buttons must show the selected plan and renewal terms, prevent duplicate submissions, and display “Confirming payment” until the backend verifies access. Payment failures need an actionable recovery path. Keep “Cancel subscription” distinct from “Cancel generation.”

### Launch operations

Provide a restricted, audited operator view of failed/stuck jobs, stage history, payment synchronization, credit adjustments, and cost per delivered campaign. Support should work from job IDs without routine access to customer screenshots. Privileged access and credit adjustments need explicit authorization and audit records.

Before public launch, test backups/restoration, deletion and retention, error alerts, support escalation, trial-abuse limits, and the full signup-to-renewal/cancellation flow. Add minimal product analytics for signup, first upload, first successful campaign, export, and paid conversion; do not send screenshot contents as analytics payloads. Configure and test account-recovery and billing/service notifications, including delivery failure handling.

Complete a commercial asset/license and policy review. The repository README identifies an MIT license and credits two CC BY 4.0 device models; verify the actual license texts, required notices/attribution, bundled fonts/assets, and branding before launch. This is a review requirement, not a conclusion that every included asset is cleared for every commercial use. Have the responsible business advisers review privacy, terms, refunds, and tax setup for the intended markets.

## What exists, and what is missing

| Existing code | Finding | Consequence for the plan |
| --- | --- | --- |
| `app.js:3062`, `app.js:8993` | IndexedDB saves a large state snapshot containing embedded image data; rendering also triggers saving. | Separate document edits, binary assets, rendering, and persistence before adding cloud autosave. |
| `app.js:8199` | Creating a screenshot also creates an editor scene and continues applicable overflow templates. | Add a batch asset-import path that does not prematurely create or rearrange campaign scenes. |
| `app.js:1373`, `templates.js` | Linked device placements and reusable overflow layouts already exist. | Preserve these; expose validated placement/group operations to the agent. |
| `magical-titles.js:287`, `llm.js:72` | AI features are individual browser actions; provider credentials come from local storage. | Move hosted AI access to authenticated server jobs with server-held secrets and usage limits. |
| `app.js:9256`, `app.js:10487` | Useful rendering helpers exist, but exports still depend on global editor state and timed waits. | Introduce a revision-based renderer that explicitly waits for assets and fonts. |
| `nginx.conf` | Existing AI routes proxy provider requests; they are not a project backend or job system. | Replace hosted raw proxy usage with task-specific API routes. The Python development server does not implement these proxy routes. |
| `Dockerfile`, `docker-compose.yml:3`, `index.html:26` | Docker omits `ui-redesign.css`; Compose references the upstream image. | Fix packaging in the first implementation milestone so deployed code matches this checkout. |

Audit scope: local source and editor UI. This was not a production security audit or an end-to-end live AI test.

## The user experience

Add one primary entry point: **Design with AI**. Keep all existing manual tools available.

1. **Upload:** drag in captures, see thumbnails and upload status, choose replacements for unusable images. Originals remain unchanged.
2. **Brief:** app name, one-sentence promise, audience, optional brand colors/logo, and desired style. Default to English, five screens, and one supported iPhone portrait output. Suggest facts inferred from captures, but distinguish them from user-confirmed facts.
3. **Generate:** one action starts the full job. Show a concise summary of scope and expected credit usage before submission. An optional “Review direction first” mode can pause after the storyboard; it is not required for the normal end-to-end flow.
4. **Follow progress:** show the actual stage, completed previews, and actionable warnings. The user can leave and return without losing work.
5. **Review:** show the campaign as a strip and at full size, with editable text, backgrounds, devices, sources, and linked overflow groups.
6. **Refine:** accept instructions such as “Make the phone on screen 3 larger” or “Keep the devices; make the copy shorter.” Show the affected scope and compare the resulting revision before applying it.
7. **Export:** download individual PNGs, the ordered ZIP, and a portable project backup containing the document and required assets.

### Buttons and feedback

| State/action | Expected behavior |
| --- | --- |
| Generate campaign | One prominent primary button. Explain missing requirements beside it; do not leave an unexplained disabled button. Keyboard activation and a visible focus ring must work. |
| Submission | Immediate “Starting…” feedback; one idempotency key prevents double-clicks from creating duplicate jobs. |
| In progress | Stage labels such as “Planning your story” and “Checking screen 3 of 5,” not a fabricated percentage. Keep a secondary Cancel action available. |
| Cancel | Change to “Stopping…” while the worker acknowledges cancellation. Explain that a provider request already running may still finish and incur usage. Preserve completed work. |
| Failure | Identify the failed stage and offer Retry from checkpoint. Keep any usable draft; do not force a full paid regeneration. |
| Ready | Primary “Open draft”; secondary “Download ZIP.” A ready draft must not silently replace an existing manually edited campaign. |
| Refine selection | Show “Screen 3 · Device 2” or the connected group being edited. Honor locked text, positions, sources, and styles. |
| Apply revision | Show before/after and changed items; applying becomes one undoable action. Flag conflicts with newer manual edits instead of overwriting them. |
| Save status | Distinguish “Saved on this device,” “Syncing,” “Saved to cloud,” and “Sync failed.” Never report cloud success before the server confirms it. |

Use readable labels alongside icons, consistent primary/secondary/destructive treatments, generous touch targets, accessible status announcements, and no motion-only feedback.

## How the agent works

Use one durable orchestrator with bounded stages—not an unrestricted agent clicking around the editor.

**Inputs → analysis → storyboard → editable layout → render → quality checks → targeted repair → delivery**

1. **Validate and analyze assets.** Decode and validate format, dimensions, orientation, and file size. Produce analysis thumbnails; record visible features, dominant colors, likely focal areas, duplicate captures, and confidence. Flag private data and poor inputs. Do not infer unsupported functionality from filenames alone.
2. **Plan the story.** Choose an order that leads with the strongest outcome, followed by distinct capabilities and supporting benefits. Map every planned scene to stable source asset IDs. Never invent ratings, customer counts, awards, or capabilities. Ask for missing essential facts only when a conservative draft cannot proceed.
3. **Choose a coherent visual direction.** Select from a versioned template catalog with metadata: suitable screen counts, text zones, device capacity, source slots, supported output profiles, and overflow rules. Start with one independent layout family and one connected family, then qualify the remaining variants.
4. **Compose the document.** Generate concise copy, colors, typography tokens, device transforms, cropping, and scene order. Apply layout constraints through application code. The model proposes design choices; validated code calculates geometry and enforces limits.
5. **Render the exact revision.** Generate full-size scenes and a contact sheet using the same document and renderer used by the editor. Assets and fonts must be ready; no arbitrary sleep.
6. **Check the result.** Deterministic checks cover missing assets, source mapping, text overflow, unsafe coordinates, incorrect dimensions, and broken seams. A visual model reviews readability, visual balance, narrative repetition, and product visibility. A model score is a recommendation, not a guarantee.
7. **Repair locally.** Fix the reported scene/property, re-render affected scenes and linked neighbors, and re-check. Allow at most two automatic repair rounds initially, with a total job budget and deadline. If issues remain, deliver a clearly labeled review-needed draft rather than silently passing it.
8. **Deliver.** Save an immutable draft revision, previews, QA report, ordered export manifest, PNGs, ZIP, and project backup. Record which sources and template versions produced them.

Use [vision image inputs](https://developers.openai.com/api/docs/guides/images-vision) for source analysis and rendered-preview review. Use [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) for analysis/storyboard contracts and [function calling](https://developers.openai.com/api/docs/guides/function-calling) for application operations. A valid JSON schema does not guarantee factual or visual correctness, so business validation and render checks remain mandatory. Handle refusals and incomplete responses explicitly.

The agent must preserve real product UI. Generated backgrounds or decorative assets can be added later as a separate opt-in feature; synthesizing replacement app interfaces is not the default campaign workflow.

### Restricted agent operations

Expose a small typed tool surface: inspect approved source metadata, list compatible templates, compose a draft, update copy, transform a device, change a background, reorder scenes, render a revision, inspect quality results, and export an approved revision.

All operations are scoped to the authenticated project and job revision. Accept only existing owned asset IDs, known template IDs, bounded numeric values, and allowed properties. No arbitrary JavaScript/HTML, shell commands, SQL, filesystem access, arbitrary URLs, public sharing, billing changes, or App Store publishing tools.

## The foundation: a real campaign document

Do not make the backend persist the current runtime `state` object directly.

The new versioned `CampaignDocument` should contain:

- Identity: schema version, project ID, revision ID, parent revision, renderer version, template version, and deterministic noise seed.
- Brief and brand: confirmed facts, audience, copy language, colors, fonts, and design direction.
- Sources: stable source IDs with locale-to-asset mappings. Binary files live in storage; image objects and expiring URLs do not belong in the document.
- Scenes: stable IDs, order, background, text layers, decorative layers, and device/group references. The campaign/export supplies the output profile; all members of a connected group must share identical dimensions.
- Devices: source ID, crop, transform, appearance, layer order, visibility, and editable-property locks.
- Connected groups: one canonical device definition and transform in a shared layout space, rendered through each scene's viewport. Border, radius, shadow, and screenshot mapping cannot drift between two separate copies. Appearance groups are separate from individual seam-placement groups; their references preserve the current border/shadow/radius sharing across an entire transitively connected screen chain.
- Localized overrides and source provenance, even if the first AI release generates English only.

Keep zoom, selected tab, selected device, image caches, and other editor-only state local.

For overflow groups, screen boundaries are clipping windows, not independent device definitions. Compute shared geometry before clipping, including shadow/border bleed. Preview gutters are display spacing and must not change export coordinates. Moving a linked device updates all relevant clips; unlinking explicitly creates independent devices. Reordering/deleting a member scene must reflow the group or request an explicit unlink—not silently corrupt continuity.

The current placement links support pairs of adjacent scenes, not arbitrary multi-screen spans. Preserve and test that behavior first. Broader spans require explicit renderer/schema support later. Reject mixed dimensions within connected groups; a new export profile must reflow and validate the whole group together. During migration, keep per-device geometry distinct from shared appearance: a border edit must identify every affected device/scene rather than pretend it is a single-device change.

### Storage and persistence

Start with `workspaces`, `workspace_members`, `projects`, `assets`, `campaign_revisions`, `agent_jobs`, `agent_job_steps`, `job_events`, `exports`, `subscriptions`, `billing_events`, `credit_ledger`, `credit_reservations`, and `usage_events`. Use workspace-scoped ownership and foreign-key checks throughout. Put the editable document in a validated JSONB revision, while ownership, status, timestamps, and usage remain queryable columns. Keep payment inbox and ledger records server-only.

Create immutable revisions and update the project's active revision with an expected-version check. A stale save returns a conflict rather than overwriting newer work. Agent jobs branch from a specific input revision; changes made by the user while a job runs are preserved.

Keep IndexedDB as an offline cache and a compatibility path for local projects. In the SaaS, the server is authoritative for cloud revisions, access, and credits; offline clients cannot create billable jobs or grant themselves paid features. Debounce cloud saves after document changes, not every render. Offer an explicit “Copy local project to cloud” migration with a backup, asset deduplication, validation, and a successful reload check before considering migration complete. Do not delete local originals during migration.

## Backend boundaries

Suggested API contracts:

- Project create/list/read and version-checked revision save.
- Workspace/session context, usage balance, and server-computed entitlements.
- Owner-authorized checkout and customer-portal sessions; a separate verified billing webhook endpoint.
- Asset upload authorization and upload completion verification; signed downloads after ownership checks.
- `POST /api/projects/:id/design-jobs` with source IDs, brief, input revision, output profile, and idempotency key.
- `GET /api/jobs/:id` and `GET /api/jobs/:id/events` for resumable progress via server-sent events, with polling fallback.
- `POST /api/jobs/:id/cancel` and retry from a valid checkpoint.
- `POST /api/projects/:id/revision-jobs` for scoped natural-language refinement.
- `POST /api/projects/:id/export-jobs` for immutable-revision export and signed result downloads.

The API validates workspace membership, plan access, and quotas, reserves credits, creates the job transactionally, and returns promptly. The worker executes stages and records checkpoints. The browser never needs to remain open to execute the workflow.

Job states: queued, analyzing, planning, composing, rendering, checking, repairing, ready, needs-input, failed, cancelling, cancelled. Events have sequence IDs so reconnection does not lose progress. Worker heartbeats, timeouts, bounded retries, and expired-work recovery prevent jobs from remaining “running” indefinitely.

Queue delivery guarantees do not make external AI calls exactly-once. Save request/result identifiers and completed stage outputs; use idempotent writes and deterministic artifact keys. For an ambiguous provider timeout, reconcile when possible before a bounded retry; record potential duplicate provider cost honestly.

## Rendering, security, and quality gates

Extract a render entry point accepting `(document, sceneId, locale, outputProfile, assetResolver)`. It must not change selection, save projects, depend on open inspector controls, or load remote content chosen by the model. Explicitly await image decoding and font readiness, and fail with actionable errors for missing resources.

Use the shared renderer in browser previews and a dedicated server render page. Pin fonts and Chromium, seed randomness, and compare fixed fixtures. Allow small cross-platform antialiasing differences in editor/server comparisons; require reproducibility inside the pinned worker. Verify 2D first; keep existing manual 3D projects compatible, but postpone autonomous 3D until worker fidelity and performance are measured.

Server output must use a validated store profile. The first target is iPhone portrait **1320 × 2868**. Apple currently permits 1–10 screenshots and disallows alpha channels/transparency; flatten the image and encode PNG without an alpha channel, then verify the final bytes. Recheck rules when adding profiles. Correct dimensions alone do not guarantee App Review acceptance. See [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

Security requirements from the first cloud release:

- Enforce project ownership on every API, job, revision, and asset operation. Configure database/storage row-level policies and test cross-account denial. Server service credentials bypass RLS, so privileged paths require explicit ownership checks; never expose those credentials. See [Supabase storage access control](https://supabase.com/docs/guides/storage/security/access-control).
- Keep AI credentials server-side; do not copy existing browser keys into cloud backups. Clearly separate any retained local BYOK mode from the hosted product.
- Accept supported raster uploads only initially; verify actual bytes, decoded pixel count, dimensions, and size. Normalize analysis copies and strip unnecessary metadata. Reject arbitrary remote imports and executable SVG/HTML from agent output.
- Treat screenshot text, filenames, and model output as untrusted data, not instructions. Do not allow an image to expand the agent's authority or disclose other project data.
- Restrict the renderer to bundled code and authorized assets; use non-root isolation, appropriate browser sandboxing, resource limits, deadlines, and restricted network access. Validate the hosting configuration; [Playwright's Docker guidance](https://playwright.dev/docs/docker) documents sandbox considerations.
- Disclose that generation sends selected screenshots to an AI provider. Avoid raw screenshots, prompts, secrets, and signed URLs in routine logs; define retention, deletion, and user-controlled cleanup before public launch.
- Enforce per-user/project upload, storage, job, concurrency, token, and render limits server-side. Record usage per stage and expose costs/credits consistently. Do not promise unlimited generation.
- Back up database records and binary assets, and perform a restore test. Retain revision-referenced assets; garbage-collect only unreferenced objects after a safety window.

## Implementation sequence

| Milestone | Work | Acceptance gate |
| --- | --- | --- |
| 1. Reusable design core | Add the document schema and legacy adapter; extract renderer and pure template operations; qualify one independent and one overflow family; correct deployment packaging. | Existing fixture projects retain their appearance and device controls. One saved document renders outside the interactive editor. |
| 2. SaaS foundation | Add signup, personal workspaces, dashboard, private uploads, revisions, ownership policies, API/worker, Stripe test-mode checkout/portal, entitlements, credit reservations/ledger, and progress events. | A customer can sign up, subscribe in test mode, save/reopen, and manage billing. Cross-workspace access fails; duplicate payment events or job submissions do not duplicate credits/charges. Jobs survive closing the browser and restarting the worker. |
| 3. First end-to-end agent | Add asset analysis, storyboard, constrained composition, preview render, basic validation, and editable draft delivery. | Five sources produce a coherent five-screen campaign and ZIP. Every product image maps to a real input asset; no browser key is required. This is the first product demo. |
| 4. Quality and revision loop | Add visual review, targeted repairs, property locks, revision compare/apply, cancellation, retry, and informative button states. | “Enlarge this device” affects only the selected device/connected group; no manual work is lost. Deliberately broken drafts are corrected or clearly flagged. |
| 5. Paid SaaS launch | Finalize pricing/allowances from measurements; finish public product/pricing pages, billing recovery, operator/support tools, notifications, retention/deletion, restore drills, and controlled production rollout. | An independent customer can sign up, purchase, generate/edit/export, return later, manage/cancel billing, and get help. Security, payment, recovery, quality, and cost gates pass; production activation is explicitly approved. |

Milestones 1–3 form one vertical slice of the SaaS, including test-mode monetization and workspace isolation—not just an AI demo. Core billing/credit authorization is not deferred to launch. Keep team invitations, elaborate plan tiers, template marketplaces, and unrelated redesign out of that first slice. Provider setup and paid infrastructure require a separate implementation decision; this plan does not authorize deployment.

Suggested new module boundaries: `core/document`, `core/migrations`, `core/templates`, `core/render`, `client/persistence`, `client/agent-panel`, `client/account`, `server/api`, `server/tenancy`, `server/billing`, `server/jobs`, `server/agent`, `server/render`, and `supabase/migrations`. Extract only necessary responsibilities from `app.js`; preserve existing globals through a temporary adapter while migrating.

### Release tests and evaluation

- Golden fixtures: independent devices, multi-device scenes, linked overflow with thick borders/shadows, reordered scenes, localized sources, and legacy project import.
- Source fidelity: every device references the intended owned input; no fabricated interface or unsupported marketing claim.
- Geometry: no unintended text clipping; intentional device bleed is allowed; stitched adjacent exports have continuous devices without gaps or style changes.
- Resilience: double-click, disconnect, reload, worker restart, expired asset URL, provider timeout, failed font load, cancellation, and retry preserve the last valid draft.
- Isolation: cross-user asset/job access fails; prompt-injection text inside a screenshot cannot invoke disallowed operations.
- Billing: duplicate/out-of-order callbacks, failed initial payment, renewal, trial expiry, cancellation, downgrade, refunds, and provider reconciliation produce the correct access and ledger state.
- Credit safety: concurrent jobs cannot overdraw; repeated retries cannot double-charge; failed/cancelled work settles under the published policy; an expired reservation cannot leave a customer permanently short of credits.
- SaaS journey: a new customer reaches their first successful export, can reopen work on another device, manages billing without support, and can request data deletion under the published policy.
- Exports: correct dimensions, opaque RGB PNGs, complete ZIP, stable ordering, manifest, and a project backup that successfully reimports.
- Cost/quality: use at least ten representative, permission-cleared app campaigns. Measure human-rated readability/coherence/factuality, completion rate, repair frequency, latency, and cost per accepted campaign before selecting the default model and pricing.

Initial scope: 3–10 PNG/JPEG sources, five output scenes by default, 2D device layouts including connected overflow, English AI copy, one iPhone profile, editable drafts, and server export. Expand to 5–8 scene choices, all qualified templates, localization, iPad/Google Play profiles, and optional decorative image generation after the first complete path works. Automatic App Store submission, generated replacement UI, real-time team collaboration, and autonomous 3D are deferred.
