# AppScreen launch acceptance

Reviewed September 6, 2026. This is a completion checklist, not authorization to
spend money, provision services, change business policies or activate production.
Local evidence is maintained in [implementation tracking](../IMPLEMENTATION_STATUS.md).
A passing mock, SDK rehearsal or manual demo must not be substituted for a real
provider, customer journey or commercial decision.

## Six remaining gates

| Gate | Local foundation | Required acceptance evidence | Decision or external dependency |
| --- | --- | --- | --- |
| Real AI design | Staged analysis/storyboard/composition/render/review/repair, source fidelity, template constraints, credits and editable exports | Authorized five-source live design, scoped refinement, usable saved output, real usage and failure/recovery evidence; representative permission-cleared quality/cost evaluation before production defaults | Intended provider project/key, image-sharing approval and explicit bounded spend |
| Hosted deployment and recovery | Docker package, sandbox requirement, private storage adapter, database migrations, local restore/export evidence | Successful Linux sandbox/render; actual hosted Auth/private Storage and tenant denials; worker restart; measured container capacity; independent database/object/Auth recovery | Approved builder/hosting target, service configuration, domain, infrastructure budget and deployment authority |
| Payments and commercial policy | Checkout/portal adapters, webhook inbox, subscription reconciliation, credit reservations and ledger | Intended Stripe test account's real purchase/renewal/cancellation/failure and duplicate/out-of-order event lifecycle | Eligible business/account, price, trial/credit/storage rules, refund/cancellation policy and allowances based on cost evidence |
| Customer recovery and operations | Recovery UI, support/inbox, staff review and email adapters, deletion request/cancellation | Actual recovery/service/billing email and independent alerts; assigned support/escalation owners; implemented and verified deletion fulfillment under approved retention rules | Approved sender/provider and recipients; retention, legal holds, subscription handling, Auth deletion and backup-expiry decisions |
| External-agent interoperability | Shared MCP tools, authenticated scopes, template/edit/export operations and revocation | Actual Codex and Claude Code workflows using scoped credentials; no authority beyond granted tools; revocation blocks further use | Explicit client connection/configuration approval; real OAuth provider/client checks only if OAuth ships |
| Rights and release approval | Dated asset inventory and partial bundled notices | Resolved application copyright/permission notice, model/artwork provenance and required packaged notices; reviewed commercial policies | Authoritative rights evidence or approved exclusion/replacement; explicit controlled launch approval |

## Scope is not all possible features

The initial release qualifies 2D templates including connected overflow, English
AI copy and the selected iPhone profile. Existing local 3D/layered-photo work stays
preserved, but unsupported templates must remain visibly unavailable to hosted
jobs. Autonomous 3D, a template marketplace, team collaboration and App Store
publishing are not prerequisites for this first release.

Scoped bearer connections can satisfy MCP v1. Native OAuth is optional and may
remain disabled; it becomes a separate mandatory acceptance gate if advertised
or enabled. An SDK transport test is valuable protocol evidence, not proof that
both installed agent applications have been connected and used successfully.

## Current concrete constraints

- A real HTTP MCP rehearsal now passes 98 checks with the official installed
  SDK, synthetic workspaces and scoped tokens. PNG/ZIP/backup bytes and tenant,
  scope and revocation denials verify. Its intentional layout warnings remain
  `needs-input`; neither installed agent application has been connected by this
  rehearsal, and no native OAuth or paid model result is implied.
- Offline AI preparation and an isolated per-request spend guard are implemented.
  The guard tests exercise the actual installed OpenAI SDK with mocked transport;
  that is not live-provider evidence. Existing campaign previews now fail closed
  when they would include unselected, differently localized, private or unusable
  images. Privacy flags also apply across aliases of the same image asset.

- The project contains an OpenAI key setting, but presence is not proof of its
  intended project, validity, budget or permission to call it. No credentials are
  copied into this checklist. The subsequently approved single synthetic $5 test
  received one completed model response (~$0.25 usage estimate), then failed while
  saving a usage checkpoint. That JSON persistence issue and an exact-template
  draft identity issue are fixed and covered by offline real-database regressions;
  the earlier full 630-test suite passed. That attempt delivered no AI design and
  its original receipt remains consumed. The user's subsequent total-budget
  continuation is conservatively capped at $5 including the original attempt;
  a pinned durable ledger retains every hold across fresh one-use fixtures.
  A later real seven-generation pipeline delivered five verified PNGs and both
  archives, but remains `needs-input` for locked-template cropping and polish;
  independent visual review scored 9/12. All three attempts total $1.855665 in
  usage estimates, with $4.132789 conservatively retained under the original $5
  cap. The ledger closed cleanly and paid testing stopped. The expanded 678-test
  suite passes. This is pipeline evidence, not quality/production acceptance.
  See implementation tracking for actual outcomes and retained artifacts.
- Supabase, Stripe and service-email configuration were absent from the scoped
  project environment check. Do not search unrelated projects or reuse their
  credentials to fill these gaps.
- Docker's current Linux VM filesystem reports 19.5 GB used, no free space;
  the host has about 82 GB free. Host free space does not enlarge the VM disk.
  A disk expansion or separate builder requires an explicit target/approval.
  No blanket cleanup, unrelated container restart or browser-sandbox bypass is
  an acceptable substitute. Static deployment checks do not close the Linux gate.
- Account deletion currently records and cancels requests only. A saved request
  is not fulfilled deletion. Do not enable a destructive worker or invent a
  retention/cancellation period before those policies are approved.
- The model/artwork/application rights questions in
  [the asset inventory](ASSET_LICENSE_REVIEW.md) remain unresolved. Keeping 3D out
  of the worker does not exclude its bundled files from distribution.

## Evidence required to close a gate

Record the environment, tested commit or source hash, scoped identities, inputs,
result artifacts, failures, costs or conservative reservations, reviewer and date.
Retain ambiguous/failed runs; do not rerun with fresh spending authority or replace
them with a simulated success. Never include credentials, signed media links or
customer screenshot/prompt contents in public reports.

Production activation remains a separate explicit decision after the six gates
are satisfied. A local manual campaign or portable campaign recovery is a useful
milestone, not a completed paid SaaS.
