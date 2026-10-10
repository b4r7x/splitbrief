# SPLITBRIEF — Supporting subsystems

These subsystems sit outside the core workflow loop but are essential to the full system. Each section explains what it does, where the code lives, and how to use it. For the core workflow, see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). For the engine and EventBus, see [ENGINE.md](./ENGINE.md). For approval and recovery, see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

## 1. Workflow hooks

`src/engine/hooks/`

User-declared commands that fire on workflow events. Every hook is declared in the `hooks` section of the SPLITBRIEF config file — there is no auto-discovery, so a script sitting in `.splitbrief/hooks/` runs only when a config entry names it.

**Pre-hooks** (`pre_planning`, `pre_task`, `pre_validation`, `pre_commit`, `pre_escalation`) run synchronously before the action. If a hook exits non-zero or returns `{ kind: 'deny' }`, the action is blocked. Dispatched at the orchestrator call site via `src/engine/hooks/run-pre.ts`.

**Post-hooks and on-hooks** (`post_task`, `post_validation`, `post_commit`, `on_halt`, `on_complete`, `on_error`) fire asynchronously after the action through the hook sink on the EventBus (`src/engine/hooks/sink.ts`). A deny outcome from a post-hook is informational only -- it cannot block the already-completed action. `on_halt` fires on `recovery_prompted` -- the run stopped and is waiting for a decision -- and its payload carries the halt's `reason`, `recommendedAction` and `resumeCommand`, so an unattended run can page whoever owns it.

A hook is a `command`: it spawns a subprocess and receives the event as JSON on stdin. Variable substitution in command args uses `${event.<path>}` syntax -- for example `${event.taskId}`, `${event.phase}`. Resolved by `src/engine/hooks/substitute.ts`. Each hook entry declares an `on_failure` policy: `block`, `warn`, or `ignore`.

**Trust model:** hooks must be trusted before first execution. `src/core/hooks/trust-digest.ts` computes a SHA-256 hash of the hooks config and `src/core/hooks/trust.ts` stores a receipt in the owner's trust store (`~/.splitbrief/trust/hooks.json`), keyed by the canonical path of this checkout — the same store and key custom runner trust uses, so a repository can neither ship nor forge a grant. If the config changes, the user is prompted to re-trust. Deep-dive: `docs/HOOKS-CONFIG.md`.

---

## 2. Snapshots

`src/engine/snapshots/`

Content-addressed working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/`. The snapshot store handles creation (`src/engine/snapshots/create.ts`), manifest management (`src/engine/snapshots/manifest.ts`), and file collection (`src/engine/snapshots/files.ts`). Restore logic lives in `src/engine/snapshots/restore.ts`. Run-level accept/reject logic lives in `src/engine/snapshots/run/` (`lifecycle.ts`, `ledger.ts`, `rollback.ts`).

A run writes these snapshots once per run. A worktree or staged-copy run also takes `workspace-base` at build start (`src/engine/orchestrator/run/task-execution.ts`); its run workspace starts from it, and Apply and `run.patch` diff against it. The other two come from `src/engine/orchestrator/run/snapshots.ts`: `ensureRunBaselineSnapshot` runs before the first task and, when the session has no baseline yet, captures the **baseline snapshot** -- the "before" state -- storing every tracked file (excluding `.git`, `.splitbrief`, `node_modules`, `.trees`); `recordRunSnapshotForRun` runs after the task loop completes and before the final review reads the diff, capturing what the run wrote and recording it in the run ledger. On a run without a workspace, `/run accept` writes the accepted-run snapshot. A non-baseline snapshot stores only files whose hash differs from the baseline, with the manifest recording every file's hash. File blobs are stored under hex-encoded path names within each snapshot directory.

Snapshots track the run's project directory, never the run workspace -- the run worktree lives at `$XDG_STATE_HOME/splitbrief/trees/<repo-key>/<session-id>/` (default `~/.local/state/splitbrief/trees/...`), outside both `.git/` and the project root. A run without a workspace writes into the project directory, so its snapshots capture what it wrote, the same thing the user would see in `git status`. A worktree or staged-copy run keeps its result in the workspace until Apply; its `/run reject confirm` restores from the Apply backup, not from these snapshots ([WORKFLOW.md §Apply](./WORKFLOW.md#apply)).

Separate from snapshots, the run's changed-files baseline (`src/engine/orchestrator/changed-files-baseline.ts`) fingerprints every changed file at task-loop entry into a sha256 hex, `symlink:<target>` for a symlink that stays inside the project (a relative target that the kernel lands inside the project root and outside `.git` and `.splitbrief`), or one of two sentinels: `missing` (deleted since the baseline) and `unreadable` (any other symlink, a directory, or a file SPLITBRIEF could not read). The old `changed-file-fingerprint-read` error kind was removed with the throw-on-unreadable behaviour: an unreadable entry is recorded and named once in a run-start warning -- never treated as missing and never opened.

The run ledger (`run-ledger.json`) tracks which snapshots belong to the current run so that `/run accept` and `/run reject confirm` operate on the correct state of a run without a workspace; a workspace run uses Apply and its backup instead ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)). A completed run holds exactly one entry, the `pre-final-review` snapshot; `/run accept` appends the accepted-run snapshot and seals the ledger, after which a rejection is refused. Rejection restores baseline files, deletes files that were created during the run, and reports conflicts where the working tree diverged from both baseline and snapshot. A run that stopped before the final review recorded nothing, so a rejection finds no ledger (`No run snapshot to reject.`). Events: `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`.

---

## 3. Repo-map

`src/engine/codebase/`

Token-budgeted codebase summary fed to every planner call. `src/engine/codebase/repomap.ts` is the entry point: `buildRepoMap(projectDir, opts)`.

The pipeline: discover source files -> parse them with tree-sitter (`src/engine/codebase/parse.ts`, grammars for TypeScript, JavaScript, Python, Go, Rust via `src/engine/codebase/languages.ts`) -> build an import graph from symbols and references (`src/engine/codebase/graph.ts`) -> score with PageRank (`src/engine/codebase/pagerank.ts`, files imported by many others rank higher, explicit focus files get a rank boost) -> trim to fit the token budget (`src/engine/codebase/budget.ts`). Feature text is scanned for mentioned filenames (`src/engine/codebase/extract-mentioned-filenames.ts`) which get added to focus files.

Parse results are cached in SQLite at `.splitbrief/repomap.sqlite` via `src/engine/codebase/cache.ts`; stale rows are re-parsed on each planning run, so there is no manual rebuild step. Default budget is 4000 tokens. Deep-dive: `docs/REPOMAP.md`.

---

## 4. Runtime commands

`src/core/runtime/commands/`

User-facing commands typed as `/name args` in the composer. Defined in `src/core/runtime/commands/defs/<category>.ts` and assembled by `createRuntimeCommands(ctx)` in `src/core/runtime/commands/registry.ts`, which takes a `RuntimeCommandContext` providing access to navigation, overlays, detection, rewind, snapshots, and other capabilities.

Each command declares: `name`, a `kind` discriminant (`noarg` or `arg`), `handler`, `validScreens` (which screens the command can run on), a one-line `description`, and a `category` from `COMMAND_CATEGORIES` (`navigate` | `crew` | `workflow` | `view` | `io`). `'arg'` commands also declare `args` -- either a closed option set or a free-form hint. Optional: `aliases` (`{ name, args? }` pairs, so an alias can pin an argument), `label` (display override), `shortcut`, `hidden`, and `guard: (ctx) => string | undefined` -- a returned string is the reason the command is unavailable. The command palette (Ctrl-K) lists every command that is not `hidden`, is valid on the current screen, and whose `guard` returns `undefined`; a blocked command is hidden rather than shown and errored. Recipe: `docs/EXTENDING.md` section 2 is canonical.

Dispatch (`src/core/runtime/commands/dispatch.ts`): parse the raw input, split name from args, look up the command via fuzzy matching (`src/core/runtime/commands/lookup.ts`), validate screen and phase guards, then execute the handler. Errors are surfaced through the `onError` callback. Full reference: `docs/SLASH-COMMANDS-REFERENCE.md`.

---

## 5. Detection

`src/engine/detection/`

Auto-detect available planner and implementer tools on startup. `src/engine/detection/detect.ts` probes CLI tools (claude-code, codex, copilot, opencode, kilo-code, cursor, command-code) by spawning them and checking `isAvailable()` + `getVersion()`, checks API providers for valid keys or reachable endpoints, and always includes the `shell` planner as available.

The sanitized readiness projection is remembered locally in `.splitbrief/detection-cache.json` (`src/engine/detection/cache.ts`). The record is written for the current project and carries the non-secret configuration context it was produced under. The project path enters that context as a short digest, so a folder name such as `my-local-app` does not trip the scan that keeps private identifiers out of the record. Alongside readiness rows it remembers sanitized model rows — provider model lists and per-tool CLI catalog inventories reduced to identity, the tool's own name and detail, sizing, ordering, the effort ladder, the modality flags, the capability facts, and the hidden flag — so pickers render a remembered catalog immediately on the next start; the rows hydrate as stale presentation data and the live refresh replaces them. Only a successful listing replaces a tool's remembered catalog: a probe that times out or fails otherwise leaves it in the record with its original probe time, and the picker keeps serving it as `stale` rather than an empty column. It omits private configured-provider outcomes, credentials, connection context keys, and trusted executable receipts; restored CLI rows have no executable identity. Startup hydration is project-scoped: a record whose configuration context does not match still hydrates, as presentation-only rows with their generation reset to 0, so they never outrank a live lane and the refresh replaces them. The strict context match still gates the detection service's authoritative reads. An invalid record is ignored, and legacy cache formats that contained private fields are removed.

Store initialization publishes the remembered snapshot as stale presentation data before starting the asynchronous discovery refresh. With no remembered result, Setup shows the "Waking your crew…" boot manifest — configured seats with live per-seat marks and discovery lanes ticking in — and waits for a fresh result. With remembered data, the picker stays usable and shows a compact "Refreshing your tools…" status; refresh failure preserves the remembered rows with a failure/stale indication. The detection service (`src/engine/detection/service.ts`) coordinates this refresh, a five-minute soft in-memory readiness TTL, models-dev catalog fetching, and CLI model discovery.

The models.dev catalog (`src/engine/providers/models-dev.ts`, cached under the user cache directory) is a metadata source for the model catalog resolver (`src/engine/providers/model/catalog.ts`): context window, pricing, release date, display name, and the per-model reasoning ladder (`reasoning_options` → `nativeReasoningEfforts`; only an `effort` entry names rungs, any other entry set means "this row names none", and a row without the field says nothing — no key). Which lanes may create picker rows is decided by `src/engine/providers/model/lane-policy.ts` from the tool's `modelDiscoveryMode`, so a tool with its own authoritative listing renders that listing alone. `src/core/providers/claude-code-options.ts` supplies claude-code's best-effort local option cache, reached through the `ModelCacheAccessor` seam (`getClaudeCodeModelOptions`) so a caller without one — every test, `NULL_CACHE` — sees no disk; it tolerates an absent or malformed `~/.claude.json` and is never a network call. The Anthropic `/v1/models` endpoint is never called.

Detection memory is presentation-only, never execution authority. Workflow start, resume, and `spec` independently call the runner preparation boundary against the exact current configuration; cached or stale success cannot produce execution `gates`, authorize offline execution, create a session, or start a process.

CLI model discovery runs each tool's declared catalog probe (`CliCatalogProbe`, `src/engine/runners/cli-tools/registry.ts`) through `probeContextCatalog` (`src/engine/detection/catalog-probe.ts`) in a neutral temporary directory. A probe may carry a `legacy` listing for releases below a stated version, chosen from the installed version the way the auth probe's legacy is: OpenCode 2 is asked `opencode api GET /api/model`, and a release below 2.0.0 keeps `opencode models --verbose`. A probe may also declare `hostState: 'host-account'` when the credential sandbox cannot answer its listing. Only OpenCode's does, because its server cannot see an `env`-type provider connection the sandbox strips; `catalogProbeEnvironment` is the only reader, and dispatch keeps the channel's own staging (see [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md)). The TUI runs an automatic pass each time it opens; run preparation never probes a catalog.

The `/refresh` slash command re-runs detection as a manual pass, as do `ctrl+r` in a seat picker and `r` on Setup's failed discovery check. A manual pass skips the five-minute reuse and runs a probe's declared manual command: `--refresh` for Kilo Code and for OpenCode below 2.0.0, while OpenCode 2 re-runs the same GET, which its server answers live. Detection results feed the planner, implementer and reviewer seat pickers and the Crew section of the Settings overlay.

---

## 6. Session compaction

`src/core/sessions/compaction.ts`, `src/engine/orchestrator/transcript/rebuild.ts`, `src/engine/orchestrator/transcript/compaction.ts`, `src/engine/orchestrator/resume-context.ts`

Compaction summarizes older turns in `session.jsonl` without deleting them. A summary entry is appended to the log; original messages remain intact. On resume, `readCompactedMessages()` returns the latest summary entry plus only the messages after its `summarizedUpTo` timestamp -- the planner rebuilds context from that smaller window instead of replaying the full log.

**Auto-compaction** fires during `autoCompactResumeContext()` when the planner supports self-summarization (`supportsSelfSummarisation` capability) and the message count exceeds `workflow.compactionThreshold`. The threshold is an integer minimum of 10, set in config. If the threshold is unset or the planner lacks the capability, auto-compaction is skipped.

**Two formats.** `workflow.compactionFormat` controls the output shape. When set to `auto` (the default), the format is selected by planner kind: `api` uses `structured`, everything else uses `freeform`. Freeform summaries are plain text. Structured summaries are JSON objects with fields: `goal`, `stepsCompleted`, `currentStep`, `filesModified`, `constraintsDiscovered`, `remainingWork`. If a structured summarization call returns invalid JSON, the system falls back to freeform and emits a warning.

---

## 7. Evidence ledger

`src/core/evidence/{ledger-state,ledger-storage}.ts`, `src/engine/orchestrator/evidence/{approval,persistence,reporting,retry-counts,task}.ts`, `src/core/schemas/evidence.ts`

The evidence ledger records what happened during implementation -- approval decisions, validation outcomes, task completions, skip reasons, escalation results, and rejection reasons. One ledger per session, persisted as `evidence.json` inside the session directory (`.splitbrief/sessions/<id>/evidence.json`).

The ledger schema (`EvidenceLedgerSchema`, version 1) contains: `sessionId`, `feature`, `generatedAt`, an optional `mode` that only an older run wrote, a `tasks` array, a `validationSummary` rollup, and optional `approvals`, `rejections`, and `finalReview` fields. Each task entry tracks: `id`, `title`, `file`, `status`, `retries`, `durationMs`, `changedFiles`, a `checks` array, a `validation` array, `escalated` flag, and `briefHash`. A `checks` entry records one check run: its `id`, `command`, `exitCode`, a bounded `output`, its `artifacts` with their sha256, the `workspaceSnapshotId` and the time. A red reviewer check also carries `preExisting`: the failure keys that the same command also showed at the run base. A red reviewer check whose base re-run returned a result also carries `base`: the exit code and bounded output of that re-run, or the reason it was refused or not run. Any base-tree preparation failure settles the row as not verified, with the error and any cleanup error in its detail, and records no `base`. Cleanup failure after a completed base command settles the row as not verified, with the cleanup error visible. The review continues; its keys stay unverified and the check has no `base` field, even though the command completed. A stale tree that cannot be removed is reported as a warning that names it; the sweep and the current command continue and the row compares keys as usual. A tree whose `.git` file names a missing gitdir is deleted from disk because its registration is gone. Existing repositories remove each registered tree with `git worktree remove --force <dir>`; no repository-wide prune runs. Callback errors propagate unchanged; any cleanup failure is a warning. Only an older ledger carries `validation` stage entries (stage, passed, error summary, retry state, `baselineExempt`, `skipped` / `skippedReason`) and the retired `expectedEvidence` / `observedEvidence` fields.

`persistTaskEvidence` records the attempt's status, method, retries, duration and changed files. A retry also keeps the first attempt's changed files. No new entry writes `validation` stage entries. A brief check does not re-run at the run base: a red brief check retries the brief, also when the same failure is red at the run base.

The ledger is consumed during the final review phase indirectly: `analyzeBriefDrift()` reads the ledger alongside the diff and task list to compute a drift report, and the drift report is injected into the review prompt as a `Deterministic Drift Report` section. The planner does not see the raw ledger -- it sees the drift analysis derived from it. After the review, `writeReviewPacket()` writes a combined packet alongside the ledger.

Final review attributes changes using the separate session artifact `review-changes.json`. When a brief passes, `captureTaskReviewChanges` (`src/engine/orchestrator/evidence/review-capture.ts`) records each file the brief changed in the run workspace since its task-start snapshot, with its before and after bytes and mode, deletion included. Captured pairs carry the task ID and brief hash. A file the capture cannot read records unknown provenance. This artifact is review evidence and grants no write or recovery authority.

The reviewer receives the captured brief diffs in order and the complete workspace comparison as separate context. Edits after the last captured output are also shown, even when they revert a file to the Git baseline. Mixed files retain operator input without attributing it to the implementer. Final deterministic drift uses only captured brief changes. Missing, invalid, obsolete-brief and uncaptured direct-write evidence remains explicit unknown context. Both reviewer transports keep acceptance and integration failures blocking. The review packet records the evidence status, the recorded run-effect paths, workspace paths and uncertain paths.

---

## 8. Session directory lifecycle

`src/core/sessions/prepare.ts`, `src/core/sessions/ownership-marker.ts`, `src/core/sessions/active-pointer.ts`, `src/core/sessions/liveness.ts`, `src/core/sessions/session-id.ts`, `src/core/sessions/orphans.ts`, `src/engine/orchestrator/run/orphan-reaper.ts`

**Creation.** `prepareNewSession` (`src/core/sessions/prepare.ts`) allocates `.splitbrief/sessions/<id>/` under the project mutation lock, writes a private ownership marker (`.prepare-owner.json`) proving dev/ino identity plus a session generation, and finally publishes `.splitbrief/active` with a v1 receipt (or a legacy plain session id on older paths). Nothing is ever created outside these steps.

**Rollback.** `rollbackPreparedSession` reclaims the directory before `readiness.json` lands: it re-verifies the ownership proof, renames the directory into a quarantine claim name, asserts the canonical path was not recreated, then removes it. `removeAllocatedDirectory` is the same safe-delete template for the allocation path. All of it runs inside the mutation lock.

**Ownership release.** `releasePreparedSession` removes only the ownership marker, leaving the session directory and its artifacts in place. From that moment the directory is no longer protected by preparation.

**What an orphan is.** A session directory that holds nothing but `readiness.json` (or is completely empty) is collectable. It is what an abort or crash after readiness lands leaves behind -- preparation never cleans up after ownership is released, and no command acted on such directories. They are neither live sessions (a run that reached the workflow wrote a lockfile first) nor active ones (a run that has not is the active session).

**The four recognition guards.** A directory is collectable only when **all** hold: (1) it is a directory with a valid session id (quarantine claim names are not valid session ids, so they are never collected); (2) its entries are nothing at all or exactly `readiness.json` as a regular file -- an allowlist, so a future artifact name cannot silently become collectable; (3) it is not the directory the active record names, for both record shapes (a legacy plain session id and a v1 receipt); (4) it is older than the 24-hour grace period (`ORPHAN_SESSION_GRACE_MS`). `discardOrphanSessionDirectory` performs the safe delete under the mutation lock with the same claim/re-verify/assert-not-recreated sequence as rollback, and restores the directory instead when it gains a file between the scan and the claim.

**Where the sweep runs.** `pruneOrphanSessions` (`src/core/sessions/orphans.ts`) sweeps the collectable directories at run start, immediately after the process orphan reaper (`src/engine/orchestrator/run/orphan-reaper.ts`), mirroring its outer catch so an unreadable sessions root cannot abort the workflow. A directory holding only `tasks.md` is not collectable, because the allowlist admits only `readiness.json`.

**Prevention half.** `splitbrief spec` is the one path that would otherwise hold an unguarded window: it never writes a lockfile or `state.json`, so a directory released before the planner call would sit as a plain orphan for the whole planning run. `spec` therefore keeps preparation ownership across the planner call — released only after planning resolves, rolled back (directory removed, active pointer cleared) when the call fails. T036's sweep is the collection half for everything that still lands on disk.

---

## 9. Seat probe

`src/cli/commands/doctor.ts` (`--probe-seat`), `src/engine/runners/seat-failure.ts`

`splitbrief doctor --probe-seat <plan|build|review>` makes one paid call through the named seat's CLI adapter, with the seat's own model, effort, variant and args. The probe runs alone: the readiness report and the preparation preflights do not run, so a readiness blocker does not stop it. The call uses the sandbox environment a run uses. The seat adapter's own `parse` and `terminal` read the captured stdout, as in a run. A completed terminal result with exit status `0` is the class `passed`. A failed terminal result goes to `classifySeatFailure` with its own error and the stderr, never the stream frames: an agy `init` frame lists `browser_get_network_request`, which reads as a network fault. Without a terminal result, the stdout and stderr go to the classifier, so an account, sign-in or limit message keeps its class. A non-zero exit status passes the `non-zero-exit` outcome to the classifier. The output is redacted of the seat's credential values before the record is written.

The result prints as `Seat probe <seat>: <class>`, and a failed call adds its first error line. The record is appended as one JSON line to `.splitbrief/probes/<tool>-<date>.jsonl`. Only CLI seats are supported. An `api`, `shell` or `agent` seat exits `1` with an error that names the seat and its kind.
