# Decisions

## ADR-001 — Chain Reset Semantics

**Status:** accepted

### Context

A single task that writes to an out-of-scope file is common during refactors. The signal becomes meaningful only when out-of-bounds writes recur across consecutive tasks and the out-of-bounds file sets overlap.

### Decision

Chain state is maintained across tasks within a single session. After every task completes:

- **Reset:** if the task produced no out-of-scope writes (its per-task drift finding has an empty out-of-bounds file set), the active chain is reset to zero.
- **Extend:** if the task produced at least one out-of-scope write AND the out-of-bounds file set overlaps with the previous task's out-of-bounds file set by at least one file, the chain is extended by one.
- **Start new chain:** if the task produced at least one out-of-scope write but the out-of-bounds set has no overlap with the previous out-of-bounds set, the chain is reset to length 1 with the current task's out-of-bounds set as the new seed.

Skipped tasks do not affect the chain (they produce no diff, so no out-of-bounds signal is possible).

### Consequences

- Two unrelated out-of-bounds events do not accumulate into a false chain alarm.
- A refactor that touches one new file across three tasks does accumulate — the overlap requirement is one file, not strict subset.
- Overlap is determined by path-string intersection, not semantic analysis.

---

## ADR-002 — Per-Task Drift Slice

**Status:** accepted

### Context

The existing `analyzeBriefDrift` in `drift.ts` takes the full task list and the full-run changed files. It is designed for final-review, not per-task use. Chain detection needs per-task out-of-bounds file sets, which `analyzeBriefDrift` does not produce.

### Decision

Brief 02 defines a new standalone function in `src/engine/orchestrator/drift-chain.ts`:

```ts
export function computePerTaskOutOfBounds(
  task: Task,
  taskChangedFiles: string[],
): Set<string>
```

This function takes a single task and the files changed during that task's implementation and returns the set of files that are either:
- listed in `task.scope.outOfBounds` pattern matches among `taskChangedFiles`, or
- not listed in `task.file` (i.e., `taskChangedFiles` that are not the task's target file).

This is a strict subset of `analyzeBriefDrift` logic applied to one task. It does not call `analyzeBriefDrift`. It does not modify `drift.ts`.

### Consequences

- Chain analysis can operate per-task without rewriting the existing whole-run detector.
- Per-task changed files must be tracked in the task loop (already available via `implementer_generate_done` events or by diffing git state before and after each task).
- `computePerTaskOutOfBounds` is pure and trivially testable.

---

## ADR-003 — Score Formula (Deterministic, No ML)

**Status:** accepted

### Context

Scoring must be cheap, predictable, and testable. No LLM calls, no statistical models.

### Decision

The chain score is:

```
score = clamp(
  min(chain.length, 5) / 5 * 0.3
  + overlap_ratio * 0.5
  + min(uniqueNewFiles, 10) / 10 * 0.2,
  0, 1
)
```

Where:

- `chain.length` is the number of consecutive tasks in the current chain. Capped at 5 for the purpose of the length term so that a very long chain cannot by itself exceed 0.3.
- `overlap_ratio` is the count of files that appear in both the current task's out-of-bounds set and the previous task's out-of-bounds set, divided by the union size of those two sets. Range is `[0, 1]`.
- `uniqueNewFiles` is the count of distinct out-of-bounds files that have appeared anywhere in the current chain (running total). Capped at 10 to bound the contribution of the new-files term.

Each weighted term is bounded within `[0, weight]` before summing, and the final score is clamped to `[0, 1]`.

### Consequences

- A chain of length 1 with 100% overlap (impossible on a chain of 1 by ADR-001, but for completeness) would score `0.06 + 0.5 + 0.02 = 0.58`, below the default threshold of 0.6.
- A chain of length 2 with 100% overlap and 2 unique files scores `0.12 + 0.5 + 0.04 = 0.66`, above threshold.
- A chain of length 3 with 80% overlap and 3 unique files scores `0.18 + 0.4 + 0.06 = 0.64`, above threshold.
- A chain of length 3 with 0% overlap never forms (ADR-001 would reset), so the formula is internally consistent.
- Score is deterministic given the same inputs.

---

## ADR-004 — Emit Threshold (Default 0.6, Configurable)

**Status:** accepted

### Context

Not every chain warrants a user-visible event. The threshold separates noise from signal.

### Decision

The `drift_chain_detected` event is published when `score >= threshold`. The default threshold is `0.6`. The threshold is configurable via `config.workflow.driftChainThreshold` (a new optional field in the existing workflow config schema, type `number`, range `0..1`). If absent, `0.6` is used.

### Consequences

- Users who work in monorepos where cross-file edits are normal can raise the threshold.
- The threshold is read at analysis time from `WorkflowContext.config`; no separate config file is introduced.
- Lowering the threshold below 0.3 is not validated (it would fire on almost every chain of length >= 2 regardless of overlap), but no hard guard is added — the user is responsible.

---

## ADR-005 — Storage Layout

**Status:** accepted

### Context

`drift-report.json` is written once at the end of the run. Chain state needs to be written incrementally, after each task, so that an interrupted run does not lose chain data.

### Decision

The chain state is persisted to:

```
.diptych/sessions/<id>/drift-chains.json
```

alongside the existing `drift-report.json`. The file contains the full `DriftChainState` (current active chain + list of all emitted chains). It is written with `SECURE_FILE_MODE` from `src/lib/fs.ts`, matching the drift.ts pattern. The path constant `DRIFT_CHAINS_FILE = 'drift-chains.json'` is added to `src/core/paths.ts`.

If the file is absent when the chain analysis starts (e.g., first task of a session), the chain state is initialized to empty. The file is read and written atomically using `writeFileSync` (same pattern as `drift.ts`).

### Consequences

- An interrupted session can be inspected for partial chain state.
- `buildSummary` reads `drift-chains.json` the same way it reads `drift-report.json`.
- No migration is needed for sessions that predate this spec (absence = no chain data).

---

## ADR-006 — Event Shape

**Status:** accepted

### Context

The existing `drift_report` event is published once at final-review. A separate chain event is needed at task completion time so the UI can display it in-flight.

### Decision

Add a new event variant to `EngineEvent` in `src/engine/events/types.ts`:

```ts
| {
    type: 'drift_chain_detected';
    ts: number;
    phase: Phase;
    chainLength: number;
    score: number;
    threshold: number;
    uniqueOutOfBoundsFiles: string[];
    representativePath: string;
  }
```

Where `representativePath` is the most frequently occurring out-of-bounds path across the chain (or the first alphabetically on a tie). It is used for the summary line ("Drift chain: 3 tasks writing to /unrelated/area, score 0.78").

The event is published only when `score >= threshold` (ADR-004). It is not published on every chain update.

### Consequences

- The existing `drift_report` event is unchanged.
- `drift_chain_detected` can fire multiple times in a session (once per chain that crosses the threshold).
- UI components that subscribe to events receive the chain event and can render it; this spec does not add a new UI component (the summary line is enough).

---

## ADR-007 — When Chain Analysis Runs

**Status:** accepted

### Context

The task loop in `src/engine/orchestrator/task-loop.ts` calls `runSingleTask` for each task. Tasks can end in several ways: success (local), escalated, failed, or skipped. Chain analysis must not run after skipped tasks (no diff produced).

### Decision

Chain analysis runs **after every non-skipped task completion**, called from `task-step.ts`. Specifically:

- After `persistTaskEvidence` for the `'local'` path (task succeeded locally).
- After `retryAndRecord` returns, for both `completed: true` (escalated) and `completed: false` (failed).

Skipped tasks (`SKIP_TASK` transition in task-loop.ts) do not trigger chain analysis.

Chain analysis is called inside a `try/catch` that publishes a `warning` event on failure. It must never throw and must never abort the task loop.

### Consequences

- Failed tasks are included in chain analysis because they can still produce out-of-bounds writes (a failed task that left partial changes is already flagged by `analyzeBriefDrift` with `failed_task_with_diff`).
- Analysis runs synchronously within the task step; the chain state file is written before the next task begins.
- Per-task changed files are collected from `git diff --name-only` scoped to the task's start timestamp (matching the existing pattern in `drift.ts`).

---

## ADR-008 — Approved Out-Of-Bounds Writes

**Status:** accepted

### Context

Users can explicitly approve out-of-scope file writes during a run (e.g., by answering a clarification question or by the planner instructing a known cross-file refactor). These writes should not count as chain evidence.

### Decision

If a task's `scope.approvedOutOfBounds: string[]` field lists a file path (exact match or substring match, same logic as `outOfBoundsPatterns` in `analyzeBriefDrift`), that file is excluded from the per-task out-of-bounds set before chain analysis.

`scope.approvedOutOfBounds` is a new optional field added to the `Task` schema's `scope` object in this spec (brief 02). It does not exist in the current schema. The addition is backward-compatible (optional field; existing serialized tasks without it deserialize cleanly). If absent or empty, no files are excluded. The chain analysis function (`analyzeDriftChain`) receives a `perTaskOutOfBounds: Set<string>` that has already been filtered; it does not need to know about approval semantics directly.

### Consequences

- Approved writes are filtered in `computePerTaskOutOfBounds` before being passed to `analyzeDriftChain`.
- The `Task` schema gains one new optional string array field (`scope.approvedOutOfBounds`).
- No new event type is needed for this approval path.

---

## ADR-009 — Interaction With Manual Approval Gates

**Status:** accepted

### Context

`standard` and `speckit` modes have approval gates where users can reject or re-plan. After a re-plan, the task list changes. The chain state should be reset because the implementer's context has changed.

### Decision

Chain state is reset (all chain data cleared) whenever a `rewind_to_spec` or `rewind_to_plan` event is published. The orchestrator integration (brief 03) subscribes to these events or checks the transition type and resets the chain state file.

In practice, rewinding replaces the task list entirely, so any accumulated chain data references task IDs from the old task list. Resetting is safe and avoids false positives on the new run.

### Consequences

- A chain that was accumulating before a re-plan does not carry over.
- Resetting is cheap: write an empty `DriftChainState` to `drift-chains.json`.
