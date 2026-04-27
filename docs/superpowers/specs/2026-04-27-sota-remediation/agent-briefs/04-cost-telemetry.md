# 04 - Cost Telemetry

> Implement only this brief. Never stage, commit, or stash.

## Goal

Make budget gating, token aggregation, cache pricing, and TUI cost rendering use one consistent source of truth.

## File Ownership

- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/tokens.ts`
- `src/engine/providers/pricing-resolver.ts`
- `src/engine/providers/pricing.ts`
- `src/engine/providers/anthropic/stream.ts`
- `src/stores/workflow/tokens.ts`
- `src/features/workflow/hooks/use-cost-stats.ts`
- `src/features/workflow/hooks/use-workflow-keys.ts`
- `src/features/workflow/components/cost-*`
- `src/features/workflow/screen.tsx`
- `src/core/layout/*`
- matching tests/docs

## Required Changes

1. Budget uses selected models:
   - Extend `BudgetCheckOptions` to include `plannerModel` and `implementerModel`.
   - Pass selected models from task loop/config into budget checks.
   - Add tests showing different model pricing changes pause/exceeded decisions.

2. Cache pricing consistency:
   - When runtime/model-cache pricing is present but lacks cache read/write rates, merge cache pricing from bundled fallback when provider/model match.
   - Ensure `useCostStats` and `tokensStore` phase math use the same pricing resolver/cache input.
   - Add tests for Anthropic cache pricing with runtime model cache.

3. Phase cost source of truth:
   - `tokensStore.perPhase[*].cost` and status total cost must agree for the same token usage.
   - Unknown/unpriced models should render explicit unpriced/local/n/a states, not fake zero savings.

4. Budget warning and pause ordering:
   - If a task jumps from below 80 percent to pause threshold, emit both `budget_warning` and `budget_paused` in deterministic order.
   - Add regression test.

5. Escalation cache tokens:
   - Preserve cache read/create tokens for escalation usage.
   - Include them in cache hit percent and cache savings where provider supports it.

6. Layout row accounting:
   - Update fixed chrome row constants to include the cost status row.
   - Add a render/layout test or stable calculation test proving content height accounts for the new row.

7. Keybinding/headless tests:
   - Add a behavior test for `$` opening cost drilldown and any key/Esc closing it.
   - Add a headless JSON/fail-fast test for budget pause threshold.

## Acceptance Criteria

- Budget pause/exceeded decisions reflect selected models.
- Cache pricing is retained with model cache.
- Store phase cost and UI status cost agree.
- Warning event is not suppressed by jumping to pause threshold.
- Escalation cache tokens are visible in aggregate cache stats.
- Workflow layout does not overlap due to the status row.
- `$` drilldown and headless pause paths are covered.

## Tests

Run:

```bash
npm test -- src/engine/orchestrator/budget.test.ts src/engine/orchestrator/tokens.test.ts src/engine/providers src/stores/workflow/tokens.test.ts src/features/workflow/components src/features/workflow/hooks src/cli/headless.test.ts
npm run typecheck
npm run lint
```

