# Workflow Conversation Scroll

The workflow conversation scrolls concrete terminal rows, not events and not estimated card heights.

This matters because Ink/Yoga resolves the final layout after text wrapping, borders, padding, terminal width, and live store state are known. A scroll model that estimates event heights separately from the renderer will drift from the terminal output.

## Problem

The previous implementation virtualized by event/card blocks. It estimated each event height, selected visible event blocks, then used a negative top margin to reveal a partially visible first block.

That broke when rendered height diverged from the estimate:

- `task_started` rows wrapped on narrow terminals.
- Running implementer events rendered live streaming output.
- Cost and approval prompts consumed dynamic row counts.
- Scroll banners and completed task summaries reserved visible rows outside the event list.
- Terminal resize changed both width wrapping and available height.

The user-visible symptom was block jumps: scrolling by one offset could reveal or hide a whole card instead of moving by one terminal row.

## Final Model

The current path first turns the conversation into one-row records:

- `src/features/workflow/conversation-rows/types.ts` defines `ConversationRow`, row segments, tones, and scroll inputs.
- `src/features/workflow/conversation-rows/row-format.ts` owns wrapping and gutter prefixes.
- `src/features/workflow/conversation-rows/event-rows.ts` maps `EngineEvent` values to concrete row records.
- `src/features/workflow/conversation-rows/build.ts` builds the full row list and renderable-event count.
- `src/features/workflow/conversation-rows/scroll.ts` computes scroll state from `rows.length`.

The invariant is simple: `totalDynamicHeight === rows.length`. The scroll math and the renderer use the same unit: a rendered terminal row.

## Rendering Path

`src/features/workflow/components/conversation-flow/flow.tsx` reads scroll state and streaming output, calls `computeConversationRowScroll()`, then asks `getScrollWindowState()` for the visible row window.

Rendering is direct:

```ts
const visibleRows = rows.slice(windowState.windowStart, windowState.windowEnd);
```

Each row is rendered by `ConversationRowView` in `src/features/workflow/components/conversation-flow/conversation-row-view.tsx`. The row view has `height={1}`, `overflow="hidden"`, and `Text wrap="truncate-end"` so a row descriptor cannot expand the viewport.

Completed task summaries are pinned above the dynamic conversation window. `src/core/layout/completed-task-summary-rows.ts` returns how many completed summaries fit in the current viewport; the dynamic scroll viewport subtracts those rows before building scroll state.

## Scroll Window

`src/core/layout/scroll-window.ts` owns row-window math:

- `computeScrollMaxOffset()` computes the maximum offset after reserving scroll indicator rows.
- `getScrollWindowState()` returns `windowStart`, `windowEnd`, visible above/below counts, and optional new-event row reservation.

Above/below banners and the new-events banner are part of the viewport budget. They never add rows after the fact.

## Terminal Resize

Terminal size flows through `terminalSizeStore`. When `cols`, `rows`, or `isSmall` change:

- `src/features/workflow/screen.tsx` recomputes content width, prompt rows, and content height.
- `src/features/workflow/layout.ts` recomputes snapshot geometry for keyboard and mouse scroll.
- `buildConversationRows()` wraps text using the current `cols`.
- `computeConversationRowScroll()` clamps the offset to the new row count.

Width changes are not cosmetic here. They can change the number of rows in `task_started`, planner text, cost prediction, validation errors, and prompt content.

## Prompt Rows

Prompt row budgeting lives in `src/features/workflow/prompt-rows.ts`.

Approval and cost prompts declare the same measured row heights that the workflow layout subtracts. The rendered prompt components use fixed heights, `overflow="hidden"`, and `flexShrink={0}`.

`src/core/layout/workflow-rect.ts` caps prompt rows to the available middle area. `WorkflowScreen` renders prompts inside a fixed-height clipped container, so a very long action description or a narrow terminal can clip the prompt instead of pushing the conversation and footer out of the screen.

## Removed Legacy Path

The old estimator-based pipeline was removed:

- `src/core/layout/conversation-scroll.ts`
- `src/core/layout/renderable-conversation.ts`
- `src/core/layout/viewport-trimming.ts`
- the obsolete `EventCard` renderer path under `src/features/workflow/components/event-cards/`

Keeping both paths would create two sources of truth for event formatting and row height. The row renderer is now the single conversation rendering model.

## Tests

The key regression coverage is observable Ink output, not implementation wiring:

- `src/features/workflow/components/conversation-flow/flow.test.tsx`
  - fixed viewport never expands
  - adjacent scroll offsets move by one rendered row
  - wrapped `task_started` rows do not jump by card
  - streaming output participates in row height
  - completed summaries remain pinned outside dynamic scroll
  - new-event banner fits inside the viewport
- `src/features/workflow/layout.test.ts`
  - terminal width changes recompute row height
  - prompt rows shrink conversation viewport
- `src/core/layout/scroll-window.test.ts`
  - banner rows stay inside the visible height
- `src/core/layout/workflow-rect.test.ts`
  - prompt rows are capped to the available middle area
- `src/core/layout/completed-task-summary-rows.test.ts`
  - completed summaries cannot reserve more rows than the viewport has

## Invariants

- Scroll units are rendered terminal rows.
- Row descriptors must render as exactly one terminal row.
- Prompt rows, completed summaries, and scroll banners are part of the row budget.
- Terminal width changes must recompute row wrapping and total height.
- Stores remain the data source; layout helpers remain pure enough to test without running the workflow engine.
