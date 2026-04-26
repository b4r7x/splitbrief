# Decisions

## ADR-001 — Snapshot Storage Layout

**Status:** accepted

### Context

Snapshots need to survive the agent process, be human-inspectable, and not conflict with the existing session artifacts already stored under `.diptych/sessions/<id>/`.

### Decision

Store each snapshot under:

```text
.diptych/sessions/<session-id>/snapshots/<snapshot-id>/
  manifest.json        — Zod-validated metadata + per-file sha256 hashes
  files/               — snapshotted file contents (only files in scope)
```

A single `SNAPSHOTS_DIR = 'snapshots'` constant is added to `src/core/paths.ts`. The full path is constructed via a new helper `snapshotsDir(projectDir, sessionId)` that delegates to `sessionDir`.

### Rationale

Placing snapshots inside the session directory means:
- no new top-level directories,
- cleanup is trivially "delete the session",
- the directory already carries session identity (no risk of cross-session collision).

### Consequences

- Snapshot CLI must resolve an active `sessionId` from `.diptych/active` or require `--session <id>`.
- Restoring from a deleted session directory is not supported in v1.

---

## ADR-002 — Baseline + Delta Storage Model

**Status:** accepted

### Context

Storing every tracked file verbatim in every snapshot creates O(files × snapshots) duplication. Most files do not change between snapshots. The task spec is explicit: `files/` holds only files that differ from a per-session baseline.

### Decision

Introduce a per-session **baseline** captured on the first snapshot of that session:

```text
.diptych/sessions/<id>/snapshots/baseline/
  manifest.json   — same SnapshotManifest shape, id = "baseline"
  files/          — full copy of all tracked files at session start
```

Each subsequent snapshot under `<snapshot-id>/files/` stores only files whose sha256 differs from the baseline hash for that path.

`manifest.fileHashes` always covers every tracked path (using the baseline hash for unchanged files). `manifest.fileEntries` only lists entries actually stored in `<snapshot-id>/files/`; unchanged files have no entry (and thus no file in `files/`).

**Restore reconstruction rule:** for each path in `manifest.fileHashes`:
1. If an entry exists in `manifest.fileEntries` → read from `<snapshot-id>/files/<encodedName>`.
2. Otherwise → read from `baseline/files/<encodedName>`.

### Rationale

Matches the task spec exactly. Storage cost is O(files) for the baseline plus O(changed files × snapshots) for deltas — dramatically smaller for sessions with many snapshots and few changes per snapshot.

### Consequences

- `createSnapshot` must: (a) create the baseline if none exists yet for this session, (b) compare each file's current hash to the baseline hash, (c) store only differing files in the snapshot's `files/`.
- `restoreSnapshot` must implement the two-step reconstruction: snapshot files first, baseline files for the rest.
- Brief 01 adds `baselineDir` and `baselineManifestPath` path helpers.
- Brief 02 adds `ensureBaseline(projectDir, sessionId)` before the first snapshot write.
- Corrupted baseline → all snapshots for the session are unrestorable (document this risk; no mitigation in v1).

---

## ADR-003 — Hash Algorithm: sha256 via `node:crypto`

**Status:** accepted

### Context

The evidence ledger already uses sha256 for `briefHash` (see `src/core/schemas/evidence.ts`). Choosing the same algorithm avoids a second hashing dependency and keeps the codebase internally consistent.

### Decision

All file hashes in snapshot manifests use sha256 via `node:crypto`. Hashes are stored as lowercase hex strings.

### Rationale

sha256 is collision-resistant at any file size seen in a source tree, already used in the project, and available natively without adding a dependency.

### Consequences

- Hash-guard comparisons are simple string equality.
- No need to store file size as a secondary check.

---

## ADR-004 — Hash-Guard Restore Semantics

**Status:** accepted

### Context

The core safety requirement: restoring a snapshot must never silently overwrite a file the user edited after the snapshot was taken.

### Decision

On restore, for each file tracked in the snapshot:

1. Compute the current on-disk sha256 of the file.
2. Compare against `manifest.fileHashes[path]` (the hash at snapshot time).
3. If they match → file is unchanged → restore safely.
4. If current hash differs from snapshot hash → **conflict** → skip restore for this file, emit a conflict message, and continue with other files.
5. If `--force` is given → override: restore all files including conflicts, log each forced override.

A partial restore (some files restored, some conflicted) is the correct and expected behavior without `--force`. The exit code reflects whether any conflicts occurred.

### Rationale

This matches the restore behavior established in the old draft (`2026-04-22-safe-snapshots-worktrees-parallel/agent-briefs/01-safe-run-snapshots.md`) and is analogous to how `git checkout` refuses to overwrite dirty files.

### Consequences

- `restoreSnapshot` returns a `RestoreResult` containing lists of restored paths, conflicted paths, and forced paths.
- The CLI prints each category with actionable text: "Run with --force to overwrite conflicted files."

---

## ADR-005 — Snapshot ID Format: ISO Timestamp Slug

**Status:** accepted

### Context

Snapshot IDs must be unique within a session, human-readable in directory listings, and safe as directory names.

### Decision

Snapshot IDs are ISO-8601 UTC timestamps reformatted to be filesystem-safe:

```text
2026-04-26T14-30-00-000Z
```

(colons replaced with hyphens, milliseconds included for uniqueness within the same second).

`--name` is a separate human label stored in `manifest.name` and accepted by `restore` and `diff` as an alias. If two snapshots share a name, restore by name fails with a disambiguation error listing matching IDs.

### Rationale

- Human-readable without a lookup table.
- Lexicographically sortable (newest last).
- No dependency on a counter that could collide under concurrent create (rare but possible).

### Consequences

- `listSnapshots` sorts by ID (alphabetical = chronological).
- `diptych snapshot restore` accepts either the full ID or the name.

---

## ADR-006 — Snapshot Scope: Tracked Files Only, Standard Excludes

**Status:** accepted

### Context

Snapshotting everything including `node_modules/` would be impractical. The spec requires explicit decisions on what is included.

### Decision

Default snapshot scope: all files reachable from the project root, excluding:

- `.git/` (always),
- `.diptych/` (always — snapshotting the snapshot directory itself would recurse),
- `node_modules/` (always),
- any path matched by `.gitignore` at the project root (read via `simple-git`'s `checkIgnore`).

There is no configurable include/exclude in v1. Future versions may add `snapshots.exclude` config.

### Rationale

`.diptych/` must be excluded unconditionally — failure to do so would cause the snapshot to include its own `files/` directory on the next snapshot, growing exponentially. This must be called out as an implementation invariant in `store.ts`.

Honoring `.gitignore` avoids snapshotting build artifacts while remaining safe for most projects.

### Consequences

- Snapshot creation reads `.gitignore` at the start of every create call (not cached).
- Untracked files (not in `.gitignore`) **are** snapshotted — this matches the use case of capturing mid-edit state.

---

## ADR-007 — Concurrency: Sequential With Lockfile

**Status:** accepted

### Context

Two auto-snapshot triggers could fire close together (e.g., post-task for task N and pre-task for task N+1). Concurrent directory creation risks partial manifests.

### Decision

Before any write to the snapshots directory, acquire a per-session lockfile at:

```text
.diptych/sessions/<id>/snapshots/.lock
```

Hold the lock for the duration of the create/restore operation. If the lock is held, fail fast with a clear error: `"Another snapshot operation is in progress for this session."` Do not retry or queue.

In practice, the orchestrator is single-threaded; the lock primarily protects against a user running `diptych snapshot create` while an auto-trigger fires.

### Consequences

- Lock acquisition uses `node:fs` `O_EXCL` atomic create pattern or equivalent.
- Lock is released in a `finally` block.
- v1 does not need a timeout on the lock — if the process dies holding it, the next invocation removes the stale lock if its mtime is older than 60 s.

---

## ADR-008 — Cleanup Policy: Keep All, User Manages

**Status:** accepted

### Context

Snapshots accumulate over a session. Automatic pruning risks deleting a snapshot the user needs.

### Decision

v1 keeps all snapshots indefinitely within a session directory. No automatic pruning. Cleanup is achieved by deleting the session directory or using a future `diptych snapshot delete <id>` command (not in scope for v1).

### Consequences

- No TTL or count threshold logic needed.
- Snapshot list may grow large in long sessions with auto-triggers enabled.

---

## ADR-009 — Auto-Snapshot Triggers: Off By Default

**Status:** accepted

### Context

Auto-snapshots add overhead and storage. Users who have not opted in should not see the behavior.

### Decision

Add three boolean config keys under `snapshots.auto`, all defaulting to `false`:

```yaml
snapshots:
  auto:
    preTask: false
    postTask: false
    preFinalReview: false
```

These are added to `SnapshotsConfigSchema` in `src/core/schemas/config.ts` and documented in `docs/CONFIG.md`.

Auto-trigger failures (disk full, lock held) emit a `warning` event and do not abort the orchestrator phase.

### Rationale

Opt-in matches the principle of minimal surprise. Advanced users who want continuous snapshots can enable them; casual users are unaffected.

### Consequences

- `src/engine/orchestrator/task-loop.ts` reads `config.snapshots?.auto?.preTask` / `postTask` before each task.
- `src/engine/orchestrator/final-review.ts` reads `config.snapshots?.auto?.preFinalReview`.
- The config schema change is additive and backward-compatible.

---

## ADR-010 — Worktrees Are Out Of Scope For This Spec

**Status:** accepted

### Context

The original `2026-04-22-safe-snapshots-worktrees-parallel/` draft combined snapshots and worktrees. Worktrees address parallel session management, which is a separate problem.

### Decision

This spec covers only file-level snapshots within a single working tree. Worktrees, parallel session registry, and `--worktree` CLI flags belong to a future v2 spec.

### Consequences

- `src/engine/snapshots/` contains no worktree references.
- The session directory path is always the active checkout's `.diptych/`.
- Multi-worktree users can create snapshots in each checkout independently; the session IDs are naturally scoped by working tree.

---

## ADR-011 — Storage Compression: None In v1

**Status:** accepted

### Context

Compressing snapshot file contents would reduce storage at the cost of implementation complexity and a potential dependency on `zlib`.

### Decision

No compression in v1. Files are stored verbatim as UTF-8 (or binary) in `files/<encoded-path>`.

`<encoded-path>` is the project-relative path with `/` replaced by `__` and `:` (Windows) replaced by `_`, then URL-encoded for any remaining special characters. The mapping is recorded in `manifest.fileEntries` (see schema in brief 01).

### Rationale

Source files are already small. Deferred to v2 if profiling shows a real problem.
