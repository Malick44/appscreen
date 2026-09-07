# Deterministic layout QA — September 5, 2026

The cloud renderer now reports `TEXT_DEVICE_OVERLAP` when visible main headline/subheadline ink or its underline/strike touches a device body or visible border. The previous test required an axis-aligned device box to cover more than 35% of an entire text-line box. It both missed small real collisions and could flag empty space beside tilted/rounded devices.

## Behavior and limits

- Crop, scale and placement geometry is shared with the existing renderer. Collision masks reuse its actual rounded clipping, rotation, shear, border stroke and opacity. The new check does not reposition devices, change source images, alter connected groups, override locks or repaint the exported design.
- Text masks use the existing text renderer: font, italic, alignment, language layout, explicit newlines, bottom positioning, gradients and decorations. The preflight now uses its wrapping function too. Actual text/decorative bounds determine clipping; unused text-block margins alone do not fail a design.
- Fully hidden/zero-opacity devices do not count as visible. A zero-opacity subheadline does not produce a clipping warning. Decorative device shadows and whitespace between letters are not collisions.
- Conservative bounds select candidate tiles. Actual mask alpha must be at least 16/255 in each layer; total contact must reach two opaque-pixel equivalents. This intentionally ignores isolated antialias dust and very faint contact. It is a deterministic readability hint, not a contrast, typography or composition score.
- Only two 256×256 scratch canvases are allocated, lazily and reused across device checks, then released. They never load/read uploaded source pixels: the rounded device interior is treated as occupied, including transparent regions of a source PNG. Export/browser memory still includes the actual full-size renders and source images.
- Intentional cross-screen bleed remains valid. Overlap is a warning: exports remain available with review-needed feedback, and the AI repair loop receives the issue while keeping its existing scope/lock constraints. No repair or provider call is triggered by inspection alone.
- This does **not** inspect screenshot UI content, decorative text elements, popout collisions, occlusion by other layers, real color contrast, every off-canvas silhouette case, 3D, or layered lifestyle backgrounds. Human/AI visual review and the pending live-provider campaign evaluation are still required.

## Verification

`core/layout-qa.test.mjs` contains eight real headless Canvas regression groups. An independent full-canvas raster oracle checks cropped/rotated/sheared/transparent/bordered shapes, while production QA uses bounded tiles. Fixtures cover actual tiny contact, rounded-corner and rotated-box empty space, inter-letter spaces and underlines, border-only contact, localization, clipping, unchanged document/context/pixels and maximum-profile scratch allocation.

The known Tidal Relay scene-two `Synthetic 02` caption at 88px now warns on its incoming device. Its exact template and exported pixels remain unchanged. `Focus` at 80px stays clear.

At this layout-QA milestone, the complete dedicated-database suite passed 321 tests (104 unit/browser/agent/MCP/frontend, 217 server/integration) with TypeScript clean and no skips. No live provider calls were used. See `IMPLEMENTATION_STATUS.md` for the latest suite count after subsequent work.

The four-export ten-screen rehearsal also passes all 183 checks:

- Report: `<local-temp>/appscreen-ten-screen-K0YS7g/report.json`.
- Baseline retains six actionable overlap warnings; copy-refined exports have none.
- All ten baseline and ten refined PNGs, plus both contact sheets, have identical SHA-256 hashes to the pre-change run in `appscreen-ten-screen-rmXDoN`. The main agent inspected the refined overview. The automated report's pending-human-review field is retained rather than rewritten.
- Final ZIP job 3.595 seconds; sampled combined Node/descendant-Chromium RSS peak 1,292,976,128 bytes. These are one local synthetic measurement, not an SLA or production/container sizing proof.

Historical rehearsal artifacts are retained unchanged. These checks do not close the live AI, provider, licensing, privacy, deletion or deployment launch gates in `IMPLEMENTATION_STATUS.md`.
