# Coordinator Final Pass - Docs Tests Quality

> Proposed final cleanup checklist for the coordinator.
> This is not one of the seven implementation contexts.
> Run after implementation slices settle.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You align docs and tests with the final implementation. You are not adding new product behavior unless needed to fix a clear mismatch.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `code-audit` as checklist only.

Do not run a full `/code-audit` unless the user explicitly asks.

## Read First

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/HOOKS.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- all files changed by briefs 01-07,
- docs touched by briefs 01-07.

## Primary Write Scope

Own docs and tests:

- docs touched by this pack,
- tests touched by this pack,
- this spec pack if implementation decisions changed.

Do not perform source refactors unless a doc/test mismatch cannot be fixed otherwise. Ask coordinator before changing source behavior.

## Requirements

Docs must say:

- diptych is a cost-aware planner-to-cheap-implementer orchestrator,
- deterministic estimate is default/cheap,
- planner estimate review is opt-in,
- auto-split overflow is opt-in,
- doctor warnings are quiet in normal start,
- task review gate is opt-in,
- trace/explain is artifact-driven and no-LLM,
- parallel worktrees are deferred.

Tests must follow:

- behavior over implementation,
- no tiny hook wrapper tests,
- no private helper call-count tests,
- no brittle snapshots of huge prompts,
- keep tests for routing, readiness, rendered output, artifacts, and recovery behavior.

## Cleanup Rules

Remove or rewrite tests only when they are low value:

- no-crash render tests without observable behavior,
- tests that only prove a hook forwards store state,
- private helper tests already covered by higher behavior tests,
- duplicated prompt snapshots that make refactors painful.

Keep tests that protect:

- cost math,
- estimate output,
- readiness classification,
- task review commands,
- trace/explain artifacts,
- config compatibility.

## Validation

Run:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

If full `npm test` is not feasible, run the targeted tests changed by this pack and report the reason.

## Expected Report

Include changed files, docs updated, tests removed/rewritten/kept, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
