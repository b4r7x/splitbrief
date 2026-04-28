# 03 - Context Sizing And Routing

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

Add pure task sizing and routing helpers. This brief does not change the orchestrator loop except for optional non-invasive exports if needed by tests.

## Intent

Before a task is sent to an implementer, diptych should know whether the formatted prompt fits the candidate worker and which worker is the cheapest capable choice.

## Scope

**In bounds:**

- New engine/core helper files for routing and prompt sizing.
- `src/engine/spec/formatter.ts` or sibling helper if prompt estimation needs reuse.
- `src/engine/orchestrator/cost-prediction.ts` only if pricing/cost posture needs shared helpers.
- Tests for pure helpers.

**Out of bounds:**

- No TUI.
- No task loop dispatch change.
- No profile schema changes beyond using brief 02 outputs.
- No model API calls.

## Required Behavior

- Estimate formatted task prompt tokens using existing token estimation utilities.
- Apply a configurable or constant safety margin.
- Classify fit as:
  - `fits`,
  - `tight`,
  - `overflow`.
- Choose the cheapest capable profile.
- Preserve deterministic tie-breaking.
- Return rejected profiles with reasons.
- Return a clear no-capable-profile result.

## Suggested Types

```ts
type TaskContextFit = 'fits' | 'tight' | 'overflow';

type RoutingDecision = {
  taskId: TaskId;
  selectedProfile?: string;
  fit: TaskContextFit;
  estimatedTokens: number;
  contextLength?: number;
  reason: string;
  rejected: Array<{ profile: string; reason: string }>;
};
```

## Validation

Tests should cover:

- smallest fitting profile wins,
- local/cheap tiers sort before expensive tiers,
- unknown cost is handled deterministically,
- overflow profile is rejected,
- all-overflow returns no selected profile,
- absent context length falls back to conservative behavior,
- same inputs produce stable output order.

Run:

```bash
npm test -- src/engine/orchestrator/*routing*.test.ts src/engine/spec/*token*.test.ts
npm run typecheck
npm run lint
```

## Evidence

- Pure routing helpers exist and are tested.
- No orchestrator dispatch behavior is changed in this brief unless explicitly coordinated.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- validation skipped, with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
