# 01 - Checkpoint UX

> Historical fresh-context worker brief.
> Do not re-run this brief unless intentionally changing or re-implementing this pack.
> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Create the read-only checkpoint display layer over existing snapshot storage. Make checkpoints visible and restore commands trustworthy without changing snapshot storage semantics.

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
- `docs/FEATURES.md` sections for Snapshots, Auto-snapshots, Evidence, Summary screen
- `docs/WORKFLOW.md` sections 1.9, 1.10, Summary screen, Auto-snapshots
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md`
- `src/core/schemas/snapshot.ts`
- `src/engine/snapshots/store.ts`
- `src/engine/snapshots/run.ts`
- `src/engine/snapshots/restore.ts`
- `src/engine/snapshots/diff.ts`
- `src/cli/commands/snapshot.ts`

## Write Ownership

Primary files:

```text
src/engine/snapshots/checkpoint-summary.ts
src/engine/snapshots/checkpoint-summary.test.ts
```

Optional files if CLI list output is polished in this brief:

```text
src/cli/commands/snapshot.ts
src/cli/commands/snapshot.test.ts
```

Do not edit summary TUI files. Do not edit review packet files. Do not edit docs outside this spec unless the coordinator explicitly assigns docs cleanup after implementation.

## Required Behavior

Add a pure/read-only helper that returns user-facing checkpoint summaries for a session.

Each checkpoint summary should include:

- snapshot ID
- name when present
- created timestamp
- phase
- optional task index
- tracked file count
- display kind: `manual`, `pre-task`, `post-task`, `pre-final-review`, `accepted-run`, or `other`
- optional `inferredKind` from names only when ledger classification is missing
- whether it is a run checkpoint, derived only from `run-ledger.json`
- exact `diptych snapshot diff SNAPSHOT_ID` command using the real snapshot ID
- exact `diptych snapshot restore SNAPSHOT_ID` command using the real snapshot ID
- restore safety text or structured flags for hash-guard/conflict behavior

Rules:

- Hide the `baseline` snapshot from normal display.
- Prefer IDs in generated commands, not names.
- Do not mark a snapshot as a run checkpoint because its name looks like `pre-task-*`, `post-task-*`, `pre-final-review`, or `accepted-run`.
- If `run-ledger.json` is missing, use `inferredKind` for display fallback and do not set `isRunCheckpoint` to true.
- Use existing `listSnapshots()` and `readRunSnapshotLedger()` where possible.
- Do not mutate snapshot manifests or run ledger.
- Do not change restore semantics.
- Preserve existing snapshot CLI create/list/restore/diff behavior and exit codes.

## Non-Goals

- No TUI rendering in this brief.
- No review packet writer in this brief.
- No automatic restore.
- No new snapshot storage layout.
- No MCP changes.
- No parallel execution.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Engine code must not import React/Ink/features/components/hooks.
- Tests should use temp directories and real files where useful.
- Tests should cover manual snapshots named like auto checkpoints and missing-ledger `inferredKind` fallback.
- Do not stage or commit.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/engine/snapshots/checkpoint-summary.test.ts
```

If CLI output changed:

```bash
npm test -- src/cli/commands/snapshot.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
git diff --check
```

## Expected Final Report

Report:

- files changed
- checkpoint summary fields implemented
- CLI behavior changed, if any
- validation commands run and results
- any skipped validation and why
- risks or follow-ups for downstream review packet/TUI briefs
