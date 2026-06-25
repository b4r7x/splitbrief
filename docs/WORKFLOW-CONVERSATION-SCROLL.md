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

The current path first turns the conversation into row-counted blocks:

- `src/features/workflow/conversation-rows/types.ts` defines `ConversationRow`, row segments, tones, and scroll inputs.
- `src/features/workflow/conversation-rows/row-format.ts` owns width-aware wrapping and compact card rows.
- `src/features/workflow/conversation-rows/event-rows.ts` maps `EngineEvent` values to row blocks.
- `src/features/workflow/conversation-rows/build.ts` builds a projection with total row count and window materializers.
- `src/features/workflow/conversation-rows/projection-cache.ts` reuses that projection while the source identity, width, streaming state, and expansion state are unchanged.
- `src/features/workflow/conversation-rows/scroll.ts` computes scroll state from the projection's `totalRows`.

The invariant is simple: `totalDynamicHeight === projection.totalRows`. The scroll math and the renderer use the same unit: a rendered terminal row, but only the visible row window is materialized.

## Rendering Path

`src/features/workflow/components/conversation-flow/flow.tsx` reads scroll state and streaming output, then calls `computeConversationRowScroll()`. That helper builds a cached row projection, asks `getScrollWindowState()` for the visible row window, and materializes only that window.

The current projection path is:

```ts
const projection = getConversationRowsProjection(input);
const rows = getConversationRowsWindowProjection({ projection, windowStart, windowEnd }).rows;
```

`src/features/workflow/conversation-rows/projection-cache.ts` caches projections by width, viewport height, expansion state, streaming state, and event content. `src/features/workflow/conversation-rows/build.ts` returns `ConversationRowBlock` records with `rowCount`, `renderableUnits`, and `createRows(windowStart, windowEnd)`, so scrolling by one row does not allocate every row in a large session. Each materialized row is rendered by `ConversationRowView` in `src/features/workflow/components/conversation-flow/row-view.tsx`. The row view has `height={1}`, `overflow="hidden"`, and `Text wrap="truncate-end"` so a row descriptor cannot expand the viewport.

Completed task summaries are pinned above the dynamic conversation window. `src/core/sections/completed-task-summary-rows.ts` returns how many completed summaries fit in the current viewport; the dynamic scroll viewport subtracts those rows before building scroll state.

## Scroll Window

`src/features/workflow/layout/scroll-window.ts` owns row-window math:

- `computeScrollMaxOffset()` computes the maximum offset after reserving scroll indicator rows.
- `getScrollWindowState()` returns `windowStart`, `windowEnd`, visible above/below counts, and optional new-event row reservation.

The above-count label is lifted into the top chrome divider. The below-count banner and the new-events banner remain part of the conversation viewport budget, so they never add rows after the fact.

## Keyboard and Commands

Conversation scrolling uses one semantic set of actions over the row window:

- `Shift+↑` / `Shift+↓` move by one rendered row.
- `PageUp` / `PageDown` move by one viewport page.
- `Home` / `End` jump to the top or bottom.
- `/scroll top`, `/scroll bottom`, `/scroll page-up`, and `/scroll page-down` provide the same actions through the runtime command path.

Conversation shortcuts do not claim `Ctrl+B` or `Ctrl+F` while the composer owns normal-mode text focus; use physical page keys or `/scroll` for conversation paging. Review panes use the same line, page, top, and bottom semantics while a review file is open, including `Ctrl+B` and `Ctrl+F` as review-page fallbacks. `/activity` and `Ctrl+A` expand or collapse the latest activity batch with hidden rows. Compact collapsed rows show the lowercase key affordance, such as `ctrl+a`.

## Projection Performance

Row projection is split from row materialization:

- `getConversationRowsProjection()` computes total row count and renderable count once for the current input identity.
- `getConversationRowsWindowProjection()` materializes only the visible window returned by `getScrollWindowState()`.
- Activity batches dedupe with `Map`, pin the latest warning/error in collapsed mode, and allocate all deduped activity rows only when expanded.
- Markdown planner text uses `markdownConversationRowsProjection()` with a bounded cache keyed by event identity and width. Appends reuse unchanged chunks and relayout the suffix; width changes invalidate the projection.

The performance regression harness is documented in [`TESTING.md`](./TESTING.md#performance-harnesses).

## Terminal Resize

Terminal size flows through `terminalSizeStore`. When `cols`, `rows`, or `isSmall` change:

- `src/features/workflow/screen.tsx` recomputes content width, prompt rows, and content height.
- `src/features/workflow/layout/snapshot.ts` and `src/features/workflow/layout/rect.ts` recompute snapshot geometry for keyboard and mouse scroll.
- `buildConversationRowsProjection()` wraps text using the current `cols`.
- `computeConversationRowScroll()` clamps the offset to the new row count.

Width changes are not cosmetic here. They can change the number of rows in `task_started`, planner text, cost prediction, validation errors, and prompt content.

## Prompt Rows

Prompt row budgeting lives in `src/features/workflow/prompt-rows.ts`.

Approval and cost prompts declare the same measured row heights that the workflow layout subtracts. The rendered prompt components use fixed heights, `overflow="hidden"`, and `flexShrink={0}`.

`src/features/workflow/layout/rect.ts` caps prompt rows to the available middle area. `WorkflowScreen` renders prompts inside a fixed-height clipped container, so a very long action description or a narrow terminal can clip the prompt instead of pushing the conversation and footer out of the screen.

## Removed Legacy Path

The old estimator-based pipeline was removed:

- `src/core/layout/conversation-scroll.ts`
- `src/core/layout/renderable-conversation.ts`
- `src/core/layout/viewport-trimming.ts`
- the obsolete `EventCard` renderer that walked events through `src/features/workflow/components/event-cards/`

The `EventCard` renderer is gone, but `src/features/workflow/components/event-cards/` is not removed: it still hosts live chrome cards — `config.tsx` (`WorkflowConfigCard`, used by `config-line.tsx` and `chrome.tsx`) and `operation-status.tsx` (`OperationStatusCard`, mounted via `agent-status-row.tsx`). Those cards render fixed chrome rows and are not part of the dynamic conversation row pipeline.

Keeping both rendering paths would create two sources of truth for event formatting and row height. The row renderer is now the single conversation rendering model.

## Tests

The key regression coverage is observable Ink output, not implementation wiring:

- `src/features/workflow/components/conversation-flow/flow.test.tsx`
  - fixed viewport never expands
  - adjacent scroll offsets move by one rendered row
  - wrapped `task_started` rows do not jump by card
  - streaming output participates in row height
  - completed summaries remain pinned outside dynamic scroll
  - new-event banner fits inside the viewport
- `src/features/workflow/conversation-rows/projection-cache.test.ts`
  - unchanged source identity reuses projections
  - mutable event and streaming content invalidates projections
  - requested windows materialize only requested rows
- `src/features/workflow/conversation-rows/build.test.ts`
  - render blocks are materialized only when they intersect the requested row window
  - compact activity rows dedupe and expose the key affordance
- `src/features/workflow/conversation-rows/markdown-rows.test.ts`
  - markdown layout is cached by identity and width
  - active cache entries survive cache-cap pressure
  - appended metadata and paragraphs match cold renders
- `src/features/workflow/conversation-rows/activity-batch-model.test.ts`
  - collapsed activity rows stay bounded
  - warnings/errors stay pinned
  - expanded mode materializes all deduped rows
- `src/features/workflow/keyboard.test.ts`
  - conversation panes support Shift+arrow, PageUp/PageDown, Home/End, and `/scroll`
  - review panes support Shift+arrow, PageUp/PageDown, Home/End, and Ctrl+B/Ctrl+F
  - `/activity` and `Ctrl+A` toggle activity
- `src/features/workflow/layout/scroll-window.test.ts`
  - banner rows stay inside the visible height
- `src/features/workflow/layout/rect.test.ts`
  - prompt rows are capped to the available middle area
- `src/core/sections/completed-task-summary-rows.test.ts`
  - completed summaries cannot reserve more rows than the viewport has

## Invariants

- Scroll units are rendered terminal rows.
- Row descriptors must render as exactly one terminal row.
- Prompt rows, completed summaries, and scroll banners are part of the row budget.
- Terminal width changes must recompute row wrapping and total height.
- Stores remain the data source; layout helpers remain pure enough to test without running the workflow engine.
