# 00 — Coordinator

> Use this only when coordinating the whole Cost Telemetry TUI spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Cost Events & Store
  ├─ 02 Pricing Catalog
  ├─ 03 Status Line
  ├─ 04 Cost Drill-Down Overlay
  └─ 05 Budget Pause Gate
```

Recommended order:

1. `01-cost-events-and-store.md` — must land first; all others depend on extended `TokenUsage` and `tokensStore`.
2. `02-pricing-catalog.md` — can run immediately after 01; no TUI dependency.
3. `03-status-line-component.md` — requires 01. Can run in parallel with 02, 04, 05.
4. `04-cost-drilldown-screen.md` — requires 01. Can run in parallel with 02, 03, 05.
5. `05-budget-pause-gate.md` — requires 01 for the new event type. Engine side is independent of TUI.

**Do not begin 02–05 until 01's changes to `src/core/schemas/tokens.ts` and `src/stores/workflow/tokens.ts` are committed by the user.**

## Shared Files To Read Before Starting Any Brief

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/TESTING.md`
- `docs/STORES.md`
- `src/engine/events/types.ts`
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/core/schemas/tokens.ts`
- `src/core/schemas/config.ts`
- `src/stores/workflow/tokens.ts`
- `src/features/workflow/components/cost-footer.tsx`

## Shared Invariants

- Do not stage or commit.
- No new runtime npm dependencies.
- No classes.
- No barrels (`find src -name 'index.ts'` must return nothing).
- ESM `.js` import suffixes everywhere.
- Engine code (`src/engine/**`) must not import React, Ink, or anything from `src/features/`, `src/components/`, or `src/hooks/`.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or `useImperativeHandle`.
- Tests assert behavior, emitted events, persisted state, or rendered output — not private helper calls.
- Render `cache n/a` (not `0%`) when cache token data is absent.
- Budget gate must not fire when `workflow.maxBudget` is absent from config.

## Collision Warning — smart-intake-brief-review-ux

Before touching `src/features/workflow/components/cost-footer.tsx`, read:

```
docs/superpowers/specs/2026-04-22-smart-intake-brief-review-ux/agent-briefs/03-cost-risk-ux.md
```

That brief also modifies `cost-footer.tsx`. If it has not shipped yet, coordinate with the smart-intake agent or stage your changes to a different line range.

## Verification After Each Brief

```bash
npm run typecheck
npm run lint
npm test
```

Final handoff:

```bash
npm run test-ci
```
