# 03 — Snapshot Restore

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add `restoreSnapshot` engine function with hash-guard semantics and wire it to the CLI subcommand `diptych snapshot restore <id-or-name> [--force]`.

This brief assumes briefs 01 and 02 are complete: schema, path helpers, low-level storage helpers, `createSnapshot`, `listSnapshots`, and the `snapshot_created` event variant all exist.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts` — `snapshotManifestPath`, `snapshotFilesDir`, `snapshotDir`
- `src/core/schemas/snapshot.ts` — `SnapshotManifest`, `SnapshotFileEntry`
- `src/engine/snapshots/store.ts` — `readManifest`, `listSnapshotIds`, `hashFile`, `acquireSnapshotLock`, `decodeSnapshotPath`, `hasBaseline`
- `src/core/paths.ts` — `baselineDir`, `snapshotFilesDir`, `SNAPSHOT_BASELINE_ID`
- `src/engine/events/types.ts` — existing event variant structure
- `src/cli/commands/snapshot.ts` — existing `create` + `list` subcommands (add `restore` here)

## Files To Touch

- `src/engine/snapshots/restore.ts` — new file
- `src/engine/snapshots/restore.test.ts` — new file
- `src/engine/events/types.ts` — add `snapshot_restored` and `snapshot_restore_conflict` event variants
- `src/cli/commands/snapshot.ts` — add `restore` subcommand

Do not touch orchestrator or config files in this brief.

## Engine Function Contract

Create `src/engine/snapshots/restore.ts`:

```ts
import type { EventBus } from '../events/types.js';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';

export type RestoreResult = {
  snapshotId: string;
  restoredPaths: string[];
  conflictedPaths: string[];
  forcedPaths: string[];       // populated when --force is used
  missingSnapshotFiles: string[];  // files in manifest but missing from files/ dir
};

export type RestoreOptions = {
  projectDir: string;
  sessionId: string;
  // id may be a snapshot ID ("2026-04-26T14-30-00-000Z") or a name ("before-refactor")
  idOrName: string;
  force?: boolean;
  bus?: EventBus;
};

// Restores the working tree to a snapshot state.
// - Resolves idOrName to a manifest (throws if ambiguous name match).
// - Acquires the session snapshot lock.
// - Per file: compares current hash to manifest hash.
//   - Match → restore safely.
//   - Mismatch + force=false → conflict (skip, record).
//   - Mismatch + force=true → restore anyway, record in forcedPaths.
// - Missing snapshot file → record in missingSnapshotFiles, skip.
// - Releases lock in finally.
// - Emits snapshot_restored event on success.
export async function restoreSnapshot(opts: RestoreOptions): Promise<RestoreResult>;

// Resolve idOrName to a manifest:
// 1. Try readManifest(projectDir, sessionId, idOrName) — exact ID match.
// 2. If not found, scan all manifests for name === idOrName.
//    - 0 matches → throw `"No snapshot found with id or name: <idOrName>"`.
//    - 1 match → use it.
//    - 2+ matches → throw `"Ambiguous snapshot name '<name>': matches <id1>, <id2>. Use the snapshot ID directly."`.
export async function resolveSnapshot(
  projectDir: string,
  sessionId: string,
  idOrName: string,
): Promise<SnapshotManifest>;
```

### `restoreSnapshot` Implementation Steps

1. Call `resolveSnapshot` → `manifest`.
2. Call `acquireSnapshotLock(projectDir, sessionId)` → release fn.
3. Read baseline manifest: `const baselineManifest = await readManifest(projectDir, sessionId, 'baseline')`.
   - If baseline is missing, throw: `"Baseline snapshot missing for session <sessionId>. Cannot restore."`.
4. Initialize `restoredPaths`, `conflictedPaths`, `forcedPaths`, `missingSnapshotFiles`.
5. Build `snapshotFileSet: Set<string>` from `manifest.fileEntries.map(e => e.path)` (paths with delta copies).
6. Iterate over `Object.keys(manifest.fileHashes)` (every tracked path at snapshot time):
   a. `const absPath = join(projectDir, path)`.
   b. **Resolve source file path** (two-step reconstruction):
      - If `snapshotFileSet.has(path)` → find entry in `manifest.fileEntries`, use `join(snapshotFilesDir(projectDir, sessionId, manifest.id), entry.encodedName)`.
      - Else → find entry in `baselineManifest.fileEntries`, use `join(snapshotFilesDir(projectDir, sessionId, 'baseline'), entry.encodedName)`.
   c. Check source file path exists. If not → push to `missingSnapshotFiles`, continue.
   d. `const currentHash = await hashFile(absPath)`. (null = file does not exist on disk)
   e. `const snapshotHash = manifest.fileHashes[path]`.
   f. If `currentHash === snapshotHash` or `currentHash === null` → restore, push to `restoredPaths`.
   g. Else if `force` → restore, push to `forcedPaths`.
   h. Else → push to `conflictedPaths`, continue.
7. Release lock (in `finally`).
8. If `bus`, emit `snapshot_restored`.
9. Return `RestoreResult`.

**Restoring a file** means `mkdir -p` the parent directory, then `node:fs/promises` `writeFile(absPath, contents)`. Read contents from the resolved source path above.

Files that existed at snapshot time but no longer exist on disk (`currentHash === null`) are always restored without conflict — the user has not made a conflicting edit, they may have deleted the file.

## Events

Add to `src/engine/events/types.ts`:

```ts
| {
    type: 'snapshot_restored';
    ts: number;
    snapshotId: string;
    restoredCount: number;
    conflictedCount: number;
    forcedCount: number;
    forced: boolean;
  }
| {
    type: 'snapshot_restore_conflict';
    ts: number;
    snapshotId: string;
    conflictedPaths: string[];
  }
```

Emit `snapshot_restore_conflict` only when `conflictedPaths.length > 0` and `force` is false. Emit `snapshot_restored` always on successful completion (even if some files were conflicted).

## CLI Command

Add to `src/cli/commands/snapshot.ts`:

```ts
snapshot
  .command('restore <id-or-name>')
  .description('Restore the working tree to a snapshot state')
  .option('--session <id>', 'Session ID (defaults to active session)')
  .option('--force', 'Overwrite files even if modified after snapshot')
  .action(async (idOrName: string, opts) => { /* ... */ });
```

### `restore` action implementation

1. Resolve `projectDir` and `sessionId` (same pattern as `create` — `readActive` or `--session`, error if neither).
2. Call `restoreSnapshot({ projectDir, sessionId, idOrName, force: opts.force ?? false })`.
3. Print results:
   ```
   Restored <restoredPaths.length> file(s) from snapshot <snapshotId>.
   ```
4. If `conflictedPaths.length > 0`:
   ```
   Conflicts (not restored — modified since snapshot):
     src/foo.ts
     src/bar.ts
   Run with --force to overwrite.
   ```
5. If `forcedPaths.length > 0`:
   ```
   Forced (<forcedPaths.length> file(s) overwritten):
     src/foo.ts
   ```
6. If `missingSnapshotFiles.length > 0`:
   ```
   Warning: <n> file(s) missing from snapshot storage (skipped).
   ```
7. Exit code 0 if `conflictedPaths.length === 0`, exit code 1 if any conflicts (to allow shell scripting).

### `resolveSnapshot` Failure Messages

- No match: `"No snapshot found with id or name: <idOrName>"`
- Ambiguous name: `"Ambiguous snapshot name '<name>': matches <id1>, <id2>. Use the snapshot ID directly."`

Print these via `cliError` (import from `src/cli/errors.ts`) and exit 1.

## Tests

`src/engine/snapshots/restore.test.ts` — use real temp directories. Each test must first call `createSnapshot` (from brief 02) to establish a baseline, then optionally create more snapshots:

- `restoreSnapshot` (from baseline snapshot) restores all files when no modifications have been made post-snapshot
- `restoreSnapshot` (from delta snapshot) correctly reconstructs: changed files come from the snapshot's `files/`, unchanged files come from `baseline/files/`
- `restoreSnapshot` skips and records conflict when a file has been modified post-snapshot (different hash)
- `restoreSnapshot` with `force: true` overwrites conflicted files and records them in `forcedPaths`
- `restoreSnapshot` restores a file that was deleted from disk after the snapshot (`currentHash === null` case, no conflict)
- `restoreSnapshot` records `missingSnapshotFiles` when a snapshot file entry is missing from `files/` and the baseline entry is also missing
- `restoreSnapshot` throws with "Baseline snapshot missing" when no baseline exists
- `resolveSnapshot` resolves by exact snapshot ID
- `resolveSnapshot` resolves by unique name
- `resolveSnapshot` throws on zero name matches
- `resolveSnapshot` throws on ambiguous name matches (two snapshots, same name)
- `restoreSnapshot` releases lock even when an error is thrown mid-restore

## Acceptance Criteria

- `restoreSnapshot` and `resolveSnapshot` are exported from `src/engine/snapshots/restore.ts`.
- Hash-guard is applied per-file; partial restores (some files restored, some conflicted) work correctly.
- `--force` explicitly logs each forced override.
- `snapshot_restored` and `snapshot_restore_conflict` events are in `src/engine/events/types.ts`.
- No React / Ink / features imports in `src/engine/snapshots/restore.ts`.
- `npm run test-ci` passes.

## Constraints

- Do not create `src/engine/snapshots/index.ts`.
- Do not import `simple-git` in this brief.
- Exit code 1 on conflicts is intentional — do not suppress it.

## Escalation

If `hashFile` from brief 01 returns null for a non-existent file and the callee expects a defined string, guard with `?? ''` and document why the empty string will never match a valid sha256.

## Evidence Requirements

When the implementing agent finishes, the following must be verifiable:

- `npm test -- src/engine/snapshots/restore.test.ts` passes with zero skips.
- `npm run typecheck` exits 0.
- A manual smoke test: create a snapshot, modify a file, run restore without `--force`, verify the modified file is listed as conflicted and unchanged on disk.

## Verification Commands

```bash
npm test -- src/engine/snapshots/restore.test.ts src/cli/commands/snapshot.test.ts
npm run typecheck
npm run lint
npm test
```
