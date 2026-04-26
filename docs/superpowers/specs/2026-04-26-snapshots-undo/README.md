# Snapshots / Undo — 2026-04-26

> **Status:** draft spec (v1).
> **Scope:** user-invoked file-level run snapshots: create, list, restore (hash-guarded), optional diff. Auto-snapshot triggers wired to the orchestrator. No worktrees, no parallel sessions.
> **Supersedes:** `docs/superpowers/specs/2026-04-22-safe-snapshots-worktrees-parallel/` (that draft combined snapshots + worktrees into one spec; this is the split v1 covering snapshots only).
> **Out of scope:** worktrees, parallel session registry — see future v2 spec `snapshots-worktrees-parallel`.

## Purpose

Users running diptych on real features want a single command to bookmark the working tree at any point and jump back to it cleanly. Per-task git commits already exist; snapshots are an additional file-level layer that survives the agent process and does not rely on git stash.

The four operations:

1. **Create** — capture the full working tree state (minus `.git/`, `.diptych/`, `node_modules/`) into `.diptych/sessions/<id>/snapshots/<snapshot-id>/`.
2. **List** — enumerate snapshots for a session.
3. **Restore** — rewrite the working tree from a snapshot, file by file, with a hash-guard that refuses to overwrite files the user modified after the snapshot was taken (`--force` to override).
4. **Diff** (optional) — show a unified diff between the current working tree and a snapshot.

Auto-snapshot triggers (pre-task, post-task, pre-final-review) are configurable and off by default in v1.

## Why This Now

This is the #1 missing feature in AI coding CLIs (Claude Code issues #353, #6001; Codex #16784). Diptych can ship it cleanly because:

- the orchestrator already commits per task — snapshots layer on top without replacing git,
- the session directory already exists under `.diptych/sessions/<id>/` — a `snapshots/` sub-directory is a natural extension,
- hash-guard semantics match the pattern established in the existing drift detector and evidence ledger.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview — this file. |
| 2 | `decisions.md` | Product and architecture decisions (ADRs). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and shared invariants. |
| 4 | `agent-briefs/01-snapshot-schema-and-storage.md` | Zod schema + path constants + storage helpers. |
| 5 | `agent-briefs/02-snapshot-create-and-list.md` | Engine helpers `createSnapshot` / `listSnapshots` + CLI `create` / `list`. |
| 6 | `agent-briefs/03-snapshot-restore.md` | Engine helper `restoreSnapshot` with hash-guard + CLI `restore`. |
| 7 | `agent-briefs/04-auto-snapshot-triggers.md` | Orchestrator integration: pre-task / post-task / pre-final-review auto-triggers. |
| 8 | `agent-briefs/05-snapshot-diff.md` | Optional: `diptych snapshot diff <id>` unified diff. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Snapshot Schema and Storage | Zod schema, path constants, read/write helpers. |
| 02 | Snapshot Create and List | `createSnapshot()`, `listSnapshots()`, CLI `create` + `list`. |
| 03 | Snapshot Restore | `restoreSnapshot()` with hash-guard, CLI `restore --force`. |
| 04 | Auto-Snapshot Triggers | Config keys, orchestrator hooks, event variants. |
| 05 | Snapshot Diff (optional) | CLI `diff <id>`, unified text diff against current tree. |

## Key Files Introduced

```text
src/core/schemas/snapshot.ts          — SnapshotManifest Zod schema
src/engine/snapshots/store.ts         — createSnapshot / listSnapshots / readManifest / writeManifest
src/engine/snapshots/store.test.ts
src/engine/snapshots/restore.ts       — restoreSnapshot with hash-guard
src/engine/snapshots/restore.test.ts
src/engine/snapshots/diff.ts          — snapshotDiff (optional)
src/engine/snapshots/diff.test.ts
src/cli/commands/snapshot.ts          — commander subcommands: create / list / restore / diff
src/cli/commands/snapshot.test.ts
```

## Key Files Modified

```text
src/core/paths.ts                     — SNAPSHOTS_DIR + helper fns
src/core/schemas/config.ts            — SnapshotsConfigSchema + snapshots field
src/engine/events/types.ts            — snapshot_created / snapshot_restored / snapshot_restore_conflict event variants
src/engine/orchestrator/task-loop.ts  — auto-snapshot pre-task / post-task hooks
src/engine/orchestrator/final-review.ts — auto-snapshot pre-final-review hook
src/cli.ts                            — register snapshot command
docs/CONFIG.md                        — snapshots config section
docs/WORKFLOW.md                      — snapshot UX section
```

## Dependencies

| Prerequisite | Status |
|---|---|
| Session directory exists at `.diptych/sessions/<id>/` | Existing — `src/core/paths.ts` |
| Evidence ledger pattern (`src/engine/orchestrator/evidence.ts`) | Existing — follow same read/write/parse pattern |
| `src/core/schemas/evidence.ts` Zod pattern | Existing — follow for snapshot schema |
| `src/lib/fs.ts` helpers | Existing |
| `simple-git` already in deps | Existing — used in brief 05 diff |

## Done Criteria

- `diptych snapshot create` writes a valid manifest + file copies under the session snapshot directory.
- `diptych snapshot list` prints all snapshots for the active (or given) session.
- `diptych snapshot restore <id>` restores safe files, reports conflicts, refuses to overwrite user edits without `--force`.
- `diptych snapshot diff <id>` prints a unified diff between snapshot and current tree.
- Auto-triggers fire at pre-task / post-task / pre-final-review when `snapshots.auto.*` config keys are `true`.
- All new engine code is free of React / Ink / features imports.
- `npm run test-ci` passes.

## Quality Bar For Implementing Agents

- Schema is Zod-validated on every read; invalid manifests are rejected with a useful error, not silently discarded.
- Hash-guard must be applied per-file, not per-snapshot. Restoring 9 of 10 files while reporting one conflict is the correct behavior.
- Path constants go in `src/core/paths.ts`; do not hardcode directory names in engine code.
- Auto-triggers must not block the orchestrator on failure — warn and continue.
- No git staging or committing anywhere in this spec.
- `--force` on restore must be explicit and must log each file it forces.
- Storage uses `node:crypto` sha256 (same algorithm as evidence briefHash).
