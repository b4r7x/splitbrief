# Worker Brief 02: Doctor CLI

**Guard:** Use this only for a future source implementation pass; do not execute it during docs-only pack maintenance.

Add the standalone `diptych doctor` command backed by the shared readiness report.

## Project Constraints

- Node.js 22+, TypeScript 6.x, ESM only.
- Use `.js` suffixes in local imports.
- No classes, no barrels, no memoization.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by others.

## Required Reading

- `CLAUDE.md`
- `src/cli/setup.ts`
- `src/cli.ts`
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/spec.md`
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/implementation-plan.md`

## Owned Files

Owned files:

- new `src/cli/commands/doctor.ts`
- new `src/cli/commands/doctor.test.ts`
- `src/cli.ts`

Coordinate before touching:

- shared readiness core files from Worker 01
- `src/cli/options.ts`
- `src/cli/setup.ts`

## What To Change

- Register `diptych doctor`.
- Support human-readable output.
- Support `--json`.
- Use existing project directory resolution and config error formatting.
- Exit non-zero only when readiness status is `blocked`.
- Ensure doctor does not create a session, active lock, worktree, snapshot, config write/migration, planner call, or implementer call.
- If setup or migration is required, print the command/action the user should run; do not perform it.

## What Not To Change

- Do not call `maybeMigrate()`, `initConfig()`, `writeConfig()`, or helpers that write `.diptych/`, `.git/`, `.trees/`, snapshots, sessions, or config from doctor.
- Do not alter `init`, `status`, or `resume` semantics.
- Do not stage, stash, commit, or reset user changes.
- Do not add setup wizard behavior.

## Validation

Run targeted CLI tests:

```bash
npx vitest run src/cli/commands
```

Optional manual smoke after implementation must use a disposable fixture project, not the user's checkout. The fixture must use no real model credentials, no network access, and must be removed after the check.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- skipped validation and reason;
- risks or follow-up work;
- confirmation that no `git add`, `git stage`, `git commit`, or `git stash` was run.
