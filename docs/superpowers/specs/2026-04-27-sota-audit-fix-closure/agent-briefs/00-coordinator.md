# 00 - Coordinator

> Use this brief only when coordinating the full SOTA audit fix closure.
> If you are assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, `git commit`, or `git stash`.

## Execution Order

```text
03 Config, Palette, Plan Editor
  ├─ 01 Detach and Approval Semantics
  ├─ 04 Cost Telemetry TUI
  └─ 06 Snapshots, Worktrees

02 Task Brief Planning Contract
  └─ 01 Detach and Approval Semantics (coordinate on task-step.ts)

05 Artifacts, MCP, Handoff (independent)

07 Docs and Test Policy (last)
```

Recommended order:

1. `03-config-palette-plan-editor.md` first. It fixes lossless config loading, which other specs rely on for approval, snapshots, palette, and budget settings.
2. `02-task-brief-planning-contract.md` can run in parallel with 03, but must coordinate if it touches `src/engine/orchestrator/task-step.ts`.
3. `05-artifacts-mcp-handoff.md` can run independently.
4. `04-cost-telemetry-tui.md` can start after 03's config merge is stable.
5. `06-snapshots-worktrees.md` can start after 03; coordinate `src/cli/commands/start.ts` with brief 01.
6. `01-detach-and-approval-semantics.md` runs after 03 and after any task-step changes from 02 are known.
7. `07-docs-and-test-policy.md` runs last, after implementation behavior is final.

## Collision Map

| File / Area | Owner | Other Briefs Must |
|---|---|---|
| `src/core/config/load/load.ts` | 03 | Treat 03 as the owner of config merge behavior. |
| `src/cli/commands/start.ts` | 06 | Coordinate with 01 for `--detach --worktree`. |
| `src/engine/orchestrator/task-step.ts` | 01 | 02 may touch evidence flow only after coordinating. |
| `src/engine/orchestrator/planning/shared.ts` | 02 | 03/01 should not change review approval logic there. |
| `src/features/workflow/screen.tsx` | 04 | 01 may touch Ctrl-D/detach handling only if needed. |
| `src/stores/workflow/tokens.ts` | 04 | No other brief owns token/cost aggregation. |
| `src/engine/snapshots/*` | 06 | 05 must not change snapshot storage. |
| `src/engine/mcp/*` | 05 | No other brief owns MCP resources. |
| `docs/*` | 07 | Other briefs may update local docs only when tests need it; 07 does final consistency pass. |

## Shared Files To Read

- `CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/TESTING.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-22-task-brief-evidence-contract/README.md`
- `docs/superpowers/specs/2026-04-22-smart-intake-brief-review-ux/README.md`
- `docs/superpowers/specs/2026-04-22-external-agent-handoff-packs/README.md`
- `docs/superpowers/specs/2026-04-22-safe-snapshots-worktrees-parallel/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-tiered-approval-gates/README.md`
- `docs/superpowers/specs/2026-04-26-cost-telemetry-tui/README.md`
- `docs/superpowers/specs/2026-04-26-mcp-resources-server/README.md`
- `docs/superpowers/specs/2026-04-26-plan-editor-screen/README.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `docs/superpowers/specs/2026-04-26-worktrees-parallel/README.md`
- `docs/superpowers/specs/2026-04-26-brief-hash-versioning/README.md`

## Shared Invariants

- Do not stage, commit, or stash.
- No new runtime dependencies unless a brief explicitly allows it. These briefs do not.
- No classes.
- No barrels.
- ESM `.js` import suffixes in all TypeScript imports.
- Engine code must not import from React, Ink, `src/features/`, or `src/components/`.
- React code must not add `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or derived-state effects.
- Tests assert behavior and artifacts, not private helper call counts.
- Keep edits scoped to the assigned brief.

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

