# 04 - Tests And Validation

> Fresh-context worker brief.
> Use this only for a future source implementation pass; do not execute it during docs-only spec-pack maintenance.
> Run after briefs 01, 02, and 03 are complete in the same checkout.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Perform the final behavior-focused test pass for checkpoint visibility, review packet artifacts, and summary TUI rendering. Add missing tests only where behavior is not covered.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `AGENTS.md`
- `CLAUDE.md`
- `docs/TESTING.md` if present
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/verification.md`
- Changed files from briefs 01, 02, and 03

## Discovery Step

Start from an empty context by inspecting the files already changed by the prior briefs:

```bash
git diff --name-only
```

Then read the new tests, source files named by prior briefs, and any source files listed in the changed-file output before adding or adjusting coverage.

## Write Ownership

You may edit tests for files changed by prior briefs:

```text
src/engine/snapshots/checkpoint-summary.test.ts
src/cli/commands/snapshot.test.ts
src/engine/orchestrator/review-packet.test.ts
src/engine/orchestrator/final-review.test.ts
src/engine/orchestrator/summary.test.ts
src/features/summary/screen.test.tsx
src/features/summary/components/summary-components.test.tsx
src/features/summary/components/summary-checkpoints.test.tsx
src/features/summary/components/summary-review-packet.test.tsx
```

If a critical implementation bug is found, make the smallest source fix in the file that owns the bug and report it clearly. Do not refactor unrelated code.

Do not edit docs outside this spec unless the coordinator explicitly asks for post-implementation user-doc updates.

## Required Coverage

Verify behavior for:

- baseline snapshots hidden from checkpoint display
- manual and auto checkpoint kind derivation
- run-ledger checkpoint marker behavior
- manual snapshots named like auto checkpoints are not marked as run checkpoints without a run-ledger entry
- missing run-ledger data uses `inferredKind` for display fallback
- ID-based restore/diff command generation
- restore safety/conflict copy
- review packet JSON with complete artifacts
- review packet JSON with missing optional artifacts
- Markdown packet headings and reviewer checklist
- final review failure still producing packet status
- recovery decision source artifacts/events, selected action, skipped/aborted/pause/resume outcomes, and unresolved risks
- escalated, skipped, retried, failed task representation
- drift warning/error representation
- summary TUI rendering with packet/checkpoint data
- narrow terminal summary rendering where existing test helpers support it

Avoid tests that only assert "does not crash." Assert visible output, artifact content, schema validation, events, or filesystem effects.

## Non-Goals

- No broad architectural cleanup.
- No new runtime dependencies.
- No MCP write tools.
- No plan archive or kanban behavior.
- No parallel execution changes.
- No staging or committing.

## Validation Commands

Run targeted suites first:

```bash
npm test -- src/engine/snapshots/checkpoint-summary.test.ts src/engine/orchestrator/review-packet.test.ts
npm test -- src/features/summary/screen.test.tsx src/features/summary/components/summary-components.test.tsx
```

Run related suites if touched:

```bash
npm test -- src/cli/commands/snapshot.test.ts src/engine/orchestrator/final-review.test.ts src/engine/orchestrator/summary.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
git diff --check
```

Run full tests when practical:

```bash
npm test
```

## Expected Final Report

Report:

- test files added/changed
- source fixes made, if any
- validation commands run and pass/fail results
- full `npm test` status or reason it was not run
- remaining risks
- confirmation that no staging or commit commands were run
