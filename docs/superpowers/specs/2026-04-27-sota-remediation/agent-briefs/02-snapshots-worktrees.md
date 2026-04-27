# 02 - Snapshots and Worktrees

> Implement only this brief. Never stage, commit, or stash.

## Goal

Make snapshot storage safe and make worktree commands satisfy their specs without side effects on invalid input.

## File Ownership

- `src/engine/snapshots/store.ts`
- `src/engine/snapshots/restore.ts`
- `src/engine/snapshots/run.ts`
- `src/core/schemas/snapshot.ts`
- `src/engine/git/worktree.ts`
- `src/cli/commands/snapshot.ts`
- `src/cli/commands/start.ts` only for worktree validation/order
- `src/cli/commands/worktree.ts`
- matching tests/docs touched by this brief

## Required Changes

1. Collision-free snapshot blob names:
   - Replace `path.replaceAll('/', '__')` style encoding with a collision-free encoding.
   - Acceptable options: hex/base64url of the relative path, or per-entry content-addressed filenames with manifest lookup.
   - Add a test proving `a/b.ts` and `a__b.ts` store and restore distinct contents.

2. Exclude `.trees/` unconditionally:
   - Add `TREES_DIR` to non-negotiable snapshot exclusions.
   - Do not rely on the user adding `.trees/` to `.gitignore`.
   - Add tests for `.trees/<name>/file.ts` never appearing in snapshot manifest.

3. Verify stored blobs before restore:
   - Compare stored blob hash against manifest hash before writing.
   - If mismatch, add to `missingSnapshotFiles` or a new corruption list and do not write the file.
   - Add a corruption test.

4. Reject-run conflict retry:
   - Do not set run ledger `rejected: true` when `conflictedPaths` or `missingSnapshotFiles` is non-empty.
   - A second `/reject-run confirm` after user resolves conflicts must retry and report accurate remaining results.
   - Add tests for conflict then retry.

5. Run snapshot identity:
   - `rejectRunSnapshot()` must use the run ledger's run snapshot IDs, not an unrelated latest manual snapshot.
   - If no run ledger exists, return `empty` or a compatibility error rather than guessing from latest snapshot.

6. First manual snapshot UX:
   - If the first snapshot is only a hidden baseline, do not print `Snapshot created: baseline` as a user snapshot.
   - Either create a visible manual snapshot after baseline, or print a clear message and make list behavior consistent.
   - Add CLI test for create followed by list.

7. Worktree validation:
   - Validate explicit worktree names. Reject empty names, names with `/`, `..`, path separators, shell-sensitive names, or names that would resolve outside `.trees`.
   - Add tests.

8. Invalid detach/worktree combinations:
   - Validate `--detach requires feature` and `--detach cannot combine with --json` before creating worktrees.
   - Add a test proving invalid command creates no `.trees/<slug>` and no `diptych/<slug>` branch.

9. Dirty source guard:
   - `start --worktree` must refuse dirty source worktrees before creation.
   - Exclude `.trees/` itself from the dirty check.
   - Add tests for dirty source refusal and clean source success.

## Acceptance Criteria

- Snapshot storage has no path encoding collisions.
- Snapshot restore never writes corrupted blobs.
- `.trees/` is always excluded.
- Reject-run remains retryable after conflicts.
- Worktree names are safe and manageable.
- Invalid `start --detach --worktree` combinations have no side effects.
- `start --worktree` refuses dirty source.

## Tests

Run:

```bash
npm test -- src/engine/snapshots src/engine/git/worktree.test.ts src/cli/commands/snapshot.test.ts src/cli/commands/start.test.ts src/cli/commands/worktree.test.ts
npm run typecheck
npm run lint
```

