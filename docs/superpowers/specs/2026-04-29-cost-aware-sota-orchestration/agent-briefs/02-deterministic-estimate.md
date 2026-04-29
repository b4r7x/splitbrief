# 02 - Deterministic Estimate

> Proposed implementation brief for a fresh, cheap AI context.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You add a cheap pre-run estimate. It must not call the planner or any LLM.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `typescript`

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- `docs/CONFIGURATION.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `src/engine/orchestrator/context-routing.ts`
- `src/engine/orchestrator/tokens.ts`
- `src/engine/providers/pricing.ts`
- existing CLI command patterns under `src/cli/commands/`
- existing orchestrator tests around routing/pricing.

## Primary Write Scope

Own estimate-related files:

- new estimate service under `src/engine/orchestrator/` if needed,
- minimal exported helpers from `src/engine/orchestrator/context-routing.ts` if needed,
- estimate schemas under `src/core/schemas/` if needed,
- CLI command wiring only if it follows existing command patterns,
- estimate tests.

Ask coordinator before editing planner prompts, task review UI, or readiness warning policy.

## Requirements

The estimate must:

- run without planner/LLM calls,
- reuse existing routing and pricing logic,
- estimate planned task prompt size/context fit,
- estimate actual planner plus implementer costs when pricing is known,
- show all-planner baseline where possible,
- show savings estimate where possible,
- mark unknown price instead of pretending the cost is zero,
- mark context confidence.

Context confidence states:

- explicit `contextLength`,
- known model catalog value,
- cached provider discovery if already available,
- conservative fallback,
- unavailable profile.

Do not add network calls by default.

## Output Shape

Prefer a structured estimate result that can serve:

- CLI output,
- TUI preview,
- planner estimate review packet,
- trace/explain output,
- tests.

Keep the service pure enough to test without Ink.

## Tests

Add behavior tests for:

- stable estimate for same input,
- unknown pricing,
- missing context length fallback,
- unavailable non-default profile,
- no planner call path,
- context overflow classification.

Do not add tests for private formatting helpers unless they are public CLI behavior.

## Validation

Run targeted estimate/routing tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, estimate output behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
