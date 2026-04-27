# 01 — Snapshot Schema and Storage

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Establish the foundational layer for the Snapshots / Undo feature:

1. Zod schema for `SnapshotManifest` in `src/core/schemas/snapshot.ts`.
2. Path constants and helper functions in `src/core/paths.ts`.
3. Low-level read/write helpers in `src/engine/snapshots/store.ts`.

All subsequent briefs (02, 03, 04, 05) import from these files. Get this right first.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts` — understand the existing constant + helper pattern
- `src/core/schemas/evidence.ts` — follow its Zod schema style exactly
- `src/engine/orchestrator/evidence.ts` — follow its read/write/parse helper pattern
- `docs/LAYERS.md` — confirm engine/ vs core/ placement

## Files To Touch

- `src/core/paths.ts` — add constants + path helpers
- `src/core/schemas/snapshot.ts` — new file
- `src/engine/snapshots/store.ts` — new file
- `src/engine/snapshots/store.test.ts` — new file

Do not touch any CLI, orchestrator, or config files in this brief.

## Schema Contract

Create `src/core/schemas/snapshot.ts` with exactly these exports:

```ts
import { z } from 'zod';

export const SnapshotPhaseSchema = z.enum([
  'planning',
  'implementing',
  'reviewing',
  'manual',
]);
export type SnapshotPhase = z.infer<typeof SnapshotPhaseSchema>;

export const SnapshotFileEntrySchema = z.object({
  // Project-relative POSIX path (e.g. "src/core/paths.ts")
  path: z.string(),
  // sha256 hex of file contents at snapshot time
  hash: z.string(),
  // Encoded filename used in files/ directory
  encodedName: z.string(),
  // Size in bytes
  sizeBytes: z.number().nonnegative(),
});
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

export const SnapshotManifestSchema = z.object({
  version: z.literal(1),
  id: z.string(),          // ISO timestamp slug: "2026-04-26T14-30-00-000Z"
  sessionId: z.string(),
  name: z.string().optional(),   // human label, may be absent
  createdAt: z.string(),         // ISO 8601 UTC
  phase: SnapshotPhaseSchema,
  taskIndex: z.number().int().nonnegative().optional(),
  // fileHashes covers EVERY tracked path — for unchanged files this equals the baseline hash.
  // This is the hash-guard index used by restore and diff.
  fileHashes: z.record(z.string(), z.string()),
  // fileEntries contains ONLY files stored in this snapshot's files/ directory.
  // For non-baseline snapshots this is the delta (files that changed from baseline).
  // For the baseline snapshot (id === 'baseline') this lists all tracked files.
  fileEntries: z.array(SnapshotFileEntrySchema),
  // Total count of tracked files across the project (includes unchanged ones).
  trackedFileCount: z.number().nonnegative(),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;
```

Do not add fields beyond the spec above. Do not export a `SnapshotSchema` for the outer shape — the manifest IS the persisted artifact.

## Path Constants

Add to `src/core/paths.ts`:

```ts
// Constants
export const SNAPSHOTS_DIR = 'snapshots';
export const SNAPSHOT_BASELINE_ID = 'baseline';
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
export const SNAPSHOT_FILES_DIR = 'files';
export const SNAPSHOT_LOCK_FILE = '.lock';

// Helpers
export const snapshotsDir = (projectDir: string, sessionId: string): string =>
  join(sessionDir(projectDir, sessionId), SNAPSHOTS_DIR);

export const snapshotDir = (projectDir: string, sessionId: string, snapshotId: string): string =>
  join(snapshotsDir(projectDir, sessionId), snapshotId);

// Convenience for the baseline directory (snapshotId = 'baseline')
export const baselineDir = (projectDir: string, sessionId: string): string =>
  snapshotDir(projectDir, sessionId, SNAPSHOT_BASELINE_ID);

export const snapshotManifestPath = (projectDir: string, sessionId: string, snapshotId: string): string =>
  join(snapshotDir(projectDir, sessionId, snapshotId), SNAPSHOT_MANIFEST_FILE);

export const baselineManifestPath = (projectDir: string, sessionId: string): string =>
  snapshotManifestPath(projectDir, sessionId, SNAPSHOT_BASELINE_ID);

export const snapshotFilesDir = (projectDir: string, sessionId: string, snapshotId: string): string =>
  join(snapshotDir(projectDir, sessionId, snapshotId), SNAPSHOT_FILES_DIR);

export const snapshotLockPath = (projectDir: string, sessionId: string): string =>
  join(snapshotsDir(projectDir, sessionId), SNAPSHOT_LOCK_FILE);
```

Place these after the existing `EVIDENCE_FILE` / `DRIFT_REPORT_FILE` constants at the bottom of the file.

## Storage Helpers Contract

Create `src/engine/snapshots/store.ts`. It must export exactly these functions (pure, no side effects on import):

```ts
// Encode a project-relative POSIX path into a safe filename for files/
// "src/core/paths.ts" → "src__core__paths.ts"
// Replaces "/" with "__". URL-encodes any remaining special chars.
export function encodeSnapshotPath(relativePath: string): string;

// Inverse of encodeSnapshotPath — used in diff and restore
export function decodeSnapshotPath(encodedName: string): string;

// Generate a snapshot ID from a Date (or Date.now() if omitted)
// Output format: "2026-04-26T14-30-00-000Z"
export function generateSnapshotId(now?: Date): string;

// Write manifest.json under .diptych/sessions/<id>/snapshots/<snapshotId>/
// Creates the directory if it does not exist.
// Writes atomically using write-then-rename.
export async function writeManifest(
  projectDir: string,
  sessionId: string,
  manifest: SnapshotManifest,
): Promise<void>;

// Read and Zod-parse manifest.json. Throws on missing file or invalid schema.
export async function readManifest(
  projectDir: string,
  sessionId: string,
  snapshotId: string,
): Promise<SnapshotManifest>;

// List all snapshot IDs for a session, sorted ascending (oldest first).
// Returns [] if snapshots/ does not exist yet.
export async function listSnapshotIds(
  projectDir: string,
  sessionId: string,
): Promise<string[]>;

// Compute sha256 hex hash of a file's contents. Returns null if file does not exist.
export async function hashFile(filePath: string): Promise<string | null>;

// Collect all tracked files under projectDir, applying standard excludes:
// .git/, .diptych/, node_modules/, and paths matched by .gitignore.
// Returns project-relative POSIX paths sorted ascending.
// CRITICAL: .diptych/ MUST always be excluded — snapshotting snapshots causes exponential growth.
export async function collectTrackedFiles(projectDir: string): Promise<string[]>;

// Acquire the per-session snapshot lock. Throws with message
// "Another snapshot operation is in progress for this session." if lock is held.
// Removes stale locks older than 60 000 ms automatically.
export async function acquireSnapshotLock(projectDir: string, sessionId: string): Promise<() => Promise<void>>;

// Returns true if a baseline manifest exists for this session.
export async function hasBaseline(projectDir: string, sessionId: string): Promise<boolean>;
```

### Implementation Notes

- `collectTrackedFiles`: use `node:fs/promises` `readdir` recursively. Apply excludes by checking whether the path starts with `.git`, `.diptych`, or `node_modules` (project-relative). For `.gitignore`, read `.gitignore` at `projectDir` once and use a simple line-by-line prefix match (no glob library needed for v1 — exact path prefix exclusion is sufficient for common cases like `dist/`, `build/`).
- `acquireSnapshotLock`: use `node:fs` `openSync` with `wx` flag (exclusive create). If `EEXIST`, check mtime; if older than 60 s, delete and retry once. Return a release function that deletes the lockfile.
- `writeManifest`: write to `<path>.tmp`, then `node:fs/promises` `rename`. This is atomic on POSIX.
- `hashFile`: use `node:crypto` `createHash('sha256')` with streaming via `node:fs` `createReadStream`.

## Tests

`src/engine/snapshots/store.test.ts` — use `node:os` `tmpdir()` + `mkdtemp` for real temp directories. Clean up in `afterEach`.

Required test cases:

- `generateSnapshotId` produces a valid ISO slug with hyphens instead of colons
- `encodeSnapshotPath` / `decodeSnapshotPath` roundtrip for paths with `/` and special characters
- `writeManifest` creates the directory and file; `readManifest` parses it back to the same shape
- `readManifest` throws for a missing file
- `readManifest` throws for an invalid JSON file (Zod parse failure)
- `listSnapshotIds` returns `[]` when no snapshots directory exists
- `listSnapshotIds` returns sorted IDs across multiple snapshot directories
- `hashFile` returns null for a non-existent file
- `hashFile` returns the correct sha256 for a known-content file
- `collectTrackedFiles` excludes `.git/`, `.diptych/`, `node_modules/`
- `collectTrackedFiles` excludes paths matched by a `.gitignore` prefix (e.g., `dist/`)
- `acquireSnapshotLock` succeeds on first call and releases cleanly
- `acquireSnapshotLock` throws when lock is already held
- `acquireSnapshotLock` removes and retakes a stale lock (mtime > 60 s)

## Acceptance Criteria

- All exports match the signatures above exactly.
- No classes. No barrels.
- `src/engine/snapshots/store.ts` does not import from `react`, `ink`, `src/features/`, or `src/components/`.
- `npm run test-ci` passes.

## Constraints

- Do not add a `zod` peer dependency — it is already in the project.
- Do not import from `simple-git` in this brief — that is deferred to brief 05.
- Do not create `src/engine/snapshots/index.ts`.

## Escalation

If `node:fs` `readdir` recursive option is not available (Node < 18.17), use a manual recursive readdir. Do not add a third-party `glob` library.

## Verification Commands

```bash
npm test -- src/engine/snapshots/store.test.ts
npm run typecheck
npm run lint
```
