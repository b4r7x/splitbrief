# 00 — Coordinator

> Use this only when coordinating the full Snapshots / Undo spec (2026-04-26).
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Snapshot Schema and Storage
  └─ 02 Snapshot Create and List
       └─ 03 Snapshot Restore
            └─ 04 Auto-Snapshot Triggers
  05 Snapshot Diff (independent, can run after 02)
```

Recommended sequential order:

1. `01-snapshot-schema-and-storage.md` — schema + paths + low-level helpers (all others depend on this)
2. `02-snapshot-create-and-list.md` — create + list engine fns + CLI commands
3. `03-snapshot-restore.md` — restore engine fn + CLI command
4. `04-auto-snapshot-triggers.md` — orchestrator integration (depends on 02 + 03 for the engine fns)
5. `05-snapshot-diff.md` — diff engine fn + CLI command (depends only on 01 + 02)

Brief 05 can run in parallel with briefs 03 and 04 if no agent is editing the same files. Briefs 03 and 04 must not run in parallel (both touch `task-loop.ts` and `final-review.ts`).

## Shared Files To Read Before Starting Any Brief

- `CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/LAYERS.md`
- `docs/WORKFLOW.md`
- `src/core/paths.ts`
- `src/core/schemas/config.ts`
- `src/core/schemas/evidence.ts` (pattern reference for Zod schema)
- `src/engine/orchestrator/evidence.ts` (pattern reference for read/write helpers)
- `src/engine/orchestrator/task-loop.ts` (integration point for auto-triggers)
- `src/engine/orchestrator/final-review.ts` (integration point for pre-final-review trigger)
- `src/cli/commands/status.ts` (CLI command pattern reference)

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies (use `node:crypto`, `node:fs/promises`, `node:path` only).
- No classes. Pure functions and module-scoped state only.
- No barrels — do not create `src/engine/snapshots/index.ts`.
- ESM `.js` import suffixes in every import.
- Engine code (`src/engine/snapshots/`) must not import from `ink`, `react`, `src/features/`, or `src/components/`.
- The `.diptych/` directory must always be excluded from snapshot scope — never snapshot the snapshot directory.
- All JSON artifacts must be written atomically (write to `.tmp`, then rename) or use `node:fs` `writeFile` with explicit mode `0o600`.
- Tests use colocated `*.test.ts` files and real temp directories via `node:os` `tmpdir`. No mocking of `node:fs`.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

After all briefs:

```bash
npm run test-ci
```

## New Source Files Summary

```text
src/core/schemas/snapshot.ts
src/engine/snapshots/store.ts
src/engine/snapshots/store.test.ts
src/engine/snapshots/restore.ts
src/engine/snapshots/restore.test.ts
src/engine/snapshots/diff.ts          (brief 05)
src/engine/snapshots/diff.test.ts     (brief 05)
src/cli/commands/snapshot.ts
src/cli/commands/snapshot.test.ts
```

## Modified Source Files Summary

```text
src/core/paths.ts
src/core/schemas/config.ts
src/engine/events/types.ts
src/engine/orchestrator/task-loop.ts
src/engine/orchestrator/final-review.ts
src/cli.ts (CLI entry point — register snapshot command here)
docs/CONFIG.md
docs/WORKFLOW.md
```
