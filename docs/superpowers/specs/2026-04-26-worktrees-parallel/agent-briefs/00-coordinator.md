# 00 — Coordinator

> Use this only when coordinating the whole Worktrees & Parallel Sessions spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Worktree Manager (engine foundation)
  ├─ 02 CLI — start --worktree flag
  ├─ 03 CLI — worktree subcommands
  └─ 04 TUI Worktree Indicator

06 Runtime Isolation Docs   (independent — docs only, no code)
```

Recommended order:

1. `01-worktree-manager.md` — must be complete before 02, 03, 04.
2. `02-cli-start-worktree-flag.md` — depends on 01.
3. `03-cli-worktree-commands.md` — depends on 01.
4. `04-tui-worktree-indicator.md` — depends on 01.
5. `06-runtime-isolation-docs.md` — fully independent; can run in parallel with any of 02–04.

Brief 05 (`--parallel N` fan-out) does not exist in this spec. It is deferred to v3.

## Shared Files To Read

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/CONCEPTS.md`
- `docs/LAYERS.md`
- `src/core/paths.ts`
- `src/core/sessions/lifecycle.ts`
- `src/cli.ts`
- `src/cli/commands/start.ts`
- `src/cli/options.ts`
- `src/features/workflow/components/header.tsx`

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies beyond `simple-git` (already present).
- No classes anywhere in `src/`.
- No barrels — do not create `src/engine/git/index.ts`.
- Use ESM `.js` import suffixes.
- Engine code must not import from `react`, `ink`, `src/features/`, or `src/components/`.
- Tests assert behavior, persisted state, returned values, or rendered output — not private helper calls.
- Path constants go in `src/core/paths.ts`; do not hardcode `.trees` or `diptych/` in engine code.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```
