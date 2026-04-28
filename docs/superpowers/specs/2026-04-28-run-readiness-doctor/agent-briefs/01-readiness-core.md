# Worker Brief 01: Readiness Core

**Guard:** Use this only for a future source implementation pass; do not execute it during docs-only pack maintenance.

Implement the pure Run Readiness model and checks.

## Project Constraints

- Node.js 22+, TypeScript 6.x, ESM only.
- Use `.js` suffixes in local imports.
- No classes, no barrels, no memoization.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by others.

## Required Reading

- `CLAUDE.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/CONFIGURATION.md` planner, implementer, profiles, validation, workflow, config validation sections
- `docs/WORKFLOW.md` start and validation sections
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/spec.md`
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/decisions.md`

## Owned Files

Owned new files:

- `src/core/readiness/types.ts`
- `src/core/readiness/status.ts`
- `src/core/readiness/checks.ts`
- `src/core/readiness/collect.ts`
- `src/core/readiness/format.ts`
- `src/core/readiness/status.test.ts`
- `src/core/readiness/checks.test.ts`
- `src/core/readiness/format.test.ts`

Coordinate before touching:

- `src/core/config/runtime/resolve.ts`
- `src/core/config/accessors/implementer-profiles.ts`
- `src/core/config/load/validate.ts`
- `src/core/validation/test-discovery.ts`
- `src/engine/orchestrator/validation.ts`

## What To Change

- Define `ReadinessReport`, `ReadinessSection`, `ReadinessCheck`, severity, aggregate status, and next-action types.
- Add pure aggregation helpers.
- Add checks for config posture, mode/approval/effort resolution, implementer profile posture, validation config, context length posture, repo posture inputs, and budget/cost posture.
- Inspect validation configuration, package-script/test-file posture, and existing task validation semantics; do not execute validation commands.
- Keep checks deterministic and side-effect free.
- Redact secrets from every detail field.

## What Not To Change

- Do not add a CLI command in this brief.
- Do not add TUI components in this brief.
- Do not run validation commands from readiness.
- Do not make remote network probes mandatory.
- Do not add new runtime dependencies.

## Validation

Run targeted tests for the new pure modules:

```bash
npx vitest run src/core/readiness
```

## Expected Final Report

Include:

- files changed;
- tests run and results;
- skipped validation and reason;
- risks or follow-up work;
- confirmation that no `git add`, `git stage`, `git commit`, or `git stash` was run.
