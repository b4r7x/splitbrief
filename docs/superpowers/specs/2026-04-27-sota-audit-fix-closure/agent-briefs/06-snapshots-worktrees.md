# 06 - Snapshots, Worktrees

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Close snapshot/worktree acceptance gaps while preserving the newer full-tree snapshot architecture.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-22-safe-snapshots-worktrees-parallel/README.md`
- `docs/superpowers/specs/2026-04-22-safe-snapshots-worktrees-parallel/decisions.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/decisions.md`
- `docs/superpowers/specs/2026-04-26-worktrees-parallel/README.md`
- `docs/superpowers/specs/2026-04-26-worktrees-parallel/decisions.md`
- `src/core/paths.ts`
- `src/core/schemas/snapshot.ts`
- `src/engine/snapshots/store.ts`
- `src/engine/snapshots/run.ts`
- `src/engine/implementers/apply.ts`
- `src/engine/implementers/base.ts`
- `src/engine/git/worktree.ts`
- `src/cli/commands/start.ts`
- `src/cli/commands/worktree.ts`

## Scope

**In bounds:**

- Add per-run ledger compatibility for safe snapshots.
- Durable run accept/reject state independent of snapshot names.
- `.gitignore` filtering that uses git-compatible matching, preferably `simple-git checkIgnore`.
- Dirty source worktree guard before `start --worktree`.
- Resolve `start --detach --worktree` ordering with brief 01.
- Worktree registry output/discovery contract.
- Force-removal warnings with session id and uncommitted file count.
- Tests for snapshot run ledger, gitignore behavior, worktree CLI output.

**Out of bounds:**

- Replacing full-tree baseline/delta snapshots.
- Implementing `--parallel N` fan-out.
- Windows worktree support beyond existing project behavior.
- New Git library dependencies.

## Required Fixes

### 1. Add run ledger compatibility

Preserve the existing full-tree snapshot store. Add a run ledger under the session snapshot area that records:

- run snapshot id(s),
- `accepted`,
- `rejected`,
- `beforeHash`,
- `lastDiptychHash`,
- timestamp and task/session identifiers where available.

Accept/reject operations must update this ledger, not infer state only from the latest snapshot name.

### 2. Track apply-time writes where required

If the safe-run snapshot spec requires apply-time write tracking, pass an optional snapshot/run context through the implementer apply path without changing normal apply behavior.

### 3. Use git-compatible ignore matching

Snapshot inclusion/exclusion must honor root `.gitignore` semantics using `simple-git checkIgnore` or an equivalent already-available git-compatible path. Avoid custom prefix-only parsing for correctness-sensitive filtering.

Tests must cover ignored directories, glob patterns, negation, and always-excluded `.git`, `.diptych`, and `node_modules`.

### 4. Guard dirty source before worktree creation

`start --worktree` must refuse to create/use a worktree when the source working tree is dirty, according to the original worktree spec. There is no `--force` bypass for `start`.

### 5. Resolve worktree start semantics

The older v1 spec said to print a follow-up `cd ...; diptych start ...` command and stop. The newer 2026-04-26 worktree spec continues the workflow in the new worktree. Implement the newer behavior, but document the migration and make tests explicit.

### 6. `--detach --worktree` works

The `start` command must apply worktree selection before spawning the detached server, so the detached server runs in the worktree project directory.

Ordering:

1. Resolve `--worktree` against the base project.
2. Create/select the worktree.
3. Run session directory creation, migration, config resolution, and daemon spawn from the worktree root.
4. Print an attach command for the session in that worktree.

### 7. Registry output matches contract

Worktree listing/status must expose path, branch, session id, phase or unknown, and last-updated or unknown. If the command name remains `diptych worktree list`, docs must be consistent; if `diptych worktrees` or `status --worktrees` exists, tests must cover it.

### 8. Force removal warning is specific

Force removal warnings must include live session id when known and uncommitted file count when known.

## Acceptance Criteria

- Run accept/reject state remains correct after later snapshots are created.
- Snapshot ignore behavior matches `git check-ignore` fixtures.
- `start --worktree` refuses dirty source trees.
- `start --worktree` has no force bypass for dirty source trees.
- `start --detach --worktree` runs the detached workflow inside the worktree.
- Worktree registry output includes path, branch, session id, phase, and last updated.
- Force-removal warning includes session id and uncommitted count when available.
- Existing snapshot create/list/restore/diff behavior still passes.

## Tests

Add or update tests for:

- accept/reject ledger durability after additional snapshots,
- apply path with optional snapshot context,
- `.gitignore` fixture parity,
- dirty source refusal,
- detach/worktree ordering,
- registry output fields,
- force removal warning details.

## Verification Commands

```bash
npm test -- src/engine/snapshots src/engine/git src/cli/commands/start.test.ts src/cli/commands/worktree.test.ts
npm run typecheck
npm run lint
npm test
```
