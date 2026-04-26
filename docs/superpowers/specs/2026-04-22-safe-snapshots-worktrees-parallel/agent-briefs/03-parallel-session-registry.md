# 03 — Parallel Session Registry

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add read-only visibility into active diptych sessions across related worktrees and document the safe parallel model.

This is not same-directory parallel execution.

## Read First

- `docs/CONCEPTS.md` section "Sessions"
- `docs/FUTURE.md` section "Parallel sessions in the same project"
- `src/cli/commands/status.ts`
- `src/core/sessions/io.ts`
- `src/lib/git.ts`
- `src/features/sessions/picker.tsx`

## Files To Touch

- `src/core/sessions/worktrees.ts` new
- `src/core/sessions/worktrees.test.ts` new
- `src/cli/commands/status.ts` or new `src/cli/commands/worktrees.ts`
- `src/cli.ts`
- `docs/WORKFLOW.md`
- `docs/CONCEPTS.md`

## Behavior

Add command:

```bash
diptych worktrees
```

or if command grouping is not established:

```bash
diptych status --worktrees
```

Output:

- worktree path,
- branch,
- active diptych session id or `none`,
- phase or `unknown` if `state.json` is unreadable,
- last updated timestamp or `unknown`.

No writes.

## Guardrails

- Keep one active session per worktree.
- Do not support parallel task execution in the same checkout.
- If a future command tries to start same-dir parallel work, error and suggest `--worktree`.

## Tests

- parses sample `git worktree list --porcelain` output.
- finds `.diptych/active` in temp worktree dirs.
- missing/corrupt state is reported as unknown, not crash.
- command output includes branch/path/session.

## Acceptance Criteria

- Users can see parallel diptych runs across worktrees.
- Docs clearly explain worktree-based parallelism.
- No source mutations.

## Verification Commands

```bash
npm test -- src/core/sessions/worktrees.test.ts
npm run typecheck
npm run lint
npm test
```
