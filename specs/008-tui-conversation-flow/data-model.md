# Data Model: TUI Conversation Flow

**Feature**: `008-tui-conversation-flow`

## Entities

### TuiEvent (discriminated union)

The core data type driving the entire TUI. Each variant is self-contained — the TUI renders events without external lookups.

| Variant | Fields | Source |
|---------|--------|--------|
| `planner-status` | `phase: string`, `status: 'running' \| 'done'`, `summary?: string`, `duration?: number` | `onPhaseChange` in orchestrator |
| `planner-text` | `text: string` | `onPlannerOutput` in orchestrator |
| `task-start` | `taskId: string`, `title: string`, `index: number`, `total: number`, `file: string`, `action: 'create' \| 'modify'` | `onTaskStart` in orchestrator |
| `task-complete` | `taskId: string`, `title: string`, `method: 'local' \| 'escalated'`, `retries: number`, `duration: number` | `onTaskComplete` in orchestrator |
| `task-skipped` | `taskId: string`, `title: string`, `reason: string` | `onTaskSkipped` in orchestrator |
| `implementer-generate` | `status: 'running' \| 'done' \| 'failed'`, `model?: string`, `file?: string`, `linesAdded?: number`, `linesRemoved?: number`, `diff?: string`, `duration?: number` | New — after `applyCode()` in implementer |
| `validate` | `passed: boolean`, `stages: { tsc: boolean, lint: boolean, test: boolean }`, `error?: string`, `duration?: number` | `onValidationResult` in orchestrator |
| `retry` | `taskId: string`, `attempt: number`, `maxRetries: number` | `onTaskRetry` in orchestrator |
| `escalate` | `tier: 1 \| 2`, `hint?: string` | New — before/after escalation calls |
| `git-commit` | `message: string` | New — after `gitCommit()` in orchestrator |
| `error` | `message: string` | `onError` in orchestrator |

All events carry an implicit `ts: number` (timestamp) assigned at emission time.

### EventStream (in-memory)

Array of `TuiEvent` objects maintained in App component state. Replaces `plannerLines: string[]` and `implementerLines: string[]`.

| Field | Type | Description |
|-------|------|-------------|
| `events` | `TuiEvent[]` | Ordered list of all events emitted during workflow |
| `scrollOffset` | `number` | Manual scroll position (0 = follow latest) |
| `expandedTasks` | `Set<string>` | Task IDs whose collapsed summary is expanded |
| `expandedDiffs` | `Set<number>` | Event indices whose diff is expanded |

### CostState (derived, real-time)

Computed from `WorkflowState.tokenUsage` + task completion counts after each task.

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | `number` | Current task index |
| `totalTasks` | `number` | Total tasks in plan |
| `localRate` | `number` | Percentage completed by local implementer |
| `estimatedCost` | `number` | Total actual cost so far |
| `estimatedSavings` | `number` | Savings vs all-planner approach |
| `implementerModel` | `string` | Model name for display |

### PipelineState (derived from Phase)

Maps the current `Phase` to the 5 user-visible pipeline stages.

| Pipeline Stage | Corresponding Phases | Display |
|---------------|---------------------|---------|
| Research | `researching` | `● res` |
| Spec | `specifying`, `reviewing-spec` | `● spec` |
| Plan | `planning`, `reviewing-plan` | `● plan` |
| Implement | `implementing`, `validating-task`, `escalating` | `◉ impl` |
| Review | `final-review`, `complete` | `○ rev` |

Status indicators: `●` = done, `◉` = current, `○` = pending

## State Transitions

### Event Lifecycle

```
idle → planner-status(researching, running)
     → planner-text (streamed chunks)
     → planner-status(researching, done)
     → planner-status(specifying, running)
     → planner-text (streamed chunks)
     → planner-status(specifying, done)
     → [approval prompt — interactive, not an event]
     → planner-status(planning, running)
     → planner-text (streamed chunks)
     → planner-status(planning, done)
     → [approval prompt — interactive]
     → task-start(T1)
       → implementer-generate(running)
       → implementer-generate(done, file, diff)
       → validate(pass/fail)
       → [if fail] retry(attempt 1)
         → implementer-generate(running)
         → implementer-generate(done, file, diff)
         → validate(pass/fail)
       → [if still fail after max retries] escalate(tier 1)
         → implementer-generate(done, patched)
         → validate(pass/fail)
       → git-commit(message)
     → task-complete(T1, local, duration)
     → task-start(T2)
       → ...
     → planner-status(final-review, running)
     → planner-status(final-review, done)
     → [onComplete callback — triggers summary screen]
```

### Collapse State Machine

```
task-start → EXPANDED (all events visible)
task-complete → COLLAPSED (1 summary line)
  → user expands → EXPANDED
  → user collapses → COLLAPSED
```

### Diff Expand State Machine

```
implementer-generate(done) → COLLAPSED (summary: "→ file (+N lines)")
  → user expands → EXPANDED (full diff with colors)
  → user collapses → COLLAPSED

implementer-generate(done, after retry/escalation) → EXPANDED (auto-expanded)
  → user collapses → COLLAPSED
```
