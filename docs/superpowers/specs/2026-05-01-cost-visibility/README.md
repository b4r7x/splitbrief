# Cost Visibility - 2026-05-01

> **Status:** spec ready, not yet implemented.
> **Scope:** make diptych's cost-savings narrative loud and user-facing across run completion, CLI stats, and pre-implementation approval.
> **Write scope for this pack:** source implementation plus `docs/superpowers/specs/2026-05-01-cost-visibility/**`.
> **Out of scope:** billing integrations, team-level cost dashboards, budget enforcement, quota systems, and alert/notification plumbing.

## Problem

Diptych's core value proposition is cost savings: an expensive planner compiles task briefs, a cheap implementer executes them. The savings data already exists in the codebase (`CostBreakdown`, `CostPrediction`, `aggregateSessionCosts`), but it is buried in detailed tables, dimmed rows, and CLI flags. Users do not immediately feel the value they are getting.

Three gaps:

1. **Post-run:** the summary screen shows savings in a detail row among many. A user completing a run should see an unmistakable "hero stat" confirming what they saved.
2. **Cumulative:** there is no way to see total lifetime savings at a glance. `diptych status --history` exists but requires the flag and reads from session JSON on every invocation.
3. **Pre-implementation:** cost prediction fires as an event card, but the user cannot pause and approve before committing to implementation spend.

## Scope

This pack delivers three capabilities:

1. **Hero savings banner** on the summary screen after workflow completion.
2. **`diptych stats` CLI command** showing cumulative savings from a persisted `.diptych/stats.json` cache.
3. **Cost-gated plan approval** prompt rendered before implementation begins in `standard` and `speckit` modes.

## Baseline References

- `src/features/summary/screen.tsx`
- `src/features/summary/components/cost-breakdown.tsx`
- `src/features/workflow/hooks/use-cost-stats.ts`
- `src/core/schemas/summary.ts` (CostBreakdown, CostPrediction)
- `src/stores/workflow/tokens.ts`
- `src/engine/providers/pricing.ts`
- `src/core/sessions/analytics.ts` (aggregateSessionCosts)
- `src/cli/commands/status.ts` (printCostHistory)
- `src/features/workflow/components/event-cards/cost-prediction-card.tsx`
- `src/core/state/machine.ts` (awaitingContinue)

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `decisions.md` | ADR-style product and architecture decisions. |
| 3 | `agent-briefs/01-hero-savings.md` | Hero savings banner worker brief. |
| 4 | `agent-briefs/02-stats-command.md` | Stats CLI command and persistence worker brief. |
| 5 | `agent-briefs/03-cost-gated-approval.md` | Cost-gated plan approval worker brief. |
| 6 | `execute-prompt.md` | Copy/paste prompt for handing this pack to a fresh implementation context. |

## Non-Goals

- Do not build billing integrations or payment tracking.
- Do not build team dashboards or multi-user cost views.
- Do not build budget limits, hard caps, or enforcement systems.
- Do not build alerting or notification infrastructure.
- Do not change existing pricing calculation logic.
- Do not add new pricing providers or model catalogs.
- Do not build cost forecasting beyond what CostPrediction already provides.
- Do not change the existing `diptych status --history` subcommand behavior.
