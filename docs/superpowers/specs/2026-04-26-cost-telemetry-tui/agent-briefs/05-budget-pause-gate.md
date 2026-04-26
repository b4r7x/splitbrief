# 05 — Budget Pause Gate

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

You are adding an 85% budget pause gate to the task loop engine. When the session cost reaches the configured pause threshold, the engine pauses, emits a `budget_paused` event, and waits for user confirmation. In headless `--json` mode, it exits immediately with a non-zero code.

## Intent

Give users a chance to decide whether to continue before their budget is fully consumed. The pause fires at 85% (configurable), distinct from the existing 80% warning and 100% hard stop. The engine side is pure logic; the TUI consumes the pause via an existing callback pattern. Headless mode fails fast instead of blocking.

## Scope

### In scope

- Add `workflow.budgetPauseThreshold` optional field to `ConfigSchema` (default 0.85).
- Add `onBudgetPaused` optional callback to `OrchestratorCallbacks`.
- Extend `checkBudget` / `enforceBudget` in `src/engine/orchestrator/budget.ts` with the 85% pause path.
- Extend `src/engine/orchestrator/task-loop.ts` to handle the new `budget_paused` stop signal.
- Update `src/cli/headless.ts` to provide `onBudgetPaused` that exits with code 1.
- Update `src/features/workflow/hooks/use-workflow-runner.ts` to wire `onBudgetPaused` via the same `inputMode.setReviewMode` pattern used by `onBudgetExceeded`.
- Emit `budget_paused` event (added to `EngineEvent` in brief 01).
- Tests for `checkBudget` at 85% threshold, `enforceBudget` pause path, and headless behavior.

### Out of scope

- Any TUI component (not an overlay — the pause uses the existing review/approval text input mode).
- Changing the existing 80% warning or 100% exceeded logic.
- "Raise budget" interactive editing (the `'raise'` response is reserved — treat as `'continue'` and document).
- Per-task budgets.

## Code Context

### Files to read first

- `src/engine/orchestrator/budget.ts` — full contents: `BudgetCheckResult`, `checkBudget`, `enforceBudget`, `BUDGET_WARNING_THRESHOLD`. Understand the existing three-state result.
- `src/engine/orchestrator/budget.test.ts` — test patterns; you must not break any existing test.
- `src/engine/orchestrator/types.ts` — `OrchestratorCallbacks`; understand the existing callback signatures.
- `src/engine/orchestrator/task-loop.ts` — where `enforceBudget` is called (after `runSingleTask`); how `budgetResult.stop` is handled. Note: `enforceBudget` fires only at task boundaries, not mid-planner-call.
- `src/engine/events/types.ts` — confirm `budget_paused` event is present (added in brief 01).
- `src/core/schemas/config.ts` — existing `workflow.maxBudget`; confirm `budgetPauseThreshold` needs to be added.
- `src/cli/headless.ts` — current `onBudgetExceeded: async () => true` pattern; you add `onBudgetPaused` here.
- `src/features/workflow/hooks/use-workflow-runner.ts` — how `onBudgetExceeded` is wired to `inputMode.setReviewMode`; mirror this for `onBudgetPaused`.

### Files to touch

- `src/core/schemas/config.ts`
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/budget.test.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/events.ts` (or wherever `publishBudgetWarning` etc. live — to add `publishBudgetPaused`)
- `src/cli/headless.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`

Do not touch any TUI component, store, or other engine file.

## Implementation Plan

### Step 1 — Add budgetPauseThreshold to ConfigSchema

In `src/core/schemas/config.ts`, inside `workflow`:

```ts
budgetPauseThreshold: z.number().min(0).max(1).optional(),
```

Default is 0.85, applied in `enforceBudget` when the field is absent. Do not add the default inside the schema (use schema `.optional()` and handle the default in the engine function).

### Step 2 — Extend OrchestratorCallbacks

In `src/engine/orchestrator/types.ts`, add:

```ts
onBudgetPaused?: ((currentCost: number, maxBudget: number) => Promise<'continue' | 'abort' | 'raise'>) | undefined;
```

This is an optional callback. Existing callers that do not provide it receive the default behavior (abort — safest default for unattended runs that do not configure the callback).

### Step 3 — Extend checkBudget

Add a new result variant:

```ts
export type BudgetCheckResult =
  | { action: 'ok' }
  | { action: 'warning' }
  | { action: 'paused' }           // NEW — at pause threshold
  | { action: 'exceeded'; shouldStop: boolean };
```

Update `checkBudget(currentCost, maxBudget, pauseThreshold = 0.85)`:

```ts
export function checkBudget(
  currentCost: number,
  maxBudget: number,
  pauseThreshold = BUDGET_PAUSE_THRESHOLD,
): BudgetCheckResult
```

Order of checks (thresholds ascending): `< 80%` → `ok`; `≥ 80% and < pauseThreshold` → `warning`; `≥ pauseThreshold and < 100%` → `paused`; `≥ 100%` → `exceeded`.

Add constant:

```ts
const BUDGET_PAUSE_THRESHOLD = 0.85;
```

### Step 4 — Extend enforceBudget

Add `pauseThreshold` to `EnforceBudgetOptions`:

```ts
pauseThreshold?: number;
```

Handle `paused` result in `enforceBudget`:

1. Publish `budget_paused` event: `publishBudgetPaused(bus, phase, currentCost, maxBudget, effectivePauseThreshold)`.
2. If `callbacks.onBudgetPaused` is defined, `await` it.
   - `'continue'` → `{ stop: false, warningEmitted: true, pauseEmitted: true }` (do not re-pause at same threshold).
   - `'abort'` → `{ stop: true, warningEmitted: true, pauseEmitted: true }`.
   - `'raise'` → log a warning (`publishWarning`) that raise is not yet implemented; treat as `'continue'`.
3. If `callbacks.onBudgetPaused` is not defined, default to `abort` (stop the workflow). This is the safe default for unattended runs.

Add `pauseEmitted: boolean` to the return type of `enforceBudget` to prevent re-pausing on subsequent task completions after a `'continue'` response.

Update `EnforceBudgetOptions` with `pauseEmitted: boolean` (parallel to `warningEmitted`). Update `task-loop.ts` to track `budgetPauseEmitted` alongside `budgetWarningEmitted`.

### Step 5 — Add publishBudgetPaused

In `src/engine/orchestrator/events.ts` (or wherever `publishBudgetWarning` is defined), add:

```ts
export function publishBudgetPaused(
  bus: EventBus,
  phase: Phase,
  currentCost: number,
  maxBudget: number,
  threshold: number,
): void {
  bus.publish({ type: 'budget_paused', ts: Date.now(), phase, currentCost, maxBudget, threshold });
}
```

### Step 6 — Update task-loop.ts

In `src/engine/orchestrator/task-loop.ts`, add `budgetPauseEmitted` state variable (parallel to `budgetWarningEmitted`). Pass it into `enforceBudget` as `pauseEmitted`. Update the handling of `budgetResult` to track `budgetPauseEmitted = budgetResult.pauseEmitted`.

Note the existing boundary: `enforceBudget` fires only after `runSingleTask` completes. The pause will not trigger mid-planner-call or mid-implementer-call. Document this in a comment in `task-loop.ts`:

```ts
// Budget pause fires only at task boundaries. A long-running planner call
// will not be interrupted mid-stream; the pause applies to the next task start.
```

### Step 7 — Update headless.ts

In `src/cli/headless.ts`, add `onBudgetPaused`:

```ts
onBudgetPaused: async (currentCost, maxBudget) => {
  process.stdout.write(
    JSON.stringify({ type: 'budget_paused', currentCost, maxBudget, threshold: pauseThreshold }) + '\n'
  );
  process.exit(1);
},
```

Where `pauseThreshold` is read from the config (the config is available at the headless call site — check how `config` is passed). If the config is not in scope, write `0.85` as the default literal and add a comment.

This is a **behavior change** from the current `onBudgetExceeded: async () => true` pattern. The existing `onBudgetExceeded` in headless.ts is left unchanged (it handles the 100% case separately).

### Step 8 — Wire TUI callback

In `src/features/workflow/hooks/use-workflow-runner.ts`, find the `onBudgetExceeded` wiring. Mirror it for `onBudgetPaused`:

```ts
onBudgetPaused: async (currentCost, maxBudget) => {
  const result = await inputMode.setReviewMode(
    `Budget ${Math.round((currentCost / maxBudget) * 100)}% reached: ${formatCost(currentCost)} of ${formatCost(maxBudget)}. continue / abort`
  );
  return result.approved ? 'continue' : 'abort';
},
```

The `'raise'` response is not exposed in this iteration (the review mode is text-based; extending it to a three-way choice is out of scope). Return `'abort'` on rejection, `'continue'` on approval.

## Validation

Tests to add in `budget.test.ts`:

- `checkBudget` returns `{ action: 'paused' }` at exactly 85%.
- `checkBudget` returns `{ action: 'paused' }` between 85% and 100%.
- `checkBudget` returns `{ action: 'warning' }` between 80% and 85%.
- `checkBudget` with custom `pauseThreshold = 0.90` returns `paused` at 90%, not 85%.
- `enforceBudget` with `paused` result and no `onBudgetPaused` callback stops the workflow.
- `enforceBudget` with `paused` result and `onBudgetPaused` returning `'continue'` does not stop; sets `pauseEmitted`.
- `enforceBudget` with `paused` result and `onBudgetPaused` returning `'abort'` stops.
- `enforceBudget` does not re-pause when `pauseEmitted` is true (second task after `'continue'`).
- `budget_paused` event is published on first pause trigger.
- Existing `checkBudget` tests continue to pass (80% warning, 100% exceeded).

## Constraints

- Do not modify the existing 80% warning or 100% exceeded code paths — only add the 85% case.
- Engine files must not import React, Ink, or `src/features/**`.
- `onBudgetPaused` is optional in `OrchestratorCallbacks`; absence must not throw.
- The headless `process.exit(1)` call must write JSON before exiting, so CI can parse it.
- The `'raise'` response must be documented as reserved, not silently ignored.

## Escalation

If `enforceBudget` return type changes break other callers in `task-loop.ts`, extend the return type additively (add `pauseEmitted` as optional) rather than changing the existing fields. If `task-loop.ts` tracks state differently from what is described, adapt the implementation to match the actual pattern.

## Evidence Requirements

- `npm test -- src/engine/orchestrator/budget.test.ts` passes with new and existing tests.
- `npm run typecheck` passes.
- `npm run lint` passes.
- A run that exceeds 85% of `workflow.maxBudget` pauses and emits `budget_paused` in `session.jsonl`.
- Headless mode with 85% threshold exceeded exits with code 1 and writes a parseable JSON line.
- `npm run test-ci` passes.
