# 02 — Snapshot Create and List

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add two engine-level functions — `createSnapshot` and `listSnapshots` — and wire them to CLI subcommands `diptych snapshot create` and `diptych snapshot list`.

This brief assumes brief 01 is complete: `src/core/schemas/snapshot.ts` exists, path helpers are in `src/core/paths.ts`, and `src/engine/snapshots/store.ts` exports the low-level helpers.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts` — especially `snapshotsDir`, `snapshotDir`, `snapshotFilesDir`
- `src/core/schemas/snapshot.ts` — `SnapshotManifest`, `SnapshotPhase`, `SnapshotFileEntry`
- `src/engine/snapshots/store.ts` — `collectTrackedFiles`, `hashFile`, `writeManifest`, `listSnapshotIds`, `readManifest`, `acquireSnapshotLock`, `generateSnapshotId`, `encodeSnapshotPath`, `hasBaseline`
- `src/core/paths.ts` — `baselineDir`, `baselineManifestPath`, `SNAPSHOT_BASELINE_ID`
- `src/engine/orchestrator/evidence.ts` — follow the function-per-operation style
- `src/engine/events/types.ts` — see existing event variant pattern
- `src/cli/commands/status.ts` — follow commander subcommand registration pattern
- `src/core/sessions/lifecycle.ts` — `readActive` for resolving active sessionId

## Files To Touch

- `src/engine/snapshots/store.ts` — add `createSnapshot`, `listSnapshots`
- `src/engine/snapshots/store.test.ts` — add tests for the two new functions
- `src/engine/events/types.ts` — add `snapshot_created` event variant
- `src/cli/commands/snapshot.ts` — new file (commander subcommands `create`, `list`)
- `src/cli/commands/snapshot.test.ts` — new file
- `src/cli.ts` — register `snapshot` command (this is the CLI entry point: it imports and calls all `register*Command` functions)

Do not touch orchestrator files in this brief.

## Engine Function Contract

Add to `src/engine/snapshots/store.ts`:

```ts
export type CreateSnapshotOptions = {
  projectDir: string;
  sessionId: string;
  phase: SnapshotPhase;
  name?: string;
  taskIndex?: number;
  bus?: EventBus;   // optional — auto-triggers may pass a bus; CLI does not
};

export type CreateSnapshotResult = {
  manifest: SnapshotManifest;
  snapshotDir: string;
  isFirstSnapshot: boolean;  // true when the baseline was just created
};

// Creates a snapshot of the working tree using baseline + delta storage.
// If no baseline exists for the session, creates one first (full copy of all tracked files).
// Subsequent snapshots only store files whose hash differs from the baseline.
// Acquires the per-session lock for the duration of the entire operation.
// Emits snapshot_created on bus if provided.
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult>;

export type ListSnapshotsResult = {
  manifests: SnapshotManifest[];
};

// Lists all snapshots for a session (excluding the baseline), sorted ascending (oldest first).
// Returns { manifests: [] } if no snapshots exist yet.
export async function listSnapshots(
  projectDir: string,
  sessionId: string,
): Promise<ListSnapshotsResult>;
```

### `createSnapshot` Implementation Steps

1. Call `acquireSnapshotLock(projectDir, sessionId)` → receive release fn.
2. Call `collectTrackedFiles(projectDir)` → `trackedPaths`.
3. Check `await hasBaseline(projectDir, sessionId)`.
   - **If no baseline exists** (first snapshot of this session):
     a. Create baseline: write all `trackedPaths` to `baselineDir(projectDir, sessionId)/files/`.
     b. Build a full `SnapshotManifest` for the baseline (`id = 'baseline'`, all files in `fileEntries`).
     c. Write baseline manifest via `writeManifest(projectDir, sessionId, baselineManifest)`.
     d. The snapshot to return IS the baseline (return with `isFirstSnapshot: true`).
   - **If baseline exists** (subsequent snapshot):
     a. Read baseline manifest via `readManifest(projectDir, sessionId, 'baseline')`.
     b. Build `baselineHashes: Map<string, string>` from `baselineManifest.fileHashes`.
     c. `const id = generateSnapshotId()`.
     d. Create `snapshotFilesDir(projectDir, sessionId, id)` via `mkdir -p`.
     e. For each `path` in `trackedPaths`:
        - `const hash = await hashFile(join(projectDir, path)) ?? ''`.
        - Build `fileHashes[path] = hash` (always — for every tracked file).
        - If `hash !== baselineHashes.get(path)` → file is delta:
          - Read contents, write to `join(snapshotFilesDir, encodeSnapshotPath(path))`.
          - Push `{ path, hash, encodedName, sizeBytes }` to `fileEntries`.
     f. Build and write `SnapshotManifest` for this snapshot via `writeManifest`.
     g. Return with `isFirstSnapshot: false`.
4. Release lock (in `finally`).
5. If `bus` provided, publish `snapshot_created` with `fileCount: manifest.trackedFileCount` and `taskIndex` from opts.
6. Return `{ manifest, snapshotDir, isFirstSnapshot }`.

**Important:** `taskIndex` from `opts` must flow into the manifest:
```ts
const manifest: SnapshotManifest = {
  ...,
  taskIndex: opts.taskIndex,   // include if defined
};
```

If an error occurs between lock acquire and release, release in `finally`.

### `listSnapshots` Implementation Steps

1. Call `listSnapshotIds(projectDir, sessionId)` → `ids`.
2. For each `id`, call `readManifest(projectDir, sessionId, id)`.
3. Catch and log (do not throw) individual parse failures — skip the corrupted snapshot.
4. Return `{ manifests }` sorted by `manifest.id` ascending.

## Events

Add to `src/engine/events/types.ts`:

```ts
| {
    type: 'snapshot_created';
    ts: number;
    phase: Phase;
    snapshotId: string;
    name?: string;
    fileCount: number;
    taskIndex?: number;
  }
```

Add this after the existing `brief_quality_passed` / `brief_quality_failed` variants, following the existing pattern precisely.

## CLI Command

Create `src/cli/commands/snapshot.ts`:

```ts
import { Command } from 'commander';

export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command('snapshot')
    .description('Manage working-tree snapshots for a diptych session');

  snapshot
    .command('create')
    .description('Create a snapshot of the current working tree')
    .option('--name <name>', 'Human label for this snapshot')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .action(async (opts) => { /* ... */ });

  snapshot
    .command('list')
    .description('List snapshots for a session')
    .option('--session <id>', 'Session ID (defaults to active session)')
    .action(async (opts) => { /* ... */ });
}
```

### `create` action

1. Resolve `projectDir` via `resolveProjectDir()` (import from `src/cli/setup.ts`).
2. Resolve `sessionId`: use `opts.session` if provided, else `readActive(projectDir)`. If neither resolves, exit with `cliError('No active session. Pass --session <id>.')`.
3. Call `createSnapshot({ projectDir, sessionId, phase: 'manual', name: opts.name })`.
4. Print: `Snapshot created: <id>` and if `name` given: `  Name: <name>`.
5. Print: `  Files: <fileCount>`.
6. Print: `  Location: <snapshotDir>`.

### `list` action

1. Resolve `projectDir` and `sessionId` as above.
2. Call `listSnapshots(projectDir, sessionId)`.
3. If `manifests.length === 0`, print `No snapshots found for session <sessionId>.` and return.
4. For each manifest, print one line:
   ```
   <id>  <createdAt>  files=<count>  phase=<phase>  <name-or-empty>
   ```
   Use column-aligned output (pad with spaces).

### Error Handling

- If `createSnapshot` throws lock error → print the error message and exit with code 1.
- If `listSnapshots` encounters a corrupted manifest → print a dim warning per corrupted entry but still show valid ones.
- Use `cliError` (import from `src/cli/errors.ts`) for unrecoverable errors.

## Registration

In `src/cli.ts` (the CLI entry point — lines 6–31 in the current file import and register all commands), add:

```ts
import { registerSnapshotCommand } from './cli/commands/snapshot.js';
// ...
registerSnapshotCommand(program);
```

Place the import alongside the other `register*Command` imports and the call alongside the existing `registerHandoffCommand(program)` call.

## Tests

`src/engine/snapshots/store.test.ts` — add to existing test file:

- `createSnapshot` (first call on session) creates a baseline directory with all tracked files and returns `isFirstSnapshot: true`
- `createSnapshot` (second call) only stores files that changed from baseline in the snapshot `files/` directory; unchanged files have no entry in `fileEntries`
- `createSnapshot` (second call) includes all tracked paths in `fileHashes` regardless of change status
- `createSnapshot` with `name` stores the name in the manifest
- `createSnapshot` stores `taskIndex` in the manifest when provided
- `createSnapshot` emits `snapshot_created` when a mock bus is provided, with correct `fileCount`
- `createSnapshot` excludes `.diptych/` from tracked files (regression guard against self-snapshotting)
- `listSnapshots` excludes the baseline from returned manifests
- `listSnapshots` returns manifests in ascending order across multiple snapshots
- `listSnapshots` returns empty array if no snapshots directory exists
- `listSnapshots` skips a corrupted manifest without throwing

`src/cli/commands/snapshot.test.ts` — integration-style tests using a temp project directory:

- `diptych snapshot create` exits 1 with actionable message when no active session and no `--session`
- `diptych snapshot create --session <id>` creates a snapshot and prints the ID
- `diptych snapshot list --session <id>` lists created snapshots
- `diptych snapshot list --session <id>` prints "No snapshots found" when none exist

## Acceptance Criteria

- `createSnapshot` and `listSnapshots` are exported from `src/engine/snapshots/store.ts`.
- `snapshot_created` event is declared in `src/engine/events/types.ts`.
- `diptych snapshot create` and `diptych snapshot list` work end-to-end with a temp directory.
- No React / Ink imports in `src/engine/snapshots/store.ts`.
- `npm run test-ci` passes.

## Constraints

- Do not add a `chalk` or `ansis` dependency — use `ansis` which is already in the project.
- Do not create `src/engine/snapshots/index.ts`.
- `EventBus` type is already in `src/engine/events/types.ts` — import from there.

## Escalation

If `readActive` does not exist in `src/core/sessions/lifecycle.ts`, locate the equivalent function that reads `.diptych/active` and use that.

## Verification Commands

```bash
npm test -- src/engine/snapshots/store.test.ts src/cli/commands/snapshot.test.ts
npm run typecheck
npm run lint
npm test
```
