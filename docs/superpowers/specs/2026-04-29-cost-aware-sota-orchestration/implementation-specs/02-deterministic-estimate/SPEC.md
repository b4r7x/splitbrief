# 02 - Deterministic Estimate

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a cheap pre-run estimate that uses deterministic data only.

It must not call the planner, implementer, provider APIs, or any LLM.

The point: before spending money, the user can see whether the plan probably fits cheap implementers and what the rough cost/savings look like.

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `typescript`

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
3. `docs/CONFIGURATION.md`
4. `src/engine/orchestrator/context-routing.ts`
5. `src/engine/orchestrator/tokens.ts`
6. `src/engine/providers/pricing.ts`
7. existing CLI command patterns under `src/cli/commands/`
8. routing/pricing tests found with `rg "context fit|contextFit|pricing|route" src`

## Owned Files

Primary ownership:

- new pure estimate service under `src/engine/orchestrator/`, preferably `estimate.ts` if that name is free,
- estimate tests next to existing orchestrator tests,
- minimal exports from `src/engine/orchestrator/context-routing.ts` if needed,
- estimate schema/type file under `src/core/schemas/` only if the repo pattern requires schema sharing,
- CLI or TUI integration only if the existing pattern makes it small and obvious.

Do not edit:

- planner prompt files,
- auto-split mutation,
- task review UI,
- readiness warning policy.

## Functional Requirements

### DE-001 - No LLM Calls

The estimate must be computed from:

- planned tasks,
- task brief sizes,
- routing preview,
- profile config,
- pricing table/helpers,
- context-length metadata.

No planner call. No implementer call. No provider discovery network call.

### DE-002 - Reuse Routing

Do not invent a second routing model.

Reuse existing context routing and pricing logic. If existing helpers are not exported, extract the smallest pure helper needed.

### DE-003 - Estimate Confidence

Every estimate should communicate confidence:

- price known,
- price unknown,
- context length explicit,
- context length from known catalog,
- context length from already-cached provider data,
- conservative fallback,
- profile unavailable.

If catalog/cached provider data does not exist today, implement explicit plus conservative fallback only. Do not add network discovery in this spec.

### DE-004 - Stable Output

Same inputs should produce same result.

Do not use current time except for artifact metadata if existing patterns require it.

### DE-005 - Fit Classification

Each task should be classified using existing language if possible:

- fits,
- tight,
- overflow,
- unknown.

## Output Shape

Create a structured result that can later feed:

- brief review UI,
- planner estimate review,
- auto-split,
- trace/explain,
- tests.

Suggested fields:

```text
tasks[]
  taskId
  title
  estimatedPromptTokens
  selectedProfileId
  contextFit
  contextConfidence
  priceConfidence
  estimatedImplementerCost
  hypotheticalPlannerCost
totals
  knownActualEstimate
  hypotheticalAllPlanner
  estimatedSavings
  unknownCostReason[]
```

Adapt names to existing repo style.

## Implementation Steps

1. Inspect current routing output.
2. Design a small pure estimate result type.
3. Build estimate from already parsed tasks and profile config.
4. Use existing pricing helpers for cost math.
5. Represent unknown values explicitly.
6. Add narrow CLI/TUI hook only if there is an obvious existing preview point.
7. Add behavior tests.

## Test Requirements

Required behavior tests:

- estimate does not call planner/implementer,
- stable output for same input,
- known price computes baseline/savings,
- unknown price is marked unknown,
- missing context length uses conservative fallback,
- overflow task is classified as overflow,
- unavailable profile does not crash the estimate.

Do not test private formatting helpers.

## Validation

Run targeted estimate/routing tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no network discovery,
- no planner call,
- no duplicate pricing model,
- no fake zero cost,
- no broad config rewrite,
- no classes,
- no barrels.

## Agent Prompt

```text
Implement spec 02 Deterministic Estimate from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/02-deterministic-estimate/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
No LLM/provider calls in this feature. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
