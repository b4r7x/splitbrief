# 01 — Worktree Manager

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add the engine-side foundation for git worktree management:

1. Path constants and helper in `src/core/paths.ts`.
2. Four pure engine functions in `src/engine/git/worktree.ts`: `createWorktree`, `listWorktrees`, `removeWorktree`, `detectWorktree`.
3. Colocated tests in `src/engine/git/worktree.test.ts`.

All subsequent briefs (02, 03, 04) import from `src/engine/git/worktree.ts`. Get this right first.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts` — understand the existing constant + helper pattern
- `src/core/sessions/lifecycle.ts` — understand how `.diptych/active` and session state are read
- `src/core/paths.ts` — `sessionDir`, `diptychDir` helpers
- `docs/LAYERS.md` — confirm `engine/` placement for git operations

## Files To Touch

- `src/core/paths.ts` — add `TREES_DIR` constant + `worktreePath` helper
- `src/engine/git/worktree.ts` — new file
- `src/engine/git/worktree.test.ts` — new file

Do not touch any CLI, TUI, or orchestrator files in this brief.

## Path Constants

Add to `src/core/paths.ts` (after the existing `HANDOFF_MANIFEST_FILE` line):

```ts
export const TREES_DIR = '.trees';

export const worktreePath = (projectDir: string, slug: string): string =>
  join(projectDir, TREES_DIR, slug);
```

## Contract

Create `src/engine/git/worktree.ts` with exactly these exports:

```ts
import type { SimpleGit } from 'simple-git';

export type WorktreeStatus = 'active' | 'idle' | 'none';

export type WorktreeInfo = {
  // Name is the slug used as the directory name under .trees/
  name: string;
  // Absolute path to the worktree root
  path: string;
  // Git branch name checked out in the worktree (e.g. "diptych/my-feature")
  branch: string;
  // Whether a diptych session is active, idle (complete), or absent in this worktree
  status: WorktreeStatus;
  // The active or most-recent session ID, or null if no session has ever run
  sessionId: string | null;
};

export type CreateWorktreeOptions = {
  projectDir: string;
  // Slug used as both directory name (.trees/<slug>) and branch suffix (diptych/<slug>)
  slug: string;
  git: SimpleGit;
};

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: SimpleGit;
  // If true, bypass the live-session guard and the uncommitted-changes guard
  force?: boolean;
};

// Create a linked worktree at .trees/<slug> on branch diptych/<slug>.
// Throws if the branch already exists.
// Returns the absolute path to the new worktree.
export async function createWorktree(opts: CreateWorktreeOptions): Promise<string>;

// List all diptych-managed worktrees (directories under .trees/ that are git worktrees).
// Non-git directories under .trees/ are silently skipped.
// Returns [] if .trees/ does not exist.
export async function listWorktrees(projectDir: string, git: SimpleGit): Promise<WorktreeInfo[]>;

// Remove a worktree and optionally delete the branch.
// Guards (unless force=true):
//   1. Refuse if the worktree has a live diptych session (active + non-complete state).
//   2. Refuse if the worktree has uncommitted changes.
// Each bypassed guard must be printed to stderr.
// Does not delete the branch unless the caller passes deleteBranch=true.
export async function removeWorktree(
  opts: RemoveWorktreeOptions & { deleteBranch?: boolean },
): Promise<void>;

// Detect whether the current working directory is inside a diptych-managed linked worktree.
// Returns the slug (worktree name) if inside a linked worktree, or null if in the main tree
// or if detection fails.
// Detection: compare `git rev-parse --git-dir` vs `git rev-parse --git-common-dir`.
// If they differ, the cwd is in a linked worktree; extract the slug from the worktree path.
export async function detectWorktree(projectDir: string, git: SimpleGit): Promise<string | null>;
```

## Rules

### `createWorktree`

1. Derive `branch = 'diptych/' + slug` and `worktreePath = join(projectDir, TREES_DIR, slug)`.
2. Check whether the branch already exists via `git.branch()`. If it does, throw:
   ```
   Branch diptych/<slug> already exists. Use --worktree <other-name> or delete the branch first.
   ```
3. Run `git worktree add <worktreePath> -b <branch>` via `simple-git`.
4. Return the absolute worktree path.

### `listWorktrees`

1. If `.trees/` does not exist, return `[]`.
2. Read directory entries under `.trees/`. For each entry that is a directory:
   a. Check whether it is a linked git worktree by testing if `.git` inside it is a file (linked worktrees have `.git` as a file pointing back to the main `.git/`).
   b. Read the branch name from the `HEAD` ref inside the `.git` file pointer's `gitdir`.
   c. Determine `status` by reading `.diptych/active` inside the worktree:
      - If `.diptych/active` does not exist → `'none'`.
      - If `.diptych/active` exists, read the session ID, then read the session state file (`state.json`). If `phase` is `'complete'` or `'idle'` → `'idle'`. Otherwise → `'active'`.
   d. Populate `sessionId` from `.diptych/active` content (trim whitespace), or `null`.
3. Return all valid entries sorted by `name` ascending.

### `removeWorktree`

1. Resolve the worktree path: `join(projectDir, TREES_DIR, slug)`.
2. If the worktree directory does not exist, throw: `Worktree ".trees/<slug>" does not exist.`
3. **Live-session guard** (unless `force`): read `.diptych/active` in the worktree. If it exists and the session state is not `complete` / `idle`, refuse:
   ```
   Worktree ".trees/<slug>" has a live session <id>. Stop the session first, or use --force.
   ```
4. **Uncommitted-changes guard** (unless `force`): run `git -C <worktreePath> status --porcelain`. If the output is non-empty, refuse:
   ```
   Worktree ".trees/<slug>" has uncommitted changes. Commit or stash them, or use --force.
   ```
5. If `force` bypassed either guard, print a warning to stderr for each bypassed guard (see ADR-006).
6. Run `git worktree remove <worktreePath> --force` (the git `--force` here is for git's own safety check; it is always passed so the engine controls the guards, not git).
7. If `deleteBranch` is true, run `git branch -D diptych/<slug>`.

### `detectWorktree`

1. Run `git -C <projectDir> rev-parse --git-dir` and `git -C <projectDir> rev-parse --git-common-dir`.
2. If both return the same path (or `--git-common-dir` is not supported), return `null` (main tree).
3. If they differ, the cwd is in a linked worktree. Derive the slug:
   - The worktree path is the resolved `projectDir`. Look for `.trees/` in the path segments.
   - Extract the segment immediately after `.trees/` as the slug.
   - If extraction fails, return `null`.
4. On any error (not a git repo, git not found), return `null`.

## Tests

Use `node:os` `tmpdir()` + `mkdtemp` for real temp git repositories. Initialize a bare git repo, create an initial commit, then run tests. Clean up in `afterEach`.

Required test cases:

- `createWorktree` creates a directory at `.trees/<slug>` with a `.git` file
- `createWorktree` creates a branch named `diptych/<slug>` in the main repo
- `createWorktree` throws when the branch `diptych/<slug>` already exists
- `listWorktrees` returns `[]` when `.trees/` does not exist
- `listWorktrees` returns one entry after `createWorktree`
- `listWorktrees` reports `status: 'none'` when no `.diptych/active` exists in the worktree
- `listWorktrees` reports `status: 'active'` when `.diptych/active` exists and state is `implementing`
- `listWorktrees` reports `status: 'idle'` when state is `complete`
- `removeWorktree` removes the directory and the git worktree registration
- `removeWorktree` throws for a non-existent worktree
- `removeWorktree` refuses when a live session exists (without `force`)
- `removeWorktree` refuses when uncommitted changes exist (without `force`)
- `removeWorktree` proceeds with `force=true` and logs both bypassed guards to stderr
- `removeWorktree` deletes the branch when `deleteBranch=true`
- `detectWorktree` returns `null` in the main worktree
- `detectWorktree` returns the slug when called from inside a linked worktree
- `detectWorktree` returns `null` on error (non-git directory)

## Acceptance Criteria

- All exports match the signatures above exactly.
- No classes. No barrels. Do not create `src/engine/git/index.ts`.
- `src/engine/git/worktree.ts` does not import from `react`, `ink`, `src/features/`, or `src/components/`.
- `npm run test-ci` passes.

## Constraints

- `simple-git` is already in the project — do not add a new git dependency.
- Do not shell out via `node:child_process` for git operations; use `simple-git` consistently.
- For `removeWorktree` step 4 (uncommitted changes), use `git.raw(['status', '--porcelain'])`.

## Verification Commands

```bash
npm test -- src/engine/git/worktree.test.ts
npm run typecheck
npm run lint
```
