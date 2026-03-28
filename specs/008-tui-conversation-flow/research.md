# Research: TUI Conversation Flow Redesign

**Feature**: `008-tui-conversation-flow`
**Date**: 2026-03-27

## 1. Ink 5.x Layout Capabilities

**Decision**: Use manual height arithmetic with `useStdout().rows` for sticky header/footer + `overflow="hidden"` on the scrollable middle.

**Rationale**: Ink 5.2.1 has no native sticky positioning or scroll mechanism. The current `layout.tsx` already demonstrates the pattern: `paneHeight = rows - headerRows - footerRows`. This is the same approach used by Claude Code (which started on Ink). The key change is replacing the two-column pane layout with a single-column event list with `overflow="hidden"` to clip content that exceeds the available height.

**Alternatives considered**:
- `position="absolute"` — Ink supports it but provides no offset properties (top/bottom/left/right), making it useless for sticky positioning
- `<Static>` component — For non-reactive content only; headers/footers need to update with state
- OpenTUI (@opentui/react) — Better native support but young framework, migration risk
- Ink's `flexGrow` without height constraint — Content overflows without manual height management

**Key finding**: Ink's `overflow="hidden"` clips content but provides NO scroll bars. Scroll must be managed manually via state (current Pane.tsx pattern: slice visible items from array based on scrollOffset). This pattern extends directly to the new ConversationFlow component.

## 2. Callback → Event Model Mapping

**Decision**: Replace `onPlannerOutput(text)` and `onImplementerOutput(text)` with a single `onEvent(event: TuiEvent)` callback. Preserve interactive callbacks as-is.

**Rationale**: The orchestrator calls 10 different callbacks across ~40 call sites. Seven of these are unidirectional (fire-and-forget) and can become structured events. Three are bidirectional (Promise-based) and must stay as interactive callbacks because the orchestrator blocks on their return values.

**Callbacks → Events (unidirectional)**:
| Current Callback | New Event Type | Data Available at Call Site |
|-----------------|----------------|---------------------------|
| `onPhaseChange(phase)` | `planner-status` | Phase, status (running/done) |
| `onPlannerOutput(text)` | `planner-text` | Text chunk (streaming) |
| `onImplementerOutput(text)` | `implementer-text` (internal, not displayed as card) | Text chunk |
| `onTaskStart(task, idx, total)` | `task-start` | Task object, index, total |
| `onTaskComplete(task, method)` | `task-complete` | Task ID, title, method, duration |
| `onTaskRetry(task, attempt, error)` | `retry` | Task ID, attempt number, error |
| `onTaskSkipped(task, reason)` | `task-skipped` | Task ID, reason |
| `onValidationResult(task, results)` | `validate` | Per-stage pass/fail, error messages |
| `onComplete(summary)` | Keep as callback | Summary data triggers screen switch |
| `onError(error)` | `error` | Error message |

**Callbacks preserved (bidirectional)**:
| Callback | Why Interactive | Return Value |
|----------|----------------|-------------|
| `onApprovalNeeded` | Orchestrator blocks until user approves/rejects/comments | `Promise<{ approved, comment? }>` |
| `onExternalChanges` | Orchestrator blocks until user decides to proceed | `Promise<boolean>` |
| `onQuestionAsked` | Orchestrator blocks until user answers | `Promise<string>` |

**New events not in current callbacks** (must be added to orchestrator):
| Event Type | Where to Emit | Data |
|------------|--------------|------|
| `implementer-generate` | After `applyCode()` returns in implementer.ts | File path, lines added, diff text, duration |
| `git-commit` | After `gitCommit()` in orchestrator.ts | Commit message |
| `escalate` | Before escalateHint/escalateFull calls | Tier (1 or 2), hint text (after escalation returns) |

## 3. Per-Task Diff Infrastructure

**Decision**: Compute and store per-task diffs in the `implementer-generate` event by capturing file content before and after `applyCode()`.

**Rationale**: The `applyCode()` function in `implementer.ts` already reads the existing file content (line 35: `readFileSync`) before overwriting. Currently this before-content is discarded after the replacement. By capturing old content → new content, we can compute a simple line-by-line diff without any new dependencies.

**Implementation approach**:
- Before `applyCode()`: read file content (already happens)
- After `applyCode()`: read new file content
- Compute diff: simple line-by-line comparison (added/removed lines)
- Store in event: `{ file, linesAdded, linesRemoved, diff: string }` where diff is a unified-style format
- No external diff library needed — a simple `computeDiff(oldLines, newLines)` function comparing line arrays is sufficient for display purposes
- For `create` actions: diff is just all `+` lines (no old content)

**Alternatives considered**:
- `simple-git.diff()` per task — requires staging changes first, adds git operations to hot path
- External diff library (jsdiff, diff-match-patch) — unnecessary complexity for line-level comparison
- Store only line counts, no actual diff — loses the ability to show colored diff view

## 4. Real-Time Cost Tracking

**Decision**: Compute `CostBreakdown` incrementally after each task, not just at workflow end.

**Rationale**: Token usage (`TokenUsage`) is already accumulated incrementally in `WorkflowState` via `addPlannerUsage()`, `addImplementerUsage()`, `addEscalationUsage()`. The `calculateCostBreakdown()` function is pure and can be called at any time with current token state + task counts. Currently it's only called once at workflow end. Moving the call to after each task completion enables real-time cost display in the footer.

**Data available in real-time**:
- Token usage (planner, implementer, escalation) — fully tracked per-task
- Task counts (completed by local, escalated, skipped, failed) — tracked in WorkflowState
- Planner and implementer provider names — available from config
- Per-task token delta — computed via `tokenDelta()` after each task

**What needs to change**: Call `calculateCostBreakdown()` after each `onEvent({ type: 'task-complete' })` and include the result in the event, or compute it in the TUI from accumulated state.

## 5. Scroll Management for Conversation Flow

**Decision**: Virtual scroll with auto-follow, using the same pattern as the current `Pane.tsx` but applied to event cards instead of text lines.

**Rationale**: The current Pane.tsx implements a working virtual scroll: it slices an array of lines to show only the visible window, with manual scroll offset controlled by keyboard (up/down arrows). This pattern extends directly to event cards:
- Instead of `lines: string[]`, use `events: TuiEvent[]`
- Each event renders as 1-5 lines depending on type (collapsed task: 1, validation result: 2-3, expanded diff: N)
- Track total rendered height per event to compute which events are visible
- Auto-follow: scroll offset stays at 0 (bottom) unless user scrolls up

**Complexity**: Event cards have variable height (unlike text lines which are 1 row each). Two approaches:
1. **Fixed estimate**: Assume average heights per event type (e.g., planner-text: 2 lines, validate: 2 lines, task-complete: 1 line). Simpler but may clip content.
2. **Pre-render measurement**: Render all events, but only display the visible window. More accurate but potentially expensive with many events.

**Chosen**: Fixed estimate for v1. Each event type has a known max height. Collapsed tasks are exactly 1 line. Active task events are rendered individually. This avoids measuring overhead and matches the current Pane.tsx complexity level.

## 6. Terminal Resize Handling

**Decision**: Re-read `useStdout().rows` on each render cycle. Ink re-renders on stdout resize events automatically.

**Rationale**: Ink's React reconciler triggers re-renders when terminal dimensions change. The `useStdout()` hook returns current dimensions on each render. The existing `layout.tsx` already reads `rows` per render — this behavior carries forward to the new layout. No explicit resize listener needed.

## 7. Color Semantics

**Decision**: Consistent color scheme for event types.

| Event Type | Color | Rationale |
|-----------|-------|-----------|
| Planner actions | Blue | Planning/thinking |
| Implementer actions | Green | Code generation/creation |
| Validation pass | Green | Success |
| Validation fail | Red | Error |
| Escalation | Yellow | Warning/attention |
| Git commit | Gray | Infrastructure/routine |
| Error | Red bold | Critical |
| Cost savings | Cyan | Informational highlight |
| Pipeline - done | Green | Completed |
| Pipeline - current | Yellow | Active |
| Pipeline - pending | Gray | Not started |

## 8. Planner Output Handling

**Decision**: Buffer planner text chunks into paragraph blocks, emit as `planner-text` events. Also emit `planner-status` events for phase transitions.

**Rationale**: The planner streams text via `onPlannerOutput(text)` — each call is a line or partial line. Currently these are appended to a `string[]`. For the conversation flow, we need two types of planner events:
1. `planner-status`: Phase-level card (`● Planner researching...`, `● Planner spec ready`)
2. `planner-text`: Actual planner output text (buffered into reasonable chunks, not per-character)

The orchestrator already emits `onPhaseChange` for status transitions. Planner text continues to stream as individual lines but the TUI can group consecutive `planner-text` events under the active `planner-status` card.
