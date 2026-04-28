# 00 - Coordinator

> Fresh-context coordinator brief for implementing `Checkpoint / Restore UX + Post-run Review Packet`.
> Use this only for a future source implementation pass; do not execute it during docs-only spec-pack maintenance.
> Use this only when coordinating the full implementation. If assigned one worker brief, implement only that brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Project Context

Diptych is a Node 22+, TypeScript ESM CLI/TUI that orchestrates an expensive planner and cheaper/local implementer. The feature goal is to make existing snapshots/checkpoints visible and trustworthy and to produce a final post-run review packet for humans/PR review.

Product boundaries:

- Do not build kanban.
- Do not build a plan archive.
- Do not build MCP write tools.
- Do not build a full multi-agent manager.
- Do not support parallel writes in one checkout.
- Durable sessions are execution/session history, not a plan archive.
- Implementer pool is routing/escalation within one implementer role, not a swarm UI.

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
- `docs/FEATURES.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/README.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/decisions.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/implementation-plan.md`

## Execution Order

Use this order in one checkout:

```text
01 Checkpoint UX
  -> 02 Review Packet Model
      -> 03 Summary TUI
          -> 04 Tests And Validation
```

Do not run these workers in parallel in the same checkout. If you use separate isolated worktrees, keep file ownership exact and reconcile manually in the coordinator context.

## Brief Ownership

| Brief | Owns |
|---|---|
| `01-checkpoint-ux.md` | Snapshot/checkpoint display helpers and optional snapshot CLI list polish. |
| `02-review-packet-model.md` | Review packet schema, builder, writer, final-review integration, summary rollups. |
| `03-summary-tui.md` | Summary screen components and rendering tests. |
| `04-tests-and-validation.md` | Final behavior tests, validation, and implementation report. |

## Global Constraints

- Do not stage or commit.
- Do not revert edits made by other agents.
- Node.js 22+.
- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or hooks.
- Tests should verify behavior, artifacts, rendered output, public state, and filesystem effects.
- Do not add trivial hook tests.
- Do not add runtime dependencies unless unavoidable and explicitly justified.
- Do not add same-checkout parallel writes.
- Do not add MCP write tools.

## Coordinator Validation

After each worker, run targeted validation for that worker when practical. After all workers:

```bash
npm run typecheck
npm run lint
git diff --check
npm test -- src/engine/snapshots/checkpoint-summary.test.ts src/engine/orchestrator/review-packet.test.ts
npm test -- src/features/summary/screen.test.tsx src/features/summary/components/summary-components.test.tsx
```

Run full `npm test` if the environment can support it.

## Expected Final Report

Report:

- changed files grouped by feature area
- packet artifacts added and where they are written
- checkpoint UX behavior implemented
- validation commands run and results
- any skipped validation and why
- remaining risks or follow-up work

Do not include staged/commit status except to confirm no staging or commits were performed.
