# 05 - Profile Doctor Readiness

> Proposed implementation brief for a fresh, cheap AI context.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You make profile readiness helpful and quiet. Normal runs show blockers only. `doctor` shows full detail.

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
- `src/core/readiness/checks.ts`
- `src/core/readiness/types.ts`
- `src/core/readiness/format.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/start.ts`
- `src/core/config/load/validate.ts`
- readiness tests.

## Primary Write Scope

Own readiness/config validation files:

- `src/core/readiness/checks.ts`
- `src/core/readiness/types.ts`
- `src/core/readiness/format.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/start.ts`
- `src/core/config/load/validate.ts`
- readiness/config validation tests.

Ask coordinator before editing estimate output or summary UI.

## Requirements

Normal interactive start:

- show blockers,
- do not show warning popups by default,
- continue if warnings have safe fallback.

Doctor:

- show blockers, warnings, info, and ok checks,
- `--json` includes machine-readable severity and metadata,
- no network calls by default,
- no config writes.

Classification:

- missing `contextLength`: warning/info with conservative fallback, not blocker,
- missing `costTier`: warning/info, not blocker,
- inferred `writesFiles`: info/warning, not blocker,
- API key missing for unused/non-default profile: warning/unavailable, not blocker,
- API key missing for only usable selected profile: blocker,
- no usable implementer remains: blocker.

## Implementation Notes

- Extend existing readiness system. Do not create a second doctor.
- Keep validation deterministic.
- Do not call providers to discover context windows unless a later explicit `--probe` feature exists. That is out of scope here.
- If config validation currently throws too early for optional profiles, move that condition into readiness classification when safe.

## Tests

Add behavior tests for:

- normal start hides warnings,
- doctor shows warnings,
- doctor JSON includes warnings/info,
- optional missing fields are non-blocking,
- no usable implementer blocks,
- unused profile missing credential does not block a run.

## Validation

Run targeted readiness/config tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, readiness behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
