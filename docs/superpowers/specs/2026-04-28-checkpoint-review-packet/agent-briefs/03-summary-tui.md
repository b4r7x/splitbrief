# 03 - Summary TUI

> Historical fresh-context worker brief.
> Do not re-run this brief unless intentionally changing or re-implementing this pack.
> Implement only this brief after `02-review-packet-model.md` is complete.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Render checkpoint and review-packet status in the existing summary screen without turning the screen into a diff viewer, kanban board, or plan archive.

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
- `docs/FEATURES.md` Summary screen section
- `docs/WORKFLOW.md` Summary screen section
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/summary-evidence.tsx`
- `src/features/summary/components/summary-task-table.tsx`
- `src/features/summary/components/summary-components.test.tsx`
- `src/core/schemas/summary.ts`

## Write Ownership

Primary files:

```text
src/features/summary/components/summary-checkpoints.tsx
src/features/summary/components/summary-review-packet.tsx
src/features/summary/components/summary-checkpoints.test.tsx
src/features/summary/components/summary-review-packet.test.tsx
```

Expected modified files:

```text
src/features/summary/screen.tsx
src/features/summary/screen.test.tsx
src/features/summary/components/summary-components.test.tsx
```

Do not edit engine/orchestrator files. Do not edit snapshot engine files. Do not change schemas unless the coordinator explicitly returns this brief because `02` missed a required summary rollup.

## Required Behavior

Add compact sections to the summary screen:

### Checkpoints

Show when checkpoint summary data exists:

- checkpoint count
- latest relevant checkpoint
- pre-final-review checkpoint when present
- accepted/rejected run status when present
- exact or compact `snapshot diff` and `snapshot restore` command hints
- conflict/restore safety copy in concise form

### Review Packet

Show when packet summary data exists:

- `review-packet.md` path
- `review-packet.json` path
- final review status
- drift/evidence status already available from summary
- reviewer next-step hint such as "open packet for checklist"

Rendering constraints:

- Keep narrow terminal output readable.
- Do not render full diffs.
- Do not render full `review.md`.
- Do not add in-app instructional blocks beyond concise status/commands.
- Keep the existing summary flow: header, run stats, progress, cost, tasks, evidence, timings, input bar.

## Non-Goals

- No review packet generation.
- No checkpoint storage changes.
- No CLI changes.
- No plan archive or kanban.
- No MCP changes.

## React Constraints

- No `useMemo`.
- No `useCallback`.
- No `React.memo`.
- No `forwardRef`.
- Do not bloat React Context.
- Prefer existing stores/components and simple props.
- Text must fit compact terminals; use existing truncation helpers.

## Validation Commands

Run:

```bash
npm test -- src/features/summary/screen.test.tsx src/features/summary/components/summary-components.test.tsx src/features/summary/components/summary-checkpoints.test.tsx src/features/summary/components/summary-review-packet.test.tsx
npm run typecheck
npm run lint
git diff --check
```

## Expected Final Report

Report:

- files changed
- summary sections added
- narrow terminal behavior considered
- validation commands run and results
- any skipped validation and why
- risks or follow-ups for final validation
