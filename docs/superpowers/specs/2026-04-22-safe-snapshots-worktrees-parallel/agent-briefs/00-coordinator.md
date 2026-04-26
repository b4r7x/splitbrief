# 00 — Coordinator

> Use this when coordinating Safe Snapshots, Worktrees & Parallel Execution.
> Do not stage or commit.

## Execution Order

```text
01 Safe Run Snapshots
  └─ 02 Worktree Start
        └─ 03 Parallel Session Registry
```

`01` can run alone. `02` and `03` should wait until snapshot semantics are clear, because worktree runs need the same accept/reject story.

## Shared Files To Read

- `CLAUDE.md`
- `docs/FUTURE.md`
- `docs/WORKFLOW.md`
- `src/cli/commands/start.ts`
- `src/cli/setup.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/implementers/apply.ts`
- `src/lib/git.ts`
- `src/core/slash-commands/catalog.ts`

## Shared Invariants

- Never stage or commit.
- Same directory keeps one `.diptych/active` lock.
- Worktree support must be explicit, not implicit.
- Restore must be hash-guarded.
- Real filesystem tests are preferred.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```
