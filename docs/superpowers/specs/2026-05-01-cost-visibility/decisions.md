# Decisions

## ADR-001 - Hero Savings Is Visual Elevation, Not A New Data Path

**Status:** accepted
**Date:** 2026-05-01

### Context

`SummaryCostBreakdown` already renders savings amount, percentage, and all-planner baseline. The problem is prominence, not data availability. A new component could inadvertently duplicate calculation logic.

### Decision

The hero savings banner reuses the existing `CostBreakdown` data from `summary.costBreakdown`. It is a presentation-layer component that renders a single bold line above the existing summary layout. It does not compute new values or call pricing functions directly.

### Consequences

- No new engine-level cost logic needed.
- The hero banner gracefully degrades when `hasSavingsEstimate` is false or `pricingState` is not `priced`.
- The existing `SummaryCostBreakdown` component remains as the detail table below.

## ADR-002 - Stats Persistence Uses A Cached JSON File, Not Session-Scan

**Status:** accepted
**Date:** 2026-05-01

### Context

`aggregateSessionCosts(sessions)` in `src/core/sessions/analytics.ts` already computes cumulative savings by scanning all session JSONs. Two problems with using it directly for the `stats` command: (1) O(n) session reads on every invocation scales poorly, and (2) if sessions are pruned/GC'd the historical totals are lost.

### Decision

Persist cumulative stats in `.diptych/stats.json`. Update it atomically (read-modify-write) on `workflow_complete`. The file survives session pruning and gives O(1) reads.

### Consequences

- `diptych stats` reads one file, not N session files.
- Historical totals survive session garbage collection.
- A `diptych stats --rebuild` escape hatch can regenerate from surviving sessions if the file is corrupted.
- Requires a Zod schema at `src/core/schemas/stats.ts` for forward-compatibility.

## ADR-003 - Stats Write Uses Plain Read-Modify-Write, No Concurrency Protection

**Status:** accepted
**Date:** 2026-05-01

### Context

Two sessions completing simultaneously could race on `.diptych/stats.json`. Options: (a) advisory lock file, (b) append-only event log + lazy aggregate, (c) plain read-modify-write accepting occasional lost updates.

### Decision

Use plain synchronous read-modify-write with no lock or retry. Concurrent workflow_complete events (rare in practice since users run one workflow at a time) may lose one update. The `--rebuild` flag regenerates from surviving sessions if the file is stale or corrupted.

### Consequences

- Simplest possible implementation: ~30 lines of synchronous fs code.
- No external lock file dependency.
- No append-log compaction complexity.
- Rare concurrent finalize can lose one session's delta; `diptych stats --rebuild` is the recovery path.
- The `version` field in the schema is a schema version (always `1`), not a concurrency counter.

## ADR-004 - Cost Gate Hooks Into Existing awaitingContinue State

**Status:** accepted
**Date:** 2026-05-01

### Context

The state machine already has `awaitingContinue` and the orchestrator already pauses and resumes. The `cost_prediction` event fires after plan compilation with full deterministic cost data. A new approval gate could create a parallel pause mechanism.

### Decision

Reuse `awaitingContinue`. After `cost_prediction` fires in `standard` and `speckit` modes, the orchestrator sets `awaitingContinue = true` and renders the approval prompt. User pressing Y/Enter fires the existing continue action. User pressing N/Escape triggers abort with a `cost_rejected` reason.

### Consequences

- No new state-machine states.
- Resume via `/continue` slash command also works (existing behavior).
- The approval prompt is a presentational component consuming the same `CostPrediction` data the `CostPredictionCard` uses.
- `instant` and `quick` modes skip the gate entirely (they skip prediction per schema docs).

## ADR-005 - Cost Gate Is Mode-Aware And Pricing-Aware

**Status:** accepted
**Date:** 2026-05-01

### Context

`CostPrediction` is documented as "not present in instant/quick modes" and pricing can be `'unpriced'`, `'local'`, or `'n/a'`. The gate must not crash or block when no cost data is available.

### Decision

The cost gate no-ops (auto-approves) in these cases:

- Mode is `instant` or `quick` (no prediction event fires).
- `deterministic.totals.knownActualEstimate` is null (pricing unknown).
- Config `workflow.costGate` is explicitly `false`.

### Consequences

- Users with local/free models are never blocked.
- Modes designed for speed (instant, quick) are not slowed.
- A config knob allows power users to opt out.

## ADR-006 - Hero Banner Degrades Gracefully For Unpriced Runs

**Status:** accepted
**Date:** 2026-05-01

### Context

When `hasSavingsEstimate` is false or pricing is unavailable, rendering "$NaN saved" would be worse than showing nothing.

### Decision

The hero banner renders nothing when savings data is unavailable. Specifically:

- If `costBreakdown` is undefined: no banner.
- If `costBreakdown.hasSavingsEstimate` is false: no banner.
- If `savingsAmount <= 0`: show "No savings this run" in dim text (negative savings means the split cost more).

### Consequences

- Clean UX for local/free model users.
- No misleading numbers.
- The detail table (`SummaryCostBreakdown`) still renders for users who want to see the raw breakdown regardless of savings state.
