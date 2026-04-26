# Cost Telemetry TUI — 2026-04-26

> **Status:** draft spec.
> **Scope:** always-visible cost status line, per-step cost drill-down overlay, and configurable hard-pause budget gate with headless fail-fast behavior.
> **Out of scope:** pricing data accuracy (marked VERIFY), new runner implementations, changes to `session.jsonl` structure, per-task budgets.

## Purpose

diptych already tracks token usage and computes costs, but this information is buried. A user cannot see in real time how fast the session is burning budget, which phase is most expensive, or whether cache hits are reducing costs. This spec surfaces that data without adding ceremony.

The three pillars are:

1. **Always-visible status line** — a persistent top line on every screen: `[mode] · spent $X.YY · proj $Y.YY · budget $Z · NN% plan · cache NN%`. Updated live from the cost store.
2. **Per-step drill-down** — behind the `$` keybinding, an overlay that shows horizontal bars per planner phase and per implementer task. Per-phase bars include input vs output token split (output is typically 3–5x more expensive) and cache-hit %. Per-task bars show total tokens only (the `task_tokens` event carries no input/output split). Cache-hit % renders `n/a` where the runner does not expose it.
3. **Hard auto-pause gate** — at 85% of a configured session budget, pause the task loop, emit a `budget_paused` event, and wait for user confirmation. Headless `--json` mode fails fast instead of blocking.

## What Already Exists — Read Before Implementing

The existing infrastructure is substantial. Every brief must extend these symbols, not reinvent them.

| Existing symbol | File | What it does |
|---|---|---|
| `workflow.maxBudget` | `src/core/schemas/config.ts:50` | Per-session budget config (already validated) |
| `budget_warning` event | `src/engine/events/types.ts:76` | Fires at 80% of budget |
| `budget_exceeded` event | `src/engine/events/types.ts:77` | Fires at 100% of budget |
| `checkBudget` / `enforceBudget` | `src/engine/orchestrator/budget.ts` | Engine budget logic; fires only at task boundaries |
| `onBudgetExceeded` callback | `src/engine/orchestrator/types.ts:16` | TUI gate; headless returns `true` (continue) today |
| `cost_update` event | `src/engine/events/types.ts:74` | Carries `TokenUsage` on every planner usage update |
| `cost_prediction` event | `src/engine/events/types.ts:75` | Carries `CostPrediction` after planning |
| `tokensStore` | `src/stores/workflow/tokens.ts` | Tracks `tokenUsage`, local/escalated counts |
| `CostBreakdown` schema | `src/core/schemas/summary.ts` | Full per-provider cost breakdown |
| `calculateCostBreakdown` | `src/engine/providers/pricing.ts` | Computes `CostBreakdown` from `TokenUsage` |
| `CostFooter` component | `src/features/workflow/components/cost-footer.tsx` | Bottom bar: Task N/M · mode · queue · cost |
| `cost-display.tsx` | `src/features/workflow/components/cost-display.tsx` | Inline cost display widget |
| `use-cost-stats` hook | `src/features/workflow/hooks/use-cost-stats.ts` | Derives display values from stores |
| `OverlayType` union | `src/stores/navigation/router.ts:18` | Overlays pattern: `none \| help \| sessions \| ...` |

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview, collision map, done criteria. |
| 2 | `decisions.md` | Numbered ADRs for every non-obvious choice. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and shared invariants. |
| 4 | `agent-briefs/01-cost-events-and-store.md` | Extend `TokenUsage` schema and `tokensStore`. |
| 5 | `agent-briefs/02-pricing-catalog.md` | Cache-read pricing, override pattern. |
| 6 | `agent-briefs/03-status-line-component.md` | Persistent top status line, all screens. |
| 7 | `agent-briefs/04-cost-drilldown-screen.md` | Drill-down overlay + `$` keybinding. |
| 8 | `agent-briefs/05-budget-pause-gate.md` | 85% pause gate, headless fail-fast. |

## Change Set

| # | Brief | Goal | Key files touched |
|---|:---:|---|---|
| 01 | Cost Events & Store | Extend `TokenUsage` with optional cache fields; extend `tokensStore` to track per-phase cost and cache stats | `src/core/schemas/tokens.ts`, `src/stores/workflow/tokens.ts`, `src/engine/events/types.ts` |
| 02 | Pricing Catalog | Document cache-read pricing extension, per-runner support matrix, override pattern | `src/engine/providers/pricing-resolver.ts`, `src/engine/providers/pricing.ts` |
| 03 | Status Line | Always-visible top line; extend `CostFooter` or create sibling; subscribe to extended cost store | `src/features/workflow/components/cost-footer.tsx` or `cost-status-line.tsx` |
| 04 | Drill-Down | New `cost-drilldown` overlay, per-phase bars, input vs output split, cache-hit % | `src/stores/navigation/router.ts`, `src/features/workflow/components/cost-drilldown-overlay.tsx` |
| 05 | Budget Pause Gate | New `budget_paused` event at 85%; pause loop; user confirmation or headless fail-fast | `src/engine/orchestrator/budget.ts`, `src/engine/events/types.ts`, `src/engine/orchestrator/task-loop.ts`, `src/cli/headless.ts` |

## Dependencies Between Briefs

```text
01 Cost Events & Store
  ├─ 02 Pricing Catalog      (reads extended TokenUsage for cache pricing)
  ├─ 03 Status Line          (consumes extended tokensStore)
  ├─ 04 Drill-Down           (consumes per-phase cost data from store)
  └─ 05 Budget Pause Gate    (engine side; emits new budget_paused event)
```

Brief 02 can run in parallel with 03/04/05 once 01 is merged. Briefs 03, 04, and 05 are independent of each other but all depend on 01.

## Collision Risk — smart-intake-brief-review-ux

The `2026-04-22-smart-intake-brief-review-ux` spec, brief `03-cost-risk-ux.md`, touches files that overlap directly with this spec:

| Overlapping file | smart-intake intent | This spec intent | Risk |
|---|---|---|---|
| `src/features/workflow/components/cost-footer.tsx` | Add mode/risk/quality score copy | Add persistent status line data (spent, projected, cache %) | HIGH — both modify the same component |
| `src/features/workflow/components/sidebar.tsx` | Add advisor/quality copy | Not planned | LOW — indirect |
| `src/core/schemas/summary.ts` | Add evidence rollup fields | Possibly extend `CostBreakdown` | MEDIUM |
| `src/features/workflow/components/event-cards/cost-prediction-card.tsx` | Creates this file | Drill-down may consume similar data | MEDIUM |

**Recommended sequencing:** this spec's brief 03 (Status Line) and brief 04 (Drill-Down) should run AFTER `smart-intake` brief 03 has landed. Alternatively, the two teams must explicitly coordinate on `cost-footer.tsx` ownership before either implements.

If briefs run in parallel, the implementing agent for brief 03 must read the smart-intake spec's `03-cost-risk-ux.md` first and avoid touching any lines already claimed by that brief.

## External Dependencies

- Node 22+, TypeScript ESM, Ink 6.x, React 19, Vitest 4.x, Zod 4.x — no new runtime dependencies.
- No new npm packages required (Ink `Box`/`Text` suffice for bars).

## Done Criteria

- Every workflow screen shows a live cost status line with spent, projected, budget, plan %, cache %.
- Pressing `$` at any point during the workflow opens the drill-down overlay.
- The drill-down shows per-phase horizontal bars, input vs output token split per phase, and cache-hit % where available.
- At 85% of `workflow.maxBudget`, the task loop pauses and the user is shown an approval gate.
- In headless `--json` mode, hitting the 85% threshold exits with a non-zero code and a machine-readable error.
- `npm run test-ci` passes (typecheck → lint → test).
- No React memoization, no new global context, no barrels, no classes.

## Quality Bar For Implementing Agents

- All new engine logic must be pure functions, fully unit-tested.
- Do not recalculate cost in TUI components — read from the cost store only.
- Cache hit % must render `cache n/a` when the runner does not expose cache data.
- Status line must fit in a single terminal row; truncate gracefully at narrow widths.
- Engine must not import React, Ink, or any `src/features/` module.
- The `budget_paused` event is distinct from `budget_exceeded`; do not collapse them.
- Backward compatibility: if `workflow.maxBudget` is absent, no gate fires and no budget column appears in the status line.
