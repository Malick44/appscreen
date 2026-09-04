# AppScreen — Precision Studio design direction

## Product character

AppScreen is a focused production workspace, not a playful generator. The redesign should feel calm, exact, and quietly premium: a tool people trust for final marketing assets.

The signature element is a **proofing frame** around the artwork. Output dimensions, language, and subtle crop marks turn the canvas into an intentional review surface and distinguish AppScreen from generic dashboard editors.

## Foundations

- **Night:** `#0B0D12` — main workspace
- **Panel:** `#121722` — navigation and inspector
- **Raised:** `#1A2130` — menus, selected surfaces, inputs
- **Rule:** `#2B3445` — borders and separators
- **Paper:** `#F2F5F8` — primary text
- **Mist:** `#9BA6B8` — secondary text
- **Studio violet:** `#8178FF` — selection, focus, and primary action
- **Success:** `#42C98B`; **warning:** `#E8B45E`; **danger:** `#F06A73`

Use Geist for product UI, Geist Mono for dimensions and technical values, and Bricolage Grotesque only for the wordmark and occasional editorial moments. Controls remain flat; gradients belong to user artwork, not interface chrome.

Spacing follows a 4px base with 8, 12, 16, 24, and 32px as the main rhythm. Corners are 8px on controls, 12px on panels, and 16px on large dialogs.

## Workspace structure

1. **Global bar:** identity, local-save confidence, and export actions.
2. **Screens rail:** project, locales, screen sequence, add/import actions, and output size.
3. **Proofing stage:** artwork remains dominant with output metadata kept outside the composition.
4. **Inspector:** Background, Device, Text, Elements, and Popouts use the current information architecture while gaining clearer hierarchy.
5. **Mobile navigation:** canvas-first, with Screens and Design opening as focused drawers and Export remaining one tap away.

## Buttons and feedback

Buttons use five roles:

- **Primary:** solid violet, reserved for the single next action in a region.
- **Secondary:** raised neutral surface for useful alternatives.
- **Quiet:** transparent navigation and low-emphasis utilities.
- **Icon:** square, always with an accessible name and tooltip when unfamiliar.
- **Destructive:** red only for irreversible actions and confirmations.

The visible control height is 36–40px, with a minimum 44px touch target on coarse pointers. Hover changes one signal (surface or border). Pressed state moves down 1px for 80–100ms. Keyboard focus is a 2px violet ring with an outer workspace-colored gap. Disabled controls reduce contrast without removing their shape.

Loading states keep button width stable, replace the leading icon with a spinner, and use a verb such as “Exporting…”. Success is shown in place when the result is visible; lightweight actions use the live save/status area. Errors stay near the action and remain until the user changes the input or retries. Destructive actions require explicit copy and never borrow the primary action color.

## Responsive behavior

- **Wide desktop (≥1180px):** permanent screens rail and inspector.
- **Compact desktop/tablet (900–1179px):** narrower rails and reduced stage padding.
- **Phone/small tablet (<900px):** canvas fills the workspace; Screens and Design become drawers; bottom navigation provides stable thumb access.

Motion is restrained to panel movement and direct manipulation. Every transition honors `prefers-reduced-motion`, and no control uses `transition: all` in the redesign layer.

## Guardrails

- Preserve canvas rendering, export fidelity, persistence, localization, and current control semantics.
- Keep labels visible where an icon is ambiguous.
- Do not use red for normal confirmation.
- Avoid decorative cards inside cards and avoid gradients in application controls.
- Verify keyboard focus, empty/loading/success/error/disabled states, and 320px-wide layouts before release.
