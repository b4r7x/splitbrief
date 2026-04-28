# Worker Brief 04: Tests and Public Docs

**Guard:** Use this only for a future source implementation pass; do not execute it during docs-only pack maintenance.

Add focused tests and update public documentation after the implementation shape is stable.

## Project Constraints

- Node.js 22+, TypeScript 6.x, ESM only.
- Use `.js` suffixes in local imports.
- No classes, no barrels, no memoization.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by others.

## Required Reading

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/CLI-REFERENCE.md`
- `docs/FEATURES.md`
- `docs/TROUBLESHOOTING.md`
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/verification.md`

## Owned Files

Owned files:

- `src/core/readiness/status.test.ts`
- `src/core/readiness/checks.test.ts`
- `src/core/readiness/format.test.ts`
- `src/cli/commands/doctor.test.ts`
- `src/cli/commands/start.test.ts`
- `src/cli/headless.test.ts`
- `src/features/workflow/components/readiness-panel.test.tsx`
- `docs/CLI-REFERENCE.md`
- `docs/FEATURES.md`
- `docs/TROUBLESHOOTING.md`

Coordinate before touching:

- implementation files owned by Workers 01-03
- `docs/CONFIGURATION.md` if and only if new config fields are introduced

## What To Change

- Add behavior-focused tests for report aggregation, blocker/warning classification, JSON shape, no-secret output, doctor behavior, start ordering, and dirty repo posture.
- Use temporary fixtures and stubbed runner commands for start-ordering tests; do not invoke real models or network APIs.
- Update public docs to explain `diptych doctor` and pre-start readiness.
- Keep docs aligned with `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`.
- Mention that readiness does not run validation commands; it reports validation posture.

## What Not To Change

- Do not document unsupported auto-fix behavior.
- Do not imply MCP write tools exist.
- Do not imply same-checkout parallel writes are supported.
- Do not add tests that assert private helper internals instead of behavior.

## Validation

Run targeted tests first, then:

```bash
npm run typecheck
npm run lint
npm test
```

Also run:

```bash
git diff --check
```

Do not stage or commit the results.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- skipped validation and reason;
- risks or follow-up work;
- confirmation that no `git add`, `git stage`, `git commit`, or `git stash` was run.
