# Image generation prompt set

The concepts were produced with the built-in image generation tool in `ui-mockup` mode. Each
screen used its current `tui-shots` frame as the edit target.

## Shared prompt

> Improve the existing `120x40` diptych terminal screen through hierarchy, spacing, alignment,
> density, and clearer grouping only. Preserve the product, state, information, terminal
> proportions, keyboard behavior, and existing color semantics. Render only the terminal viewport
> on its default near-black background. Use crisp monospaced typography, a strict cell grid, sparse
> rules, and box-drawing only where structurally useful. Use only white, gray, planner magenta,
> implementer/accent cyan, success green, warning yellow, and error red. Do not introduce branches,
> git-like graphs, metaphors, dashboard cards, gradients, glow, blur, shadows, rounded web UI,
> browser chrome, new colors, logos, or watermarks.

## Home

> Keep a smaller centered ASCII wordmark and one centered content width. Put the current planner,
> implementer, and mode on one aligned line. Give `Recent sessions` one quiet rule and a clear empty
> row. Place shortcuts directly above a full-width composer with `Describe your feature…`.

## Planning

> Use a calm two-row header: state and runner pair first, then one straight
> `Plan · Brief · Build · Verify` rail with Plan active. Keep the transcript full width and place
> the planner label and message in a readable left-aligned column. Do not add a sidebar before tasks
> exist. Keep the composer and live-status byline at the bottom.

## Implementation

> Use the shared two-row header with Build active. Split the main area 25/75 using one subtle
> vertical rule. Align task status, routing, runner, model, and spend facts in the sidebar. Give the
> activity area a clear narrative line and a compact operation row for `Read` plus its file path.
> Keep a full-width composer and quiet byline.

## Review

> Use a 70/30 document and approval split with one vertical rule. Keep the document path and body
> on the left. Align scope and approval actions on the right; highlight only the current action with
> the existing cyan accent and use warning yellow only for the approval state. Keep shortcuts, the
> full-width composer, and `Waiting for you · Plan · git:none` at the bottom.

## Summary

> Lead with `Saved $0.01` and `1/1 tasks · 1 local`. Use a 58/42 split: aligned run facts on the
> left and a compact three-row phase breakdown on the right. Remove the oversized empty frame. Keep
> `Press enter to continue` above the full-width composer.

## Command palette

> Keep one centered overlay panel. Separate the search row with one rule. Align cursor, command,
> description, and optional shortcut columns. Treat category labels as quiet separators and use the
> current selection background plus cyan only for the selected `/help` row. Keep one fixed keyboard
> footer.
