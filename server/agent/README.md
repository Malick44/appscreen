# Hosted campaign design engine

`createAgentEngine({ apiKey, model, provider? })` returns `runAgentJob(job, host)`. Production uses the OpenAI Responses adapter. `provider` and a provider `client` are explicit dependency injection points for tests, not success fallbacks when credentials or the provider fail.

The default model follows the fetched official Structured Outputs guidance (`gpt-6-astra`); production can choose another compatible vision/tool-calling model through server configuration after evaluating quality and availability. No browser-held provider credential is accepted.

## Execution

1. Load a trusted immutable input revision and selected, owned sources.
2. Analyze the real screenshots: supported facts, source identities, focal areas, quality and privacy warnings.
3. Create an evidence-backed storyboard with a catalog template and the requested screen count.
4. Compose an editable core document. Preserve original source IDs/assets and canonical connected device groups. Honor exact/inspiration/auto template policy and property locks.
5. In auto/inspiration mode, allow a single restricted `apply_campaign_edits` tool call for composition improvements. Refinement uses the same operation tool with explicit selection scope.
6. Render through the host's deterministic Canvas renderer.
7. Review contact sheet plus individual screen images and merge visual findings with deterministic issues.
8. Repair only reported problems, for at most two rounds. Unresolved issues produce a review-needed draft, never a fabricated clean result.
9. Persist an immutable draft and QA report. The host makes exports and applies revisions only through version-checked operations.

All stages use durable JSON checkpoints. Completed stage results are reused on retries, including the final save result. Provider usage is recorded by response ID before a result is accepted; the host must deduplicate ledger writes. There is no “exactly once” guarantee for an external model request whose network result is ambiguous. SDK automatic retries are disabled so the durable worker owns retry policy. Keep provider request IDs in the usage ledger and reconcile ambiguous failures explicitly.

The worker explicitly JSON-serializes checkpoint parameters, including top-level
arrays such as `usage_budget`, before binding them to PostgreSQL JSONB. Passing
arrays directly to the driver causes a SQL-array encoding failure (or silently
turns an empty list into an object). The real-database worker suite covers this
boundary, stage replay, retry accounting, transactional rollback and lost leases.

For a matching existing exact-mode campaign, composition clones the canonical
layout instead of regenerating device identities. This preserves manual geometry,
appearance groups, elements and placement IDs through the same durable revision
validator used by the editor, while permitting unlocked source/copy/color edits.

The adapter normalizes **analysis copies only** to JPEG at a maximum 2048 pixels per side, strips unnecessary metadata, flattens alpha, and caps encoded request size. Original assets and exported screenshot pixels remain untouched. It uses `store: false`; this is not a claim that all provider retention is disabled. The product's privacy policy must accurately disclose the provider/data flow.

Rendered previews are image inputs subject to the same selection boundary. Before
refining an existing or locked campaign, all displayed sources, localized pixels,
backgrounds and image layers must be included in the request's selected analysis
assets. Otherwise the worker returns `needs-input` with
`SOURCE_CONSENT_REQUIRED`, without making a model request, and releases the
customer credit reservation. New unlocked designs may use a selected subset.
After analysis, private or unusable images cannot appear in further model-bound
previews, including under a second source ID for the same asset. Cached analysis
is revalidated on reuse. This is a conservative consent/continuation check, not a
guarantee that a model detects all private information before initial analysis.

Analysis/storyboard/QA use strict Zod-derived response schemas. Edit stages expose one strict application function, with bounded values and no arbitrary property paths, URLs, HTML, code, billing or publishing authority. Application validation still checks semantics, source ownership, evidence references, locks and linked edit scope. Screenshot instructions are explicitly treated as untrusted content. Numerical/superlative marketing claims require literal evidence; remaining factual/visual correctness is also checked by the visual reviewer and remains subject to customer review.

## Job and host contract

```js
const job = {
  id: 'job-id', kind: 'design', projectId: 'project-id', workspaceId: 'workspace-id',
  input: {
    revisionId: 'immutable-base-revision-id',
    sourceIds: ['existing-source-id'],
    brief: {
      appName: 'My app', promise: 'User-confirmed main benefit',
      audience: '', style: 'Modern and elegant', confirmedFacts: [], brandColors: []
    },
    screenCount: 5, locale: 'en',
    template: { mode: 'exact', id: 'tidal-relay' }
  }
};
```

`kind: 'revision'` additionally requires `input.instruction` and can supply `input.scope.sceneIds` / `deviceIds`. The host resolves public/API request aliases to this schema. For a new project, create and persist a core campaign with verified owned assets before starting the engine. The source records, not upload order alone, establish identity.

Host methods:

- `getDocument(revisionId)` returns a validated core document whose `id` matches the trusted job project.
- `getAssets(assetIds)` returns owned `{ id, mimeType, ...metadata }` records; `getAssetBytes(assetId)` returns authorized bytes.
- `checkpoint(stage, data)` durably upserts JSON; `loadCheckpoint(stage)` returns saved JSON or null.
- `isCancelled()` checks trusted current job state; optional `signal` aborts in-flight provider calls.
- `render(document)` returns `{ scenes: [{ sceneId, png: Buffer, width, height }], contactSheet: Buffer, issues: [] }`.
- `saveDraft(document, qa)` idempotently persists and returns a JSON result with its new revision ID.
- `recordUsage({ jobId, stage, responseId, model, input_tokens, output_tokens, ... })` deduplicates usage records by provider response ID.

The host owns membership rechecks, credit reservation/settlement, concurrent-job limits, worker deadlines/heartbeats, artifact storage and ZIP/project exports. The engine caps repair rounds, per-request output tokens and cumulative checkpointed token usage. Do not use stage names as a fixed database enum without accounting for `rendering_N`, `checking_N`, `repairing_N` and `usage_budget`.

## Evidence and verification

`node --test server/agent/*.test.mjs` covers the complete staged engine with a controlled test provider, source preservation, exact template policy, replay, cancellation, privacy, bounded repairs, refinement/connected scope, marketing claims, strict provider schemas/tool calls, image normalization, incomplete results and refusals. These are protocol/behavior tests, not proof of live model design quality. Production acceptance still requires real screenshots, the configured live model, rendered visual review, credit accounting, restart recovery and editable export checks on the intended deployment.

Implementation references: [vision inputs](https://developers.openai.com/api/docs/guides/images-vision), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [strict function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

Fresh analysis uses `AnalysisObservationsSchema`: the model returns literal source
IDs and fact statements, not evidence identifiers. After exact source-set/schema
validation, the engine assigns deterministic `sourceId:fact-N` IDs. Quality,
privacy, warnings and statement text are not rewritten. Existing durable
`AnalysisSchema` checkpoints still undergo the original strict validation.
Source IDs that cannot fit the evidence namespace are rejected before dispatch.
Copy edits use an explicit validated evidence-to-source ownership map rather
than an ambiguous prefix match, including for imported source IDs containing
colons. Application-generated IDs do not establish that an observed fact is true;
source fidelity and visual review remain separate obligations.

## Isolated spending rehearsal

`spend-guard.mjs` is an injectable, single-process evaluation guard, not a
production budget controller. It counts the exact immutable request before
reserving the worst verified input/cache-write rate and full output allowance,
serializes requests, disables SDK retries and stops permanently on uncertainty.
Reservations are never released during the run. Missing usage is reported as an
unknown cost, not zero; usage estimates are not provider invoices. The focused
tests use mocked transport with the actual installed SDK and adapter.

An optional async `reserveBeforeSubmit` hook receives only frozen numeric
accounting facts after counting/local reservation and before generation. It
must resolve only after durable reservation; rejection, timeout or abort stops
submission without releasing the hold. The local rehearsal wires it to
`deploy/live-ai-budget-ledger.mjs`, a pinned single-host aggregate allowance
including prior attempts. Clean close retains all receipts, while crashes or
ambiguous storage block further runs. Neither component is a production
distributed billing service or permission to create a fresh spending allowance.

`server/tests/live-ai-smoke.ts --prepare` prepares five fixed synthetic inputs
offline in a fresh loopback test workspace. A live invocation is opt-in, requires
one-use fixture/key-file approval plus the same pinned aggregate spending ledger,
and leaves customer AI disabled. Final delivery QA merges with earlier critique
findings; completed output still needs independent visual acceptance.
See [setup](../../SAAS_SETUP.md) for the safe preparation workflow and
[launch gates](../../deploy/LAUNCH_GATES.md) for outstanding acceptance criteria.
