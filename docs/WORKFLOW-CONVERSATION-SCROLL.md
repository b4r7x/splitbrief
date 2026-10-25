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
- `src/features/workflow/conversation-rows/row-format/` owns width-aware wrapping and compact card rows (`text.ts`, `rows.ts`, `label-card.ts`, `card-block.ts`).
- `src/features/workflow/conversation-rows/event-rows/dispatch.ts` maps `EngineEvent` values to row blocks (`visibility.ts` for silent types, `planner-text.ts` and `execution.ts` for specialized row builders).
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

A closed run's ledger is part of this transcript, not a second scroller: `closedTranscriptBlock`
(`src/features/workflow/closed/block.tsx`) is appended to the projection's block list after the run's
own events (`tail`, `computeConversationRowScroll`), so `Closed ─ / Briefs ─ / Files ─ / Run ─`
scrolls with the events above it under one offset. Its rows carry a prebuilt `node` rather than
segments, and each is one line, so the row count the scroll model charges is exact. It registers
zero renderable units — it is not an event the run emitted, so it never counts toward the
`N new events` banner.

Settled sections stay in the transcript in event order. `groupEventsIntoSections` groups each brief, Plan stage and review attempt. `walkTranscript` yields the heading, then the retained body rows. A review's result follows its body; a review with no visible body shows only its result. One blank row separates sections. `settledRowBlock` renders the brief and Plan headings and the review result with the existing `TaskSummary` mark and detail run. Headings have no disclosure glyph. Sections can use compact rows. They do not hide their body when they settle.

A settled brief heading carries the mark, id, title, file, method and duration. The brief heading carries the target label `path (action) · +N files`. The `(action)` note drops first. The `+N files` count stays with its path, and the path shortens before the count goes. The count drops only with the path. `TaskSummary` and `fitDetailRun` fit the file to the heading width. The crew row does not repeat the target. The crew row follows the heading directly, on the running header's continuation column. It uses the same tool, model and effort words as the running header. One blank row separates the crew metadata from the body. Failed and skipped briefs use the same layout. A brief skipped before `task_started` has no crew metadata.

The body keeps narration, compact activity batches, validation, checks, `full_suite` rows, the result and diff card, and the hand-back report. It also keeps consult rows, retries, recovery rows, warnings and errors. It drops the transient `implementer_generate_running` hint and its streaming preview. It drops a terminal skip or failure label that the heading already states. A compact activity batch keeps its header, its newest three items and `+N more · ctrl+a`. Settled brief, Plan and Review activity headers use `textDim`. Running activity headers keep their seat tone.

A settled Plan keeps the request, questions and answers, narration, activity, plan and tasks artifact cards, plan-check rows, warnings and recovery. A settled Review keeps reviewer-check decisions, plan-check and reviewer-check command rows, drift, activity, narration, correction answers and recovery. `review_started` opens the review segment; `review_completed` settles its result with scope, task anchor, verdict, findings and duration. Task reviews read `Review T001`; final ordinals count final reviews only. A following `review_fix_started` names the fix briefs in that review's result. A fix cycle after `workflow_complete` is Apply's: it stays out of the passed review, and the next final review counts it. A segment without `review_started` derives its verdict from `workflow_complete.review` or `review_fix_started`. An interrupted review settles with a stop marker and its time from `review_started` to its last recorded event. `workflow_resumed` closes the earlier attempt and draws a continuation row before the next attempt. The parked interval belongs to neither attempt. A running review stays live; a completed review with `no-verdict` or `stopped` settles with a failure or stop marker. The review lifecycle events draw no direct rows. Rows after the last result stay live, including recovery prompts.

The scroller shows settled sections before the live stage and running brief. Pending briefs keep their existing `Pending n` block below the scroller. When only one pending row fits, the heading includes `+N more` for the hidden briefs. A skipped brief settles on `task_skipped`, even when a pre-hook denied it before `task_started`. Build rows between two briefs join the earlier brief up to the first `consult_answered` event for the next brief. When the next brief is skipped before it starts, its first `recovery_prompted` event also ends the earlier brief, whichever of the two comes first. Rows from that event join the next brief. Run-level build rows join the first brief and stay in its body. The operator's consult answer uses a `user_message` event with `qa`. The shared answered-questions row block renders `You → <answer>` beneath the question. A bare Enter records and renders the default answer.

Done brief rows in both the transcript and closed ledger use `TaskSummary` and its shared `fitDetailRun`. The closed ledger uses the same target label as the brief heading. The method and duration stay whole while space permits. If metadata leaves no room for the task id and a title fragment, the row drops metadata first. The count keeps its room while the path shortens. A path shortened to a bare `…` drops with its count. A stopped brief in the closed ledger fits the same way, and its `stopped` word keeps its room. Retries go before the path shortens by whole middle directory segments (`testing/…/projections.ts`), then to `…/projections.ts` and the bare filename. Only a filename that cannot fit loses characters. Path elision lives with the picker label rule in `src/utils/display-text.ts`.

Check-row statuses `not run` and `chose none` join their words with a non-breaking space (`\u00a0`), so wrapping at 60 columns keeps each phrase whole. Running checks use `formatElapsedClock` in the build block and byline (`running 10:02`, `running 0:35` in the block). Finished-row durations keep `2m 0s` or `14.0s`.

## Scroll Window

`src/features/workflow/layout/scroll-window.ts` owns row-window math:

- `computeScrollMaxOffset()` computes the maximum offset from content height and viewport height.
- `getScrollWindowState()` returns `windowStart`, `windowEnd`, and the visible above/below line counts.

Scroll banners ride the chrome dividers: the above-count label renders on the header divider, and the below-count and new-events labels render on the footer divider (`N lines below · ↓ N new events`). The transcript window owns every viewport row and reserves nothing for in-flow banners.

## Keyboard and Commands

Conversation scrolling uses one semantic set of actions over the row window:

- `Shift+↑` / `Shift+↓` move by one rendered row.
- `PageUp` / `PageDown` move by one viewport page.
- `Home` / `End` jump to the top or bottom.
- `/scroll top`, `/scroll bottom`, `/scroll page-up`, and `/scroll page-down` provide the same actions through the runtime command path.

Conversation shortcuts do not claim `Ctrl+B` or `Ctrl+F` while the composer owns normal-mode text focus; use physical page keys or `/scroll` for conversation paging. Review panes use the same line, page, top, and bottom semantics while a review file is open, including `Ctrl+B` and `Ctrl+F` as review-page fallbacks. `/activity` and `Ctrl+A` toggle the latest expandable activity batch in the whole transcript, including settled sections. Older activity disclosures stay clickable. `Ctrl+D` toggles the latest expandable diff in the whole transcript. Older diff disclosures stay clickable. Compact rows show the lowercase key affordance, such as `ctrl+a` or `ctrl+d`.

An older run parked at `reviewing-briefs` displays its review document as markdown.
Keyboard and wheel scrolling use the markdown frame and overflow rows, as for every other review document.
Saved brief-load errors reserve no rows in this pane.

`queuedBriefs` in `src/features/workflow/conversation-rows/queued-briefs.ts` supplies the queued tasks
to both `ConversationFlow` and the keyboard and mouse snapshot. It excludes the running brief,
even when recovery resets it to `pending`. It returns no queued tasks while the sidebar shows tasks
or a closed ledger occupies the transcript tail. The snapshot reads the tail measurements from
`transcriptTailStore`. Both callers pass the resulting count to `splitConversationViewport`.

## Projection Performance

Row projection is split from row materialization:

- `getConversationRowsProjection()` computes total row count and renderable count once for the current input identity.
- `getConversationRowsWindowProjection()` materializes only the visible window returned by `getScrollWindowState()`.
- Activity batches keep one row per activity identity with `Map`. Tool start, input and completion updates replace that tool use's row; two tool uses with the same displayed text stay distinct. Collapsed mode shows the newest three entries in event order, and pins no warning or error: the header counts the warnings and errors. Expanded mode allocates all activity rows. Session and protocol activities contribute no rows, update counts or disclosure entries. A shell tool call that names no command contributes no row or count either; the row of the same call that names its command stays.
- Activity producers preserve sanitized text up to the payload limits (512 characters for labels, 2048 for targets and partials). The row formatter fits that text to the current terminal width, so widening the terminal reveals more of a command or path.
- Planner markdown and direct-writer narration with `content: 'markdown'` use the shared markdown core and `markdownConversationRowsProjection()`. Direct-writer prose stays dim. Inline code and file links keep their markdown styles. Extracted-code output and unmarked implementer text stay plain dim text. Hand-back reports split into one report row for marked markdown and unmarked implementer text. Their narration keeps the event's markdown or plain format. The bounded cache keys include event identity and width. Appends reuse unchanged chunks and relayout the suffix. Width changes invalidate the projection. Settled sections keep their markdown cache entries.

The performance regression harness is documented in [`TESTING.md`](./TESTING.md#performance-harnesses).

## Terminal Resize

Terminal size flows through `terminalSizeStore`. When `cols`, `rows`, or `isSmall` change:

- `src/app/screens/workflow.tsx` recomputes content width, prompt rows, and content height.
- `src/features/workflow/layout/snapshot.ts` and `src/features/workflow/layout/rect.ts` recompute snapshot geometry for keyboard and mouse scroll.
- `buildConversationRowsProjection()` wraps text using the current `cols`.
- `computeConversationRowScroll()` clamps the offset to the new row count.

Width changes are not cosmetic here. They can change the number of rows in `task_started`, planner text, cost prediction, validation errors, and prompt content.

## Prompt Rows

Prompt row budgeting lives in `src/features/workflow/prompt-rows/workflow.ts`.

Approval and cost prompts declare the same measured row heights that the workflow layout subtracts. The rendered prompt components use fixed heights, `overflow="hidden"`, and `flexShrink={0}`.

The screen measures the ready result menu with `resultMenuHeight`. It publishes that measurement through `resultMenuStore`, including Apply confirmation rows. The scroll snapshot reads the same measurement. The screen clears it when the menu closes or the screen unmounts.

`src/features/workflow/layout/rect.ts` caps prompt rows to the available middle area. `WorkflowScreen` renders prompts inside a fixed-height clipped container, so a very long action description or a narrow terminal can clip the prompt instead of pushing the conversation and footer out of the screen.

## Removed Legacy Path

The old estimator-based pipeline was removed:

- `src/core/layout/conversation-scroll.ts`
- `src/core/layout/renderable-conversation.ts`
- `src/core/layout/viewport-trimming.ts`
- the obsolete `EventCard` renderer and deleted workflow chrome modules (`event-cards/`, `agent-status-row`, `config-line`, `pipeline-bar`, and related cost status-line cards)

Workflow chrome (header, rail, feedback, footer) now lives in `src/features/workflow/components/{chrome,header,rail,input-footer}.tsx`. Dynamic conversation output is rendered exclusively through `conversation-flow/` and `conversation-rows/`.

## Tests

The key regression coverage is observable Ink output, not implementation wiring:

- `src/features/workflow/components/conversation-flow/flow.test.tsx`
  - fixed viewport never expands
  - adjacent scroll offsets move by one rendered row
  - wrapped `task_started` rows do not jump by card
  - streaming output participates in row height
  - settled sections render a heading, retained body rows and one blank row in event order
  - completed briefs keep metadata, activity, validation, reports, warnings and recovery
  - settled Plan and Review sections keep plan-check and reviewer-check rows
  - new-event counts surface through the chrome label, not viewport rows
- `src/features/workflow/conversation-rows/projection-cache.test.ts`
  - unchanged source identity reuses projections
  - mutable event and streaming content invalidates projections
  - requested windows materialize only requested rows
- `src/features/workflow/conversation-rows/build.test.ts`
  - render blocks are materialized only when they intersect the requested row window
  - compact activity rows dedupe and expose the key affordance
  - settled brief bodies drop transient hints and duplicate terminal labels
  - settled headings show the file once, followed directly by the crew row and then one blank row
  - settled activity headers use `textDim`; live activity headers keep their seat tone
- `src/features/workflow/conversation-rows/event-rows/planner-text.test.ts`
  - marked direct-writer narration renders dim markdown with styled inline code and file links
  - extracted-code output and unmarked implementer narration stay plain dim text
  - unmarked hand-backs retain plain narration and one report row when older runs replay
  - marked hand-backs retain dim markdown narration and one report row
- `src/features/workflow/layout/snapshot.test.ts`
  - rendered scroll ends and mouse rows agree after a recovery resets the running brief to pending
  - closed runs below the sidebar breakpoint reserve no queued rows
  - ready result menus and Apply confirmations reduce the snapshot and screen transcript by the same row count
- `src/features/workflow/hooks/use-keys.test.tsx`
  - keyboard and wheel scrolling ignore stale brief-load errors and reach the last markdown row in an older brief review
- `src/features/workflow/conversation-rows/markdown-rows.test.ts`
  - markdown layout is cached by identity and width
  - active cache entries survive cache-cap pressure
  - appended metadata and paragraphs match cold renders
- `src/features/workflow/conversation-rows/activity-batch-model.test.ts`
  - collapsed activity rows stay bounded
  - collapsed rows are the newest entries in event order
  - expanded mode materializes all deduped rows
- `src/features/workflow/keyboard.test.ts`
  - conversation panes support Shift+arrow, PageUp/PageDown, Home/End, and `/scroll`
  - review panes support Shift+arrow, PageUp/PageDown, Home/End, and Ctrl+B/Ctrl+F
  - `/activity` and `Ctrl+A` toggle the latest expandable activity batch in the whole transcript
  - `Ctrl+D` toggles the latest expandable diff in the whole transcript
- `src/features/workflow/layout/scroll-window.test.ts`
  - the window spans the full visible height; banners ride the chrome dividers
- `src/features/workflow/layout/rect.test.ts`
  - prompt rows are capped to the available middle area
- `src/features/workflow/conversation-rows/transcript-walk.test.ts`
  - settled sections yield their heading and retained body in event order
- `testing/visual/workflow-fixtures.test.tsx`
  - completed brief bodies stay reachable before the running brief at every required viewport
  - plan-check and reviewer-check rows stay reachable after a ready verdict
  - split file links render their label without raw markdown
  - scrolling traverses to required content without a fixed row limit

## Invariants

- Scroll units are rendered terminal rows.
- Row descriptors must render as exactly one terminal row.
- Prompt rows and queued rows are part of the row budget; settled rows scroll inside the transcript; scroll banners live on the chrome dividers.
- Each settled section renders its heading, retained body and one blank row before the next section.
- Settling a brief or stage does not hide its body. Only transient hints and duplicate terminal labels leave a settled brief.
- A settled brief heading owns its title and file path. The crew row follows it directly. Headings carry no disclosure glyph.
- Settled brief, Plan and Review activity headers use `textDim`. Running activity headers keep their seat tone.
- Activity and diff shortcuts search the whole transcript. Older disclosures stay clickable.
- Direct-writer narration with `content: 'markdown'` uses the shared markdown core with dim prose, including hand-back narration. Extracted-code output and unmarked implementer narration stay plain dim text. Unmarked hand-back reports still split into one report row.
- Terminal width changes must recompute row wrapping and total height.
- Stores remain the data source; layout helpers remain pure enough to test without running the workflow engine.
