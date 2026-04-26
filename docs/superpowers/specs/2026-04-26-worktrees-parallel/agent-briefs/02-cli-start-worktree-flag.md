# 02 — CLI — `diptych start --worktree` Flag

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Extend `diptych start` with a `--worktree [name]` flag. When the flag is present:

1. Derive or accept the worktree slug.
2. Call `createWorktree` (from brief 01) to create the linked worktree.
3. `cd` into the worktree and run the session there — or spawn a subprocess, per the approach below.
4. The session runs with `projectDir` set to the new worktree root.

## Read First

- `CLAUDE.md`
- `src/cli/commands/start.ts` — existing start command structure
- `src/cli/options.ts` — `addWorkflowOptions` pattern
- `src/cli/setup.ts` — `resolveProjectDir`, `setupWorkflow`
- `src/core/types/config-options.ts` — `WorkflowOpts` type
- `src/engine/git/worktree.ts` — `createWorktree`, `detectWorktree` (brief 01 output)
- `src/core/paths.ts` — `TREES_DIR`, `worktreePath` (brief 01 additions)
- `src/utils/slugify.ts` — slugify utility for deriving slug from feature name

## Files To Touch

- `src/core/types/config-options.ts` — add `worktree?: string` to `WorkflowOpts`
- `src/cli/options.ts` — add `--worktree [name]` option to `addWorkflowOptions`
- `src/cli/commands/start.ts` — handle `opts.worktree` before the main workflow

Do not touch the TUI, orchestrator, or session files in this brief.

## Contract

### `WorkflowOpts` extension

Add to `WorkflowOpts` in `src/core/types/config-options.ts`:

```ts
// When present, start the session in a new linked worktree.
// Value is the worktree slug (directory name under .trees/).
// If the flag is passed with no value, the feature argument is slugified.
worktree?: string;
```

### `addWorkflowOptions` extension

Add to `src/cli/options.ts` inside `addWorkflowOptions`:

```ts
.option('--worktree [name]', 'run in a new linked git worktree (.trees/<name>)')
```

### `start.ts` behavior

Before `resolveProjectDir` is called for the session, add a worktree branch:

```ts
if (opts.worktree !== undefined) {
  // Derive slug: if opts.worktree is a non-empty string use it; otherwise slugify the feature.
  const slug = opts.worktree || slugify(feature ?? 'session');
  const baseProjectDir = resolveProjectDir(opts.project);
  const git = simpleGit(baseProjectDir);
  const worktreePath = await createWorktree({ projectDir: baseProjectDir, slug, git });
  // Re-run the rest of start with projectDir pointing to the worktree.
  opts.project = worktreePath;
}
```

The remaining start logic is unchanged — it resolves `projectDir` from `opts.project`, which is now the worktree root.

## Rules

1. If `--worktree` is supplied with no value (bare flag), `opts.worktree` will be `true` in commander (the `[name]` makes the value optional). Normalize: if `typeof opts.worktree !== 'string'`, set slug to `slugify(feature ?? 'session')`.
2. If `createWorktree` throws (e.g. branch already exists), re-throw as a `cliError` with the original message and `exitCode: 1`.
3. Do not require `--worktree` to be combined with a feature argument — if no feature is given, the user is dropped into the interactive home screen inside the worktree (same as normal `diptych start`).
4. Print a confirmation line before starting the session:
   ```
   Starting session in worktree .trees/<slug> (branch diptych/<slug>)
   ```
   Use `process.stdout.write` or `console.log`; do not use a TUI event for this line.

## Tests

`src/cli/commands/start.test.ts` — add focused unit tests (mock `createWorktree`):

- `--worktree my-feature` sets slug to `my-feature` and calls `createWorktree` with `{ slug: 'my-feature', ... }`
- `--worktree` (no value) with feature `"add auth"` sets slug to `add-auth` (slugified)
- `--worktree` (no value) with no feature argument falls back to slug `session`
- When `createWorktree` throws, the error is wrapped as a `cliError` with exit code 1
- After successful `createWorktree`, `opts.project` is set to the returned worktree path

Do not write integration tests that actually create git worktrees in this brief — that is tested in `01-worktree-manager.md`.

## Acceptance Criteria

- `diptych start --worktree my-feature "implement X"` creates `.trees/my-feature` and runs the session there.
- `diptych start --worktree "implement X"` creates `.trees/implement-x` (slugified).
- On `createWorktree` failure, a clean error is printed and the process exits with code 1.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/cli/commands/start.test.ts
npm run typecheck
npm run lint
```
