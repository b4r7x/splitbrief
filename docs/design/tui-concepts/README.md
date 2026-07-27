# TUI visual concepts

These images are implementation references, not pixel baselines. They were generated from the
production visual catalog at `120x40` and keep the existing terminal color semantics.

See the complete set in [`overview.png`](overview.png).

## Direction

- Keep the palette from [`src/components/theme.tsx`](../../../src/components/theme.tsx): default
  terminal background, white and gray, planner magenta, implementer/accent cyan, success green,
  warning yellow, and error red.
- Improve hierarchy with spacing, alignment, restrained rules, and consistent label columns.
- Use one straight phase rail. Do not introduce branches, git-like graphs, or a visual metaphor.
- Keep the composer and keyboard hints visually stable across workflow states.
- Prefer one divider over multiple nested borders.

## Concepts

| Screen | Main change |
|---|---|
| [`home.png`](final/home.png) | One centered content axis, smaller wordmark, clearer empty state, real composer placeholder |
| [`planning.png`](final/planning.png) | Sparse planner state with a two-row header and readable streaming area |
| [`implementation.png`](final/implementation.png) | Clean 25/75 sidebar and activity split with aligned routing and cost facts |
| [`review.png`](final/review.png) | Document and approval controls side by side instead of competing vertically |
| [`summary.png`](final/summary.png) | Savings and local completion first; compact phase timing without an empty frame |
| [`command-palette.png`](final/command-palette.png) | Aligned command columns, quieter groups, and one unmistakable selected row |

## Implementation map

- Shared workflow chrome: `src/features/workflow/components/header.tsx`,
  `src/features/workflow/components/rail.tsx`, and
  `src/features/workflow/components/chrome.tsx`.
- Workflow split and task facts: `src/features/workflow/components/body.tsx` and
  `src/features/workflow/components/sidebar.tsx`.
- Review layout: `src/features/workflow/components/review-view.tsx` and the approval prompt
  components under `src/features/workflow/components/approval-prompt/`.
- Home: `src/app/screens/home.tsx` and `src/features/home/`.
- Summary: `src/app/screens/summary.tsx` and `src/features/summary/`.
- Command palette: `src/app/overlays/palette.tsx` and `src/features/palette/`.

The catalog's `frame.txt` and `frame.cells.json` remain canonical for copy, terminal-cell geometry,
and behavior. Image generation can approximate glyph metrics, so implement the layout decisions
rather than tracing the bitmap literally.

The prompt set is recorded in [`PROMPTS.md`](PROMPTS.md).
