# 05 — Snapshot Diff

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add `diptych snapshot diff <id-or-name>` — a CLI command that prints a unified text diff between the current working tree and a named/id'd snapshot.

This brief assumes briefs 01 and 02 are complete: schema, path helpers, `readManifest`, `listSnapshotIds`, `resolveSnapshot` (from brief 03), and `encodeSnapshotPath` exist.

This brief is self-contained and can run in parallel with briefs 03 and 04 as long as neither agent edits `src/cli/commands/snapshot.ts` at the same time.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts` — `snapshotFilesDir`, `snapshotDir`
- `src/core/schemas/snapshot.ts` — `SnapshotManifest`, `SnapshotFileEntry`
- `src/engine/snapshots/store.ts` — `readManifest`, `collectTrackedFiles`, `hashFile`, `encodeSnapshotPath`
- `src/engine/snapshots/restore.ts` — `resolveSnapshot` (use this to resolve `idOrName` to a manifest)
- `src/cli/commands/snapshot.ts` — existing `create`, `list`, `restore` subcommands (add `diff` here)

## Files To Touch

- `src/engine/snapshots/diff.ts` — new file
- `src/engine/snapshots/diff.test.ts` — new file
- `src/cli/commands/snapshot.ts` — add `diff` subcommand

Do not touch orchestrator, config, events, or paths files in this brief.

## Engine Function Contract

Create `src/engine/snapshots/diff.ts`:

```ts
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';

export type FileDiff = {
  path: string;
  // 'unchanged' | 'modified' | 'added' | 'removed'
  // added   = file exists now but not in snapshot (untracked at snapshot time)
  // removed = file was in snapshot but no longer on disk
  // modified = file exists in both but contents differ
  // unchanged = hashes match
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  // unified diff text — populated only for status 'modified'
  diff?: string;
};

export type SnapshotDiffResult = {
  snapshotId: string;
  files: FileDiff[];
  changedCount: number;  // modified + added + removed
};

export type DiffOptions = {
  projectDir: string;
  sessionId: string;
  manifest: SnapshotManifest;
  // Limit diff to these paths (project-relative). All paths if undefined.
  paths?: string[];
};

// Computes a diff between the current working tree and the snapshot.
// Returns one FileDiff per tracked file. Files not in snapshot but present
// on disk (and in tracked scope) are marked 'added'. Files in snapshot but
// absent from disk are marked 'removed'.
export async function computeSnapshotDiff(opts: DiffOptions): Promise<SnapshotDiffResult>;

// Render a SnapshotDiffResult as a human-readable string (unified diff format).
// Suitable for printing to stdout.
export function formatSnapshotDiff(result: SnapshotDiffResult, opts?: { color?: boolean }): string;
```

### `computeSnapshotDiff` Implementation Steps

The diff must account for the baseline + delta storage model. `manifest.fileHashes` covers all tracked paths. `manifest.fileEntries` only lists delta files (those stored in the snapshot's own `files/`). Unchanged files must be read from the baseline.

1. Read baseline manifest: `const baselineManifest = await readManifest(opts.projectDir, opts.sessionId, 'baseline')`.
2. Build `snapshotDeltaSet: Set<string>` from `manifest.fileEntries.map(e => e.path)`.
3. Build `allSnapshotPaths: Set<string>` from `Object.keys(manifest.fileHashes)` — these are the paths tracked at snapshot time.
4. Collect current tracked files: `await collectTrackedFiles(opts.projectDir)` → `currentPaths`.
5. Build the union: `new Set([...allSnapshotPaths, ...currentPaths])`.
6. If `opts.paths` is provided, filter the union to only those paths.
7. For each path in the union:
   a. `const inSnapshot = manifest.fileHashes[path] !== undefined`.
   b. `const currentHash = await hashFile(join(opts.projectDir, path))`. (null = does not exist on disk)
   c. `const snapshotHash = manifest.fileHashes[path] ?? null`.
   d. If `!inSnapshot && currentHash !== null` → `status: 'added'`.
   e. If `inSnapshot && currentHash === null` → `status: 'removed'`.
   f. If `snapshotHash === currentHash` → `status: 'unchanged'`.
   g. If hashes differ (both exist) → `status: 'modified'`. Generate unified diff:
      - Resolve snapshot file path (two-step — same as restore brief):
        - If `snapshotDeltaSet.has(path)` → `join(snapshotFilesDir(opts.projectDir, opts.sessionId, opts.manifest.id), encodedName)`.
        - Else → `join(snapshotFilesDir(opts.projectDir, opts.sessionId, 'baseline'), baselineEncodedName)`.
      - Read snapshot file contents from resolved path.
      - Read current file from disk.
      - Generate diff using the built-in approach described below.
8. Return `{ snapshotId: manifest.id, files, changedCount }`.

### Generating Unified Diff Without a Library

Use `node:child_process` `spawnSync(['diff', '-u', '--label', 'snapshot/<path>', '--label', 'current/<path>', snapshotFile, currentFile])` if `diff` is available (POSIX systems). Capture stdout.

If `diff` is not available (check by catching ENOENT), fall back to a minimal two-pass differ:
- Split both strings on `\n`.
- Produce a simple `---` / `+++` header with a `@@` hunk showing every changed line.
- This is sufficient for v1; it does not need to be a perfect LCS diff.

Do not add a `diff` npm package dependency.

### `formatSnapshotDiff` Implementation

- Print a header: `Snapshot: <id>  (<createdAt>)`.
- For each `FileDiff` with `status !== 'unchanged'`:
  - `modified`: print the `diff` text.
  - `added`: print `+++ <path>  (added after snapshot)`.
  - `removed`: print `--- <path>  (removed after snapshot)`.
- If `color: true` (default `true` in CLI), wrap headers in `ansis` dim/cyan.
- If no files changed: print `No differences from snapshot <id>.`.
- Print a summary line at the end: `<n> file(s) changed (modified: <m>, added: <a>, removed: <r>)`.

## CLI Command

Add to `src/cli/commands/snapshot.ts`:

```ts
snapshot
  .command('diff <id-or-name>')
  .description('Show diff between current working tree and a snapshot')
  .option('--session <id>', 'Session ID (defaults to active session)')
  .option('--no-color', 'Disable color output')
  .action(async (idOrName: string, opts) => { /* ... */ });
```

### `diff` action implementation

1. Resolve `projectDir` and `sessionId` as in other subcommands.
2. Call `resolveSnapshot(projectDir, sessionId, idOrName)` → `manifest` (import from `src/engine/snapshots/restore.js`).
3. Call `computeSnapshotDiff({ projectDir, sessionId, manifest })` → `result`.
4. Call `formatSnapshotDiff(result, { color: opts.color !== false })`.
5. Print the formatted output to stdout.
6. Exit 0 if `result.changedCount === 0`, exit 1 if any changes (mirrors `git diff` convention for shell scripting).

Handle errors (snapshot not found, ambiguous name) via `cliError`.

## Tests

`src/engine/snapshots/diff.test.ts` — use real temp directories:

- `computeSnapshotDiff` returns `unchanged` for all files immediately after snapshot (no changes)
- `computeSnapshotDiff` returns `modified` for a file with changed content
- `computeSnapshotDiff` returns `added` for a new file created after the snapshot
- `computeSnapshotDiff` returns `removed` for a file deleted after the snapshot
- `formatSnapshotDiff` returns "No differences" string when changedCount is 0
- `formatSnapshotDiff` includes the snapshot ID in the header
- `formatSnapshotDiff` includes a summary line with correct counts

## Acceptance Criteria

- `computeSnapshotDiff` and `formatSnapshotDiff` are exported from `src/engine/snapshots/diff.ts`.
- `diptych snapshot diff <id>` works end-to-end on a temp project.
- No new npm dependencies.
- No React / Ink / features imports in `src/engine/snapshots/diff.ts`.
- `npm run test-ci` passes.

## Constraints

- Do not create `src/engine/snapshots/index.ts`.
- Do not import from `simple-git` in this brief — `computeSnapshotDiff` owns its own file-reading.
- The `diff` binary fallback is POSIX-only; on Windows, always use the manual two-pass differ. Detect with `process.platform !== 'win32'`.

## Escalation

If `resolveSnapshot` is not yet exported from `src/engine/snapshots/restore.ts` (brief 03 may not be done), implement a local inline resolution using `listSnapshotIds` + `readManifest` directly in `diff.ts`, and refactor to import from `restore.ts` once brief 03 is merged.

## Evidence Requirements

- `npm test -- src/engine/snapshots/diff.test.ts` passes with zero skips.
- A manual smoke test: create snapshot, edit a file, run `diptych snapshot diff <id>`, verify the changed file appears in the output.

## Verification Commands

```bash
npm test -- src/engine/snapshots/diff.test.ts src/cli/commands/snapshot.test.ts
npm run typecheck
npm run lint
npm test
```
