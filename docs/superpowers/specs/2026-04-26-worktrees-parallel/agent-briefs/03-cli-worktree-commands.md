# 03 — CLI — `diptych worktree` Subcommands

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add the `diptych worktree` command group with three subcommands:

- `diptych worktree list` — show all diptych-managed worktrees with branch and session status.
- `diptych worktree switch <name>` — print a shell `cd` command (or emit a shell function hint).
- `diptych worktree remove <name>` — clean up worktree + optional branch with safety guards.

## Read First

- `CLAUDE.md`
- `src/cli.ts` — registration pattern (`registerXCommand(program)`)
- `src/cli/commands/start.ts` — command structure reference
- `src/cli/commands/status.ts` — example of a read-only status command
- `src/engine/git/worktree.ts` — `listWorktrees`, `removeWorktree` (brief 01 output)
- `src/core/paths.ts` — `TREES_DIR`, `worktreePath`
- `src/core/sessions/lifecycle.ts` — `readActive`

## Files To Touch

- `src/cli/commands/worktree.ts` — new file
- `src/cli/commands/worktree.test.ts` — new file
- `src/cli.ts` — register `worktreeCommand`

Do not touch orchestrator, engine, or TUI files in this brief.

## Contract

Create `src/cli/commands/worktree.ts` exporting:

```ts
export function registerWorktreeCommand(program: Command): void;
```

The function attaches a `worktree` commander subcommand with three nested actions: `list`, `switch`, `remove`.

### `diptych worktree list`

```
diptych worktree list [--project <dir>]
```

Output format (plain text, one row per worktree):

```
NAME            BRANCH                  STATUS
my-feature      diptych/my-feature      active  (dip-abc123)
quick-fix       diptych/quick-fix       idle    (dip-def456)
old-experiment  diptych/old-experiment  none
```

- Columns: `NAME`, `BRANCH`, `STATUS`.
- `STATUS` is one of `active`, `idle`, `none` as returned by `listWorktrees`.
- If status is `active` or `idle`, show the session ID in parentheses after the status.
- If `.trees/` does not exist or is empty, print: `No diptych-managed worktrees found.`
- Exit code 0 in all cases.

### `diptych worktree switch <name>`

```
diptych worktree switch <name> [--project <dir>]
```

Diptych cannot change the calling shell's cwd (a subprocess cannot `cd` the parent). Print:

```
To switch to worktree "my-feature", run:
  cd .trees/my-feature

Or add the following shell function to your profile:
  diptych-switch() { cd "$(diptych worktree path "$1")"; }
```

The `worktree path <name>` subcommand is not required in this spec — the above text is the complete output.

Exit with code 0 if the worktree exists; exit with code 1 if `name` is not a known worktree (print an error).

### `diptych worktree remove <name>`

```
diptych worktree remove <name> [--force] [--delete-branch] [--project <dir>]
```

Options:
- `--force` — bypass the live-session guard and uncommitted-changes guard (see ADR-006).
- `--delete-branch` — also delete the `diptych/<name>` branch after removing the worktree.

Behavior:
1. Validate that the named worktree exists (via `listWorktrees`).
2. Call `removeWorktree({ projectDir, slug: name, git, force, deleteBranch })`.
3. On success, print: `Removed worktree ".trees/<name>".` (and `Deleted branch diptych/<name>.` if `--delete-branch`).
4. On failure (guard refusal), print the error and exit with code 1.

## Rules

1. All three subcommands accept `--project <dir>` (consistent with other diptych commands; use `resolveProjectDir` from `src/cli/setup.ts`).
2. `simpleGit` must be instantiated with the resolved `projectDir`.
3. Do not use `process.exit()` directly — throw a `cliError` with the appropriate exit code, consistent with other commands.
4. `worktree switch` does not require the worktree to have an active session; it only needs to exist on disk.
5. Column widths in `worktree list` should adapt to terminal width using `process.stdout.columns` (fallback 80). Minimum column widths: NAME=15, BRANCH=25, STATUS=10.

## Register in `src/cli.ts`

Add:

```ts
import { registerWorktreeCommand } from './cli/commands/worktree.js';
// ...
registerWorktreeCommand(program);
```

## Tests

`src/cli/commands/worktree.test.ts` — mock `listWorktrees` and `removeWorktree`:

- `worktree list` prints headers and one row per `WorktreeInfo` entry
- `worktree list` prints the "no worktrees" message when `listWorktrees` returns `[]`
- `worktree list` shows session ID in parentheses for `active` and `idle` statuses
- `worktree switch <name>` prints the `cd` hint when the worktree exists
- `worktree switch <name>` exits with code 1 when the worktree does not exist
- `worktree remove <name>` calls `removeWorktree` with `force=false` by default
- `worktree remove <name> --force` calls `removeWorktree` with `force=true`
- `worktree remove <name> --delete-branch` calls `removeWorktree` with `deleteBranch=true`
- `worktree remove <name>` prints success message on resolution
- `worktree remove <name>` propagates `cliError` on `removeWorktree` rejection

## Acceptance Criteria

- `diptych worktree list` outputs a correctly formatted table.
- `diptych worktree switch my-feature` prints the `cd` hint and exits 0.
- `diptych worktree remove my-feature` delegates to `removeWorktree` with correct options.
- `src/cli/commands/worktree.ts` does not import from `react`, `ink`, or `src/features/`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/cli/commands/worktree.test.ts
npm run typecheck
npm run lint
```
