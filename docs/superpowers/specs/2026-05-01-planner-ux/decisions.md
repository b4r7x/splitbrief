# Decisions

## ADR-001 - Heartbeat Enriches Existing Spinner Rather Than Replacing It

**Status:** accepted
**Date:** 2026-05-01

### Context

The existing `Spinner` component already shows elapsed seconds and a configurable label. Adding a wholly new progress indicator would create two competing loading UX patterns.

### Decision

Extend the `PlannerStatusCard` to show token counts and phase hints alongside the existing spinner. The spinner remains the host; heartbeat data is additive.

### Consequences

- No new top-level loading component.
- Heartbeat data flows through the existing `EngineEvent` system (new `planner_heartbeat` event type).
- The spinner still appears immediately; enrichment kicks in after the heartbeat threshold (5s default).
- Token counts come from `cost_update` events already being published; phase hints come from a new lightweight event.

## ADR-002 - Streaming Output Uses A Ring Buffer, Not Full Scroll

**Status:** accepted
**Date:** 2026-05-01

### Context

API implementers can produce thousands of lines. Rendering all of them in the TUI during generation would overwhelm terminal performance and obscure the rest of the UI.

### Decision

Show only the last N lines (default 5) of streaming output in a fixed-height box below the implementer status. The ring buffer is module-scoped state, not React state, to avoid re-render thrash on every chunk.

### Consequences

- Bounded memory and render cost.
- Users see liveness without scroll management.
- Full output remains available in the transcript buffer and session files.
- The existing `onText` callback in `spawnAndCollect` is sufficient to feed the ring buffer.

## ADR-003 - Per-Task Reject Uses Flagging, Not Inline Editing

**Status:** accepted
**Date:** 2026-05-01

### Context

The plan editor already supports delete, merge, split, and reorder. Adding inline "reject this task" as another mutation would blur the semantics of what "reject" means versus "delete."

### Decision

Add a `flaggedIds` set to the plan editor store. Users press `x` to toggle the flag on the cursor task. Press `R` to send all flagged tasks back to the planner for targeted regeneration. Flagged tasks are visually distinct (marked with a `✗` prefix).

### Consequences

- Clear two-step UX: flag, then regenerate.
- Regeneration uses the existing `regenerateTasks` path with a comment describing which tasks were rejected and why.
- Flagging is non-destructive; users can unflag before committing.
- The `R` action is uppercase to avoid accidental triggers (lowercase `r` is unused currently but reserved).

## ADR-004 - Contextual Footer Derives State From Store, Not Props

**Status:** accepted
**Date:** 2026-05-01

### Context

The current footer is two static `<Text>` lines listing all keybindings regardless of state. Making it contextual requires reading cursor position, selection state, dirty flag, and flagged-task count.

### Decision

Extract the footer into its own component (`PlanEditorFooter`) that reads from `planEditorStore` directly. It renders only the keybindings relevant to the current state.

### Consequences

- No prop drilling from the parent editor component.
- Footer updates reactively when store state changes (cursor moves, flags toggle, etc.).
- Follows existing pattern where components use `store.use(selector)` directly.
- The parent `PlanEditorComponent` becomes simpler (removes inline footer rendering).

## ADR-005 - Heartbeat Event Is Separate From Cost Update

**Status:** accepted
**Date:** 2026-05-01

### Context

`cost_update` events already carry token counts but fire only on usage deltas. The heartbeat needs to fire on a timer even when no new tokens have arrived, to provide phase hints and liveness signal.

### Decision

Add a `planner_heartbeat` event type that carries: elapsed time, accumulated tokens (from last `cost_update`), and an optional phase hint string. Published by the planning orchestrator on a 2s interval after the 5s threshold.

### Consequences

- Heartbeat is cheap (no new API calls, just re-publishes cached state on an interval).
- TUI can subscribe to heartbeat events independently of cost updates.
- Phase hints are best-effort strings derived from the planner's current activity (e.g., "analyzing repo map", "generating spec").
- If no cost_update has fired, heartbeat shows "0 tokens" which is still informative (means the API has not responded yet).

## ADR-006 - Streaming Partial Output Is Opt-In Per Runner Kind

**Status:** accepted
**Date:** 2026-05-01

### Context

Not all runner kinds produce meaningful streaming output. `cli` runners (claude-code, etc.) manage their own terminal. `shell` runners may produce binary or non-text output. Only `api` runners reliably produce text chunks via `onText`.

### Decision

Streaming partial output display is enabled only for `api`-kind implementers. The ring buffer component checks the runner kind from the `task_started` event before rendering.

### Consequences

- No visual noise for CLI-based implementers that already show their own UI.
- The `task_started` event already includes `tool` which identifies the runner.
- Future `agent-sdk` runners can opt in by setting a capability flag.
