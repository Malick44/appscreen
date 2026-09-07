# Shared campaign engine

The web editor, API, AI pipeline and MCP use one editable document. Source screenshots are assets, not slides. A source may appear in several independent devices or be clipped across neighboring scenes without copying its bytes.

## Document contract

`campaign.mjs` exports `createCampaign`, `validateCampaign`, `assertCampaign`, `applyOperations`, `applyTemplate`, `resolveDevice`, `toLegacyState`, `fromLegacyState`, and `assertDocumentEditAllowed`.

- `schemaVersion` and `rendererVersion` version the document and output rules; `revision` supports optimistic concurrency.
- `sources[]` contains stable source IDs and uploaded `assetId` references, with `localizedAssets` keyed by language. No binary data, expiring signed URLs or runtime `Image` objects are stored.
- `scenes[]` owns text, background, decorative elements, popouts and device placement IDs.
- `deviceGroups[]` owns canonical source/geometry. Connected groups store a global horizontal coordinate: scene index plus local `centerX`. Each scene clips the same logical phone.
- `appearanceGroups[]` owns frame, shadow and corner radius, independently from device geometry.
- Campaign, scene and device locks guard operations. `exact` template mode also guards device positions. `auto`/`inspiration` permit repositioning unless explicitly locked.

`applyOperations` returns an immutable new document and increments its revision once per atomic operation batch. It accepts `expectedRevision` and throws `CampaignError` with `code` and `statusCode`. Call `assertDocumentEditAllowed(existing, proposed)` for whole-document saves; validation alone does not enforce existing locks. Asset/workspace ownership remains the API's responsibility.

Supported operations: `update_campaign`, `set_locks`, `set_template_mode`, `apply_template`, `reorder_scenes`, `add_source`, `add_scene`, `update_scene`, `update_text`, `update_background`, `update_device`, `update_appearance`, `add_device`, `duplicate_device`, `remove_device`, and add/update/remove element or popout. Patches must use uploaded asset IDs. Adding a scene continues the previous outgoing connected device automatically.

## Rendering

`render.mjs` exposes asynchronous `renderScene(canvas, document, sceneId, { resolveAsset, locale })`. It waits for decoded assets and the pinned bundled Inter font, then uses the same synchronous Canvas composition as cloud projects in the editor. Noise is seeded. QA reports measured clipping, off-canvas devices, low-resolution sources, long/placeholder copy and possible text/device collisions.

`/render/index.html` exposes `window.AppScreenRenderer.render({ document, sceneId, assets, locale })`, returning `{ png, width, height, sceneId, rendererVersion, qa }`. `png` is a PNG data URL; `assets` maps owned asset IDs to URLs or data URLs provided by the trusted render worker. The renderer does not fetch arbitrary URLs from the campaign document.

The original 17 2D templates are supported. The separately-added Pulse Portrait uses 3D and is marked `cloudCompatible: false`. Cloud export rejects unsupported 3D and layered-photo scenes explicitly; existing local editor functionality is retained. Custom cloud font assets are not implemented; use the bundled `AppScreen Sans` for reproducible designs.

## Editor bridge

`window.AppScreenCloudBridge` is available after `app-screen-bridge-ready`:

- `importDocument(doc, { resolveAsset, expectedRevision, preserveSelection })` waits for local initialization and imports into the cloud project's own local cache ID. It never replaces the previous local project's record.
- `exportDocument({ assetMap, name })` returns a document at the current baseline revision.
- `getAssetReferences()` discovers source, background and graphic uploads. `registerAssets({ originalSrc: uploadedAssetId })` registers completed uploads.
- `acknowledgeSave(serverDocument)` updates only revision metadata, preserving edits made while a save was in flight.
- `app-screen-document-change` emits `{ document }` or `{ error, needsUpload }`; the SaaS shell manages authentication, upload, debounced saves and conflicts.

Run `node --test core/*.test.mjs`. Tests exercise all supported template documents, connected geometry/appearance, locks, atomic edits, revision conflict detection, source/localization roundtrips, continuation, invalid payloads, seeded noise, pixel-identical headless/editor composition and isolated editor import.
