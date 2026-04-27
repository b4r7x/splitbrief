# 01 — Cost Events and Store

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

You are extending the cost telemetry data model. This brief adds optional cache token fields to `TokenUsage`, extends `tokensStore` with per-phase cost tracking and live projection, and adds the `budget_paused` event variant to `EngineEvent`.

## Intent

Surface cache token data and per-phase cost breakdowns so that the status line (brief 03) and drill-down overlay (brief 04) have data to display. Keep the schema backward-compatible; no existing consumer breaks.

## Scope

### In scope

- Extend `TokenUsage` Zod schema with optional cache fields.
- Extend `tokensStore` state with `perPhase` cost map, `prediction`, and `projectedCost`.
- Extend `updateTokens` pure reducer to populate new fields from existing events.
- Add `budget_paused` event to `EngineEvent`.
- Update `src/stores/workflow/tokens.test.ts` (or create it if absent) to cover new reducer behavior.

### Out of scope

- Changing how any runner populates usage (that is brief 02's responsibility).
- Any TUI component (briefs 03 and 04).
- Budget enforcement logic (brief 05).
- `session.jsonl` schema changes — new fields flow through existing `cost_update` event; no new persistence format needed.

## Code Context

### Files to read first

- `src/core/schemas/tokens.ts` — current `TokenUsage` / `TaskTokenUsage` Zod schemas.
- `src/stores/workflow/tokens.ts` — `tokensStore`, `updateTokens`, `TokensState`.
- `src/engine/events/types.ts` — full `EngineEvent` union; note the `cost_update` and `cost_prediction` variants.
- `src/core/schemas/summary.ts` — `CostPrediction` schema (the `prediction` field type).
- `src/stores/workflow/tasks.ts` — to understand how `totalTasks` and `completedTaskCount` are already tracked.
- `src/stores/workflow/tokens.test.ts` (if it exists) — to understand test patterns.

### Files to touch

- `src/core/schemas/tokens.ts`
- `src/stores/workflow/tokens.ts`
- `src/stores/workflow/tokens.test.ts` (create if absent)
- `src/engine/events/types.ts`

Do not touch any other file.

## Implementation Plan

### Step 1 — Extend TokenUsage in `src/core/schemas/tokens.ts`

Add optional cache fields to `TokenUsageSchema`:

```ts
plannerCacheRead: z.number().nonnegative().optional(),
plannerCacheCreate: z.number().nonnegative().optional(),
implementerCacheRead: z.number().nonnegative().optional(),
implementerCacheCreate: z.number().nonnegative().optional(),
```

These are the only additions. Do not remove or rename existing fields. Export the updated `TokenUsage` type via the existing `z.infer<typeof TokenUsageSchema>`.

### Step 2 — Add budget_paused event to `src/engine/events/types.ts`

In the "Cost & budget" section, add:

```ts
| { type: 'budget_paused'; ts: number; phase: Phase; currentCost: number; maxBudget: number; threshold: number }
```

Place it between `budget_warning` and `budget_exceeded`. The `threshold` field records the configured pause threshold (default 0.85) so consumers can distinguish from future custom thresholds.

### Step 3 — Extend TokensState in `src/stores/workflow/tokens.ts`

Add to the `TokensState` interface:

```ts
perPhase: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cost: number }>;
perTask: Record<string, { totalTokens: number; cost: number; title: string }>;
prediction: CostPrediction | null;
completedTaskCount: number;
```

Notes:
- `projectedCost` is intentionally NOT added to state — it is a derived value computed in `use-cost-stats.ts` (brief 03) from `completedTaskCount` + `costBreakdown.totalActualCost` + `prediction.expectedCost`. Keeping it out of the reducer avoids importing pricing logic into a store.
- `perTask` key is `taskId`. Value holds total tokens only (no input/output split — `task_tokens` event does not carry split; per-phase data carries the split).

Update `initial` to include empty defaults for new fields:

```ts
perPhase: {},
perTask: {},
prediction: null,
completedTaskCount: 0,
```

Import `CostPrediction` from `../../core/schemas/summary.js`.

### Step 4 — Extend updateTokens reducer

Extend the `updateTokens` function to handle:

**`cost_update` event** — already handled for `tokenUsage`. Additionally, accumulate into `perPhase` using `event.phase` as the key. The event carries `tokenUsage` as a full snapshot, not a delta; derive the delta by diffing against the previous `tokenUsage` value in state before updating it. Accumulate `inputTokens` and `outputTokens` deltas into the phase bucket. Cache fields: accumulate `plannerCacheRead` delta when `event.phase` contains `'planning'`; accumulate `implementerCacheRead` delta when `event.phase` contains `'implementing'`.

**`cost_prediction` event** — set `state.prediction = event.prediction`.

**`task_tokens` event** — accumulate into `perTask[event.taskId]`:

```ts
if (event.type === 'task_tokens') {
  const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
  const totalTokens = event.implementerTokens + event.escalationTokens;
  return {
    ...state,
    perTask: {
      ...state.perTask,
      [event.taskId]: { ...existing, totalTokens },
    },
  };
}
```

`cost` in `perTask` cannot be computed in the reducer without pricing logic — leave it as `0` in the reducer. Brief 04 derives per-task cost display from `perTask.totalTokens` and the average cost-per-token visible in `costBreakdown` from `use-cost-stats.ts`.

**`task_started` event** — set the `title` in `perTask[event.taskId]` so the drill-down can label each row:

```ts
if (event.type === 'task_started') {
  const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
  return {
    ...state,
    perTask: { ...state.perTask, [event.taskId]: { ...existing, title: event.title } },
  };
}
```

**`task_completed` event** — already increments `localCount`/`escalatedCount`. Additionally increment `completedTaskCount`.

### Step 5 — Handoff note for use-cost-stats.ts (brief 03)

Add a comment in `tokens.ts` near the `perTask` and `completedTaskCount` fields:

```ts
// projectedCost is NOT stored in state. Brief 03 (use-cost-stats.ts) derives it:
//   projectedCost = (costBreakdown.totalActualCost / completedTaskCount) * totalTasks
// when completedTaskCount > 0, else falls back to prediction.expectedCost.
// Per-task cost in perTask is also derived in brief 04 from totalTokens and avg cost-per-token.
```

## Validation

Tests to add or extend in `tokens.test.ts`:

- `updateTokens` accumulates cache delta into `perPhase` correctly.
- `updateTokens` with two consecutive `cost_update` events with the same phase: second call accumulates the delta, not the full snapshot.
- `updateTokens` with `cost_prediction` event sets `prediction`.
- `updateTokens` with `task_completed` increments `completedTaskCount`.
- `updateTokens` handles `cost_update` with `plannerCacheRead` absent — `cacheReadTokens` stays zero.
- `updateTokens` with `task_started` event populates `perTask[taskId].title`.
- `updateTokens` with `task_tokens` event populates `perTask[taskId].totalTokens` as `implementerTokens + escalationTokens`.
- `updateTokens` with a second `task_tokens` event for the same task overwrites `totalTokens` (idempotent for retry completions).
- `TokenUsage` Zod schema accepts existing shape without cache fields (backward compat).
- `TokenUsage` Zod schema accepts shape with optional cache fields.
- `budget_paused` event is a valid `EngineEvent` (type narrows correctly with `EngineEventOf`).

## Constraints

- No classes.
- No barrels.
- ESM `.js` import suffixes.
- Engine must not import from stores. If `updateTokens` needs `totalTasks`, the call site (not the reducer) provides it.
- `TokenUsage` changes must not break existing `cost_update` or `task_tokens` event dispatch.
- Do not add `budget_paused` dispatch logic here — that is brief 05.

## Escalation

If `actions.ts` dispatch pattern makes passing `totalTasks` into `updateTokens` awkward, escalate by choosing the "remove `projectedCost` from state entirely" option documented in Step 5, and leave a comment in `tokens.ts` explaining the handoff to `use-cost-stats.ts`.

## Evidence Requirements

- `npm test -- src/stores/workflow/tokens.test.ts` passes.
- `npm run typecheck` passes with no new errors.
- `npm run lint` passes.
- No existing test files are broken by the `TokenUsage` schema extension.
