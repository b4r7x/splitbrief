# TUI visual concepts

These images are implementation references, not pixel baselines. They were generated from the
production visual catalog at `120x40` and keep the existing terminal color semantics.

See the complete set in [`overview.png`](overview.png).

## Direction

- Use the dark and light palettes of the theme (`PALETTES`).
  The theme keeps secondary text readable and reserves distinct colours for seats, severity and links.
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
| [`summary.png`](final/summary.png) | Local completion first; compact phase timing without an empty frame (historical: the closed-run block replaced the summary screen) |
| [`command-palette.png`](final/command-palette.png) | Aligned command columns, quieter groups, and one unmistakable selected row |

## Implementation map

- Shared workflow chrome: `Header`, `Rail`, `WorkflowHeader` and `WorkflowFooter`.
- Workflow split and task facts: `WorkflowBody` and `Sidebar`.
- Review layout: `ReviewView` and the approval prompt components of the workflow feature.
- Home: `HomeScreen` and the home feature.
- Summary: the summary screen is removed;
  the closed-run block replaced it. A closed run now states its outcome at the tail of its own
  transcript: `closedTranscriptBlock`, `deriveSummaryView` and the copy of the closed run.
- Command palette: `CommandPaletteOverlay` and the palette feature.

The catalog's `frame.txt` and `frame.cells.json` remain canonical for copy, terminal-cell geometry,
and behavior. Image generation can approximate glyph metrics, so implement the layout decisions
rather than tracing the bitmap literally.

The prompt set is recorded in [`PROMPTS.md`](PROMPTS.md).
