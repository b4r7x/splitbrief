# 02 — Worktree Start

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add a convenience path for starting a diptych run in a new git worktree.

This enables parallel work without sharing one working tree.

## Command

```bash
diptych start --worktree <branch-or-name> "feature prompt"
```

Optional future shape:

```bash
diptych worktree start <branch-or-name> "feature prompt"
```

Implement only `diptych start --worktree <name> "feature prompt"` in v1.

## Read First

- `docs/FUTURE.md` section "Parallel sessions in the same project"
- `src/cli/commands/start.ts`
- `src/cli/setup.ts`
- `src/lib/git.ts`
- `docs/WORKFLOW.md`

## Files To Touch

- `src/cli/commands/start.ts`
- `src/cli/options.ts`
- `src/lib/git.ts`
- `src/lib/git.test.ts`
- `src/cli/commands/start.test.ts`
- `docs/WORKFLOW.md`

## Behavior

When `--worktree <name>` is passed:

1. Verify current project is a git repo.
2. Refuse if working tree has uncommitted changes unless a safe existing helper already permits worktree creation without risk. Do not add `--force` in v1.
3. Create a sibling worktree path. Suggested default:

```text
../<repo-name>-<sanitized-name>
```

4. Create branch if missing.
5. Print the exact command the user should run inside the new worktree:

```bash
cd <worktree-path>
diptych start "<feature prompt>"
```

Do not spawn a nested `diptych` process in v1.

## Constraints

- Do not stage or commit.
- Do not run two sessions in one `.diptych/active`.
- Worktree gets its own `.diptych/`.
- Branch/worktree names must be sanitized.

## Tests

- command parses `--worktree`.
- git helper builds safe worktree path.
- dirty tree refuses.
- existing worktree path refuses with clear message.
- command prints the follow-up `cd ... && diptych start ...` instructions.
- no git staging/commit commands are introduced.

## Acceptance Criteria

- User has a one-command path to isolated worktree setup.
- Same-directory active lock remains unchanged.
- Docs explain parallel work via worktrees.

## Verification Commands

```bash
npm test -- src/lib/git.test.ts src/cli/commands/start.test.ts
npm run typecheck
npm run lint
npm test
```
