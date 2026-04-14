# 002 — Session Storage Restructure

## Problem

Today all active workflow state is in a single pinned folder `.diptych/current/` (`src/core/paths.ts`, `src/core/paths-io.ts`). Session summaries are separately written as `.diptych/sessions/<uuid>.json`. Archived sessions go to `.diptych/archive/`.

Problems:
1. A browsing user can't tell which feature `/current/` belongs to without opening `state.json`.
2. Session summary is a JSON file disconnected from the artifact files (`spec.md`, `plan.md`, `tasks.md`) that were produced for that session.
3. No mechanism to link a session-id to its artifacts, transcript, and final summary as one unit.
4. The two-pointer design (`/current/` + `/sessions/*.json`) requires copy logic on archive, creating dual source of truth.
5. Multiple concurrent `diptych start` calls in the same project can race on `/current/` — there is no lock today.

## Goal

Restructure storage so each session = one self-contained directory `.diptych/sessions/<session-id>/`. A plain-text `.diptych/active` file names the currently-running session (acts as a lock). `archive/` goes away — old sessions simply remain in `sessions/` forever, sorted by folder name.

## User stories

- **As a user browsing `.diptych/sessions/` in my editor**, every folder name tells me the date and feature slug at a glance.
- **As a user running `diptych start` twice accidentally**, the second invocation fails with a clear message pointing me to either `resume` or to cancel the live session.
- **As a developer of diptych**, when I add a file to a session (new log, new metadata), I add it in one place and every consumer sees it.

## Functional requirements

**FR-001.** New canonical layout:

```
.diptych/
├── config.yml
├── active                # plain text, contains session-id of live session (or absent)
└── sessions/
    ├── <session-id>/
    │   ├── state.json
    │   ├── spec.md, plan.md, tasks.md
    │   └── summary.json      (written at end of run)
    └── ...
```

`session.jsonl` is added by spec 003. `transcript.jsonl` / `events.jsonl` are *not* in scope for 002.

**FR-002.** Session-id format: `<ISO-date>-<slug>`. Date is local-time `YYYY-MM-DD`. Slug is feature prompt lowercased, non-alphanumeric → `-`, collapsed, trimmed, truncated to 50 chars.

Example: feature `"Add email validator"` → id `2026-04-14-add-email-validator`.

**FR-003.** Collision handling: if the target id already exists, append `-2`, `-3`, … until unique. No UUIDs, no timestamps — keep IDs human-readable.

**FR-004.** `diptych start` must:
  1. Fail fast if `.diptych/active` exists and points at a session whose `state.json` is non-terminal (`phase !== 'complete' && phase !== 'idle'`). Error message: `Workflow already running: <id>. Run 'diptych resume' to continue, or delete .diptych/active after verifying the session is truly stopped.`
  2. Otherwise: generate id (FR-002/FR-003), create `.diptych/sessions/<id>/`, write `.diptych/active` with the id, proceed.

**FR-005.** `diptych resume` reads `.diptych/active` to locate the session folder, then loads `sessions/<id>/state.json`. Errors: missing `active` file, id in `active` has no folder, folder has no `state.json`, version mismatch.

**FR-006.** `diptych status` reads `.diptych/active`. If absent, prints "no active session". If present, prints `sessions/<id>/state.json` contents (phase, task progress, tokens so far). Does not claim the lock.

**FR-007.** End-of-run (complete, interrupted, failed): write `summary.json` in the session folder, then clear `.diptych/active` (delete the file). The session folder remains forever as historical record.

**FR-008.** All path helpers (`src/core/paths.ts`, `src/core/paths-io.ts`) are rewritten to take a `sessionId: string` argument and resolve under `sessions/<id>/`. Any code that today uses `currentDir(projectDir)` must be updated to use `sessionDir(projectDir, sessionId)`.

**FR-009.** `.diptych/archive/` is removed from the codebase. The archive logic (`src/utils/fs.ts` has `archiveCurrent()` or similar) is deleted. Old archived sessions on disk are left alone — users can browse or delete them manually; we just don't write there anymore.

**FR-010.** Old code paths that wrote directly to `.diptych/current/` or `.diptych/sessions/<uuid>.json` (summary as a flat JSON) are deleted. The only writer to `.diptych/active` is `start` (creates) and shutdown logic (deletes).

## Success criteria

- `grep -rn "diptych/current" src/` returns zero matches.
- `grep -rn "archive" src/core/` returns zero matches in active code (archive is gone).
- Running `diptych start "foo"` then `ls .diptych/sessions/` shows a single `YYYY-MM-DD-foo/` folder with `state.json` inside.
- Running `diptych start "foo"` twice in a row produces an error on the second call with the message from FR-004.
- Running `diptych resume` after Ctrl-C-ing a `start` picks up the correct session.
- All existing tests pass (after path updates).

## Non-goals

- Migrating users' existing `.diptych/current/` data to the new layout — that is the scope of spec 009.
- Deleting old session folders (no GC, no retention policy).
- `sessions/<id>/` contains anything other than state.json + summary.json + artifacts in this spec. The `session.jsonl` merged log comes in 003.
- Renaming `.diptych/active` to something else (e.g. `.diptych/lock`). Keep it simple.
