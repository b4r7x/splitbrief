# Coordinator Brief: Run Readiness / Doctor

**Guard:** Use this only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are implementing the Run Readiness / Doctor feature in `diptych`.

## Project Constraints

- Node.js 22+, TypeScript 6.x, ESM only.
- Every local import in TypeScript uses a `.js` suffix.
- No classes.
- No barrels; do not create `index.ts`.
- No React memoization: no `useMemo`, `useCallback`, or `React.memo`.
- No `forwardRef` or imperative handles.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by others.
- Keep changes scoped to this feature.

## Required Reading

Pack-relative paths below are relative to `docs/superpowers/specs/2026-04-28-run-readiness-doctor/`.

Read before implementation:

- `CLAUDE.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/CONFIGURATION.md` sections for planner, implementer, implementer profiles, validation, workflow, config validation
- `docs/FEATURES.md` sections for backend config, validation, cost status, init/status/resume
- `docs/WORKFLOW.md` sections for start, persistence, resume, validation, cost display
- this pack directory: `README.md`, `spec.md`, `decisions.md`, `implementation-plan.md`, `tasks.md`, `verification.md`

Read likely source files:

- `src/cli.ts`
- `src/cli/commands/start.ts`
- `src/cli/setup.ts`
- `src/cli/headless.ts`
- `src/core/config/runtime/resolve.ts`
- `src/core/config/accessors/implementer-profiles.ts`
- `src/core/config/load/validate.ts`
- `src/core/validation/test-discovery.ts`
- `src/engine/orchestrator/validation.ts`

## Coordination Plan

Dispatch worker briefs in this order:

1. `01-readiness-core.md`
2. `02-doctor-cli.md`
3. `03-start-tui-headless.md`
4. `04-tests-docs.md`

Keep file ownership mostly disjoint. Merge by reading existing changes first; do not overwrite another worker's edits.

## Owned Files

Coordinator may touch files required to connect the feature, but should prefer letting worker briefs own their listed files. The coordinator owns final integration conflicts and final verification.

## What To Change

- Add a shared readiness report model and checks.
- Add `diptych doctor`.
- Add pre-start readiness for interactive, detach, and headless modes.
- Add focused tests and public docs updates.

## What Not To Change

- Do not add kanban, plan archive, MCP write tools, multi-agent manager, or same-checkout parallel writes.
- Do not change session history semantics except that `diptych start` may persist a compact readiness event/artifact in the active execution session before model calls.
- Do not run validation commands from readiness itself.
- Do not add network probes as hard requirements.
- Do not stage or commit.

## Validation

Run targeted tests as the feature comes together, then:

```bash
npm run typecheck
npm run lint
npm test
```

If full tests are not practical, report exactly which targeted commands passed and why broader validation was skipped.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- skipped validation and reason;
- risks or follow-up work;
- confirmation that no `git add`, `git stage`, `git commit`, or `git stash` was run.
