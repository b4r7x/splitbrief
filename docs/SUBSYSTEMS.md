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

Content-addressed working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/`. The snapshot store handles creation (`src/engine/snapshots/create.ts`), manifest management (`src/engine/snapshots/manifest.ts`), and file collection (`src/engine/snapshots/files.ts`). Run-level accept/reject logic lives in `src/engine/snapshots/run/` (`lifecycle.ts`, `ledger.ts`, `rollback.ts`).

A run writes these snapshots. A worktree or staged-copy run also takes `workspace-base` at build start (`src/engine/orchestrator/run/task-execution.ts`); its run workspace starts from it, and Apply and `run.patch` diff against it. The other two come from `src/engine/orchestrator/run/snapshots.ts`: `ensureRunBaselineSnapshot` runs before the first task and, when the session has no baseline yet, captures the **baseline snapshot** -- the "before" state -- storing every tracked file (excluding `.git`, `.splitbrief`, `node_modules`, `.trees`); `recordRunSnapshotForRun` runs after the task loop completes and before the final review reads the diff, and captures the `pre-final-review` snapshot. A checkout run also runs `recordCheckoutRunSnapshot` after each brief settles and again when the run comes to rest, after isolation disposal settles the last attempt revert. These `post-task-<n>` snapshots capture what the run wrote, also when the run stops or halts before its review. Each of these snapshots goes into the run ledger. On a run without a workspace, `/run accept` writes the accepted-run snapshot. A non-baseline snapshot stores only files whose hash or mode differs from the baseline, with the manifest recording every file's hash. The manifest records the mode of each stored file. The manifest also records the symlink targets in `symlinks`; a manifest without `symlinks` is an older one, which `run.patch` and Apply compare by content only. File blobs are stored under hex-encoded path names within each snapshot directory.

Snapshots track the run's project directory, never the run workspace -- the run worktree lives at `$XDG_STATE_HOME/splitbrief/trees/<repo-key>/<session-id>/` (default `~/.local/state/splitbrief/trees/...`), outside both `.git/` and the project root. A run without a workspace writes into the project directory, so its snapshots capture what it wrote, the same thing the user would see in `git status`. A worktree or staged-copy run keeps its result in the workspace until Apply; its `/run reject confirm` restores from the Apply backup, not from these snapshots ([WORKFLOW.md §Apply](./WORKFLOW.md#apply)).

Separate from snapshots, the run's changed-files baseline (`src/engine/orchestrator/changed-files-baseline.ts`) fingerprints every changed file at task-loop entry into a sha256 hex, `symlink:<target>` for a symlink that stays inside the project (a relative target that the kernel lands inside the project root and outside `.git` and `.splitbrief`), or one of two sentinels: `missing` (deleted since the baseline) and `unreadable` (any other symlink, a directory, or a file SPLITBRIEF could not read). The old `changed-file-fingerprint-read` error kind was removed with the throw-on-unreadable behaviour: an unreadable entry is recorded and named once in a run-start warning -- never treated as missing and never opened.

The run ledger (`run-ledger.json`) tracks the snapshots used by checkout rejection and by older runs without a workspace. Worktree and staged-copy runs use Discard before Apply and the Apply backup after Apply ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)). The ledger records the `pre-final-review` snapshot and, on a checkout run, the `post-task-<n>` snapshots; `/run accept` on an older run appends the accepted-run snapshot and seals the ledger. Rejection compares the baseline, the latest recorded run snapshot and the current checkout. It restores or deletes only recorded run changes that still match the run snapshot, and names later edits it leaves intact. A checkout run closes as discarded only with no conflicts or missing snapshot files. Rejection refuses closed runs except undo of a completed Apply from its backup in a worktree or staged-copy run. A file that rejection recreates gets the mode that the baseline recorded. Only a run killed before its first brief settled has no recorded run snapshot. Rejection then reports `No run snapshot to reject.` and changes no files. Events: `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`.

---

## 3. Repo-map

`src/engine/codebase/`

Token-budgeted codebase summary fed to every planner call. `src/engine/codebase/repomap.ts` is the entry point: `buildRepoMap(projectDir, opts)`.

The pipeline: discover source files -> parse them with tree-sitter (`src/engine/codebase/parse.ts`, grammars for TypeScript, JavaScript, Python, Go, Rust via `src/engine/codebase/languages.ts`) -> build an import graph from symbols and references (`src/engine/codebase/graph.ts`) -> score with PageRank (`src/engine/codebase/pagerank.ts`, files imported by many others rank higher, explicit focus files get a rank boost) -> trim to fit the token budget (`src/engine/codebase/budget.ts`). Feature text is scanned for mentioned filenames (`src/engine/codebase/extract-mentioned-filenames.ts`) which get added to focus files.

Parse results are cached in SQLite at `.splitbrief/repomap.sqlite` via `src/engine/codebase/cache.ts`; stale rows are re-parsed on each planning run, so there is no manual rebuild step. Default budget is 4000 tokens. Deep-dive: `docs/REPOMAP.md`.

---

## 4. Runtime commands

`src/core/runtime/commands/`

User-facing commands typed as `/name args` in the composer. Defined in `src/core/runtime/commands/defs/<category>.ts` and assembled by `createRuntimeCommands(ctx)` in `src/core/runtime/commands/registry.ts`, which takes a `RuntimeCommandContext` providing access to navigation, overlays, detection, the run's accept and reject, and other capabilities.

Each command declares: `name`, a `kind` discriminant (`noarg` or `arg`), `handler`, `validScreens` (which screens the command can run on), a one-line `description`, and a `category` from `COMMAND_CATEGORIES` (`navigate` | `crew` | `workflow` | `view` | `io`). `'arg'` commands also declare `args` -- either a closed option set or a free-form hint. Optional: `label` (display override), `shortcut`, `hidden`, and `guard: (ctx) => string | undefined` -- a returned string is the reason the command is unavailable. The command palette (Ctrl-K) and the help overlay list every command that is not `hidden`, is valid on the current screen, and whose `guard` returns `undefined` (`buildCommandItems`, `src/features/palette/sources.ts`); a blocked command is hidden rather than shown and errored. Recipe: `docs/EXTENDING.md` section 2 is canonical.

Dispatch (`src/core/runtime/commands/dispatch.ts`): parse the raw input, split name from args, look up the command by its exact name, ignoring case (`findRuntimeCommand`, `src/core/runtime/commands/lookup.ts`), validate screen and phase guards, then execute the handler. An unknown name runs nothing: a removed name gets a pointer to its replacement (`removedCommandPointer`), and any other name gets a close-name suggestion (`suggestRuntimeCommand`) in the error. The composer `/` picker lists the commands whose names start with the typed word; the palette ranks by fuzzy match. Errors are surfaced through the `onError` callback. Full reference: `docs/SLASH-COMMANDS-REFERENCE.md`.

---

## 5. Detection

`src/engine/detection/`

Auto-detect available planner and implementer tools on startup. `src/engine/detection/detect.ts` probes every CLI tool in `CLI_TOOL_IDS` (`src/core/runners/cli-tool-catalog.ts`: claude-code, codex, opencode, copilot, kilo-code, cursor, command-code, antigravity). For each tool it resolves the executable from the tool's `executableAliases` (`resolveCliExecutableAliases`), then runs the tool's declared readiness probe (`probeCliReadiness`) for its version, compatibility and authentication. `detectAvailableProviders` (`src/engine/providers/catalog-detection.ts`) asks each API provider in `API_PROVIDER_CATALOG` (Ollama, LM Studio, llama.cpp) for its model list.

SPLITBRIEF remembers sanitized readiness rows in `.splitbrief/detection-cache.json` through `src/engine/detection/cache.ts`. The cache writes only into an existing `.splitbrief/` and never creates the folder: the first config save creates it with its ignore rule, so discovery before that save stays in memory. The record belongs to the current project and carries its non-secret configuration context. The context uses a short digest of the project path. Thus, a folder name such as `my-local-app` does not trigger the private-identifier check. The record also stores sanitized provider models and CLI catalogs for the first picker display. Model rows keep their ids, names, details, sizes, order, effort options, modality flags, capability facts, and hidden flags.

All CLI catalogs use `mergeCatalogRead` in `src/core/discovery/catalog-read-merge.ts` for the memory and disk caches. Each successful read adds new models at once and replaces metadata for matching `DetectedModel.id` values. A model absent from one read stays cached with a `missingOnce` mark. The next successful read removes it only if it is absent again. If the model returns, the read clears its mark. Read rows come first, followed by retained missing rows in their cached order.

CLI catalog reads accept at most 1,000 models; an over-bound read fails and keeps the remembered list.

A catalog stays `stale` while it retains a model absent from the latest read. An empty successful read is never `fresh`, including when two empty reads remove all models. Only a complete, non-empty read advances the memory fetch time and the disk probe time. A failed read changes neither the models nor the missing marks; it keeps the existing stale-on-failure behavior. A reused snapshot is not a new read. Disk records keep the missing marks across restarts, and older records without marks still load.

The OpenCode daemon's `{"data": []}` reply declares a successful empty read. Empty text output does not declare a list, so text parsers reject it.

Remembered rows hydrate as stale presentation data before the live refresh. The record omits private configured-provider outcomes, credentials, connection context keys, and trusted executable receipts. Restored CLI rows have no executable identity. A record with a different configuration context still hydrates for presentation, with generation `0`, so it cannot outrank a live lane. The detection service requires a strict context match for authoritative reads. SPLITBRIEF ignores invalid records and removes legacy formats that contained private fields.

Store initialization publishes the remembered snapshot as stale presentation data before starting the asynchronous discovery refresh. With no remembered result, Setup shows the "Waking your crew…" boot manifest — configured seats with live per-seat marks and discovery lanes ticking in — and waits for a fresh result. With remembered data, the picker stays usable and shows a compact "Refreshing your tools…" status; refresh failure preserves the remembered rows with a failure/stale indication. The detection service (`src/engine/detection/service.ts`) coordinates this refresh, a five-minute soft in-memory readiness TTL, models-dev catalog fetching, and CLI model discovery.

The detection service's `shutdown()` refuses new cache saves, cancels refresh lanes, and waits for accepted saves. It refuses later refreshes. See [ARCHITECTURE.md](./ARCHITECTURE.md#data-flow-one-task) for the cleanup order, process exit, and caller-requested unmount.

The models.dev catalog (`src/engine/providers/models-dev.ts`, cached under the user cache directory) is a metadata source for the model catalog resolver (`src/engine/providers/model/catalog.ts`): context window, pricing, release date, display name, and the per-model reasoning ladder (`reasoning_options` → `nativeReasoningEfforts`; only an `effort` entry names rungs, any other entry set means "this row names none", and a row without the field says nothing — no key). Which lanes may create picker rows is decided by `src/engine/providers/model/lane-policy.ts` from the tool's `modelDiscoveryMode`, so a tool with its own authoritative listing renders that listing alone. `src/core/providers/claude-code-options.ts` supplies claude-code's best-effort local option cache, reached through the `ModelCacheAccessor` seam (`getClaudeCodeModelOptions`) so a caller without one — every test, `NULL_CACHE` — sees no disk; it tolerates an absent or malformed `~/.claude.json` and is never a network call. The Anthropic `/v1/models` endpoint is never called.

Detection memory is presentation-only, never execution authority. Workflow start, resume, and `spec` independently call the runner preparation boundary against the exact current configuration; cached or stale success cannot produce execution `gates`, authorize offline execution, create a session, or start a process.

CLI model discovery runs each tool's declared catalog probe (`CliCatalogProbe`, `src/engine/runners/cli-tools/registry.ts`) through `probeContextCatalog` (`src/engine/detection/catalog-probe.ts`) in a neutral temporary directory. A probe may carry a `legacy` listing for releases below a stated version, chosen from the installed version the way the auth probe's legacy is: OpenCode 2 is asked `opencode api GET /api/model`, and a release below 2.0.0 keeps `opencode models --verbose`. A probe may also declare `hostState: 'host-account'` when the credential sandbox cannot answer its listing. Only OpenCode's does, because its server cannot see an `env`-type provider connection the sandbox strips; `catalogProbeEnvironment` is the only reader, and dispatch keeps the channel's own staging (see [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md)). A probe may declare a `directoryHeader` too. OpenCode 2's is `x-opencode-directory`: `runAdmittedCatalogProbe` appends `-H x-opencode-directory:<encodeURIComponent(projectDir)>`, so the list carries the providers the project's `opencode.json` sets up, while the cwd stays the neutral directory and the legacy listing drops the header. The header makes the user's OpenCode server load the project's config, plugins and local MCP servers, so it is sent only for a tool the config runs (`crewCliTools`, `src/core/crew/seats.ts`: PLAN, every BUILD profile, REVIEW and their fallbacks). Detection passes that set as `crewTools`; the fresh reads of doctor, start and the halt are for a configured seat and always name the project. The TUI runs an automatic pass each time it opens, and reads the lists again, as `/refresh` does, when a config change puts a tool with a `directoryHeader` on the crew; run preparation reads a list only when a seat's route waits on it and no saved list counts for it. A saved list records whether its read named the project (`namesProject`), and `savedRouteCatalog` (`src/engine/detection/route-catalog.ts`) picks the list a route of doctor, start or a halt is read against: an OpenCode list read before OpenCode joined the crew, or saved by an earlier release, counts only for a route whose provider it serves, so any other route reads the list again with the header.

The `/refresh` slash command re-runs detection as a manual pass, as do `ctrl+r` in a seat picker and `r` on Setup's failed discovery check. A manual pass skips the five-minute reuse and runs a probe's declared manual command: `--refresh` for Kilo Code and for OpenCode below 2.0.0, while OpenCode 2 re-runs the same GET, which its server answers live. Detection results feed the planner, implementer and reviewer seat pickers and the Crew section of the Settings overlay.

---

## 6. Session compaction

`src/core/sessions/compaction.ts`, `src/engine/orchestrator/transcript/rebuild.ts`, `src/engine/orchestrator/transcript/compaction.ts`, `src/engine/orchestrator/resume-context.ts`

Compaction summarizes older turns in `session.jsonl` without deleting them. A summary entry is appended to the log; original messages remain intact. On resume, `readCompactedMessages()` returns the latest summary entry plus only the messages after its `summarizedUpTo` timestamp -- the planner rebuilds context from that smaller window instead of replaying the full log.

Freeform compaction summarizes the reconstructed planner conversation. It places the previous summary first as a user message, then uses later planner turns. It excludes implementer output and pending queued messages. The reconstruction restores saved file bodies from `state.json` before summarization. Compaction keeps every entry from the first pending queue entry onward, so the pending message can still enter context after delivery.

**Auto-compaction** fires during `autoCompactResumeContext()` when the planner supports self-summarization (`supportsSelfSummarisation` capability) and the message count exceeds `workflow.compactionThreshold`. The threshold is an integer minimum of 10, set in config. If the threshold is unset or the planner lacks the capability, auto-compaction is skipped.

**Two formats.** `workflow.compactionFormat` controls the output shape. When set to `auto` (the default), the format is selected by planner kind: `api` uses `structured`, everything else uses `freeform`. Freeform summaries are plain text. Structured summaries are JSON objects with fields: `goal`, `stepsCompleted`, `currentStep`, `filesModified`, `constraintsDiscovered`, `remainingWork`. If a structured summarization call returns invalid JSON, the system falls back to freeform and emits a warning.

---

## 7. Evidence ledger

`src/core/evidence/{ledger-state,ledger-storage}.ts`, `src/engine/orchestrator/evidence/{approval,persistence,reporting,retry-counts,task}.ts`, `src/core/schemas/evidence.ts`

The evidence ledger records what happened during implementation -- approval decisions, validation outcomes, task completions, skip reasons, escalation results, and rejection reasons. One ledger per session, persisted as `evidence.json` inside the session directory (`.splitbrief/sessions/<id>/evidence.json`).

The ledger schema (`EvidenceLedgerSchema`, version 1) contains: `sessionId`, `feature`, `generatedAt`, an optional `mode` that only an older run wrote, a `tasks` array, a `validationSummary` rollup, and optional `approvals`, `rejections`, `finalReview` and `reviews` fields. `reviews` lists every review in the order it ran, task reviews included: its scope, the brief a task review follows, the fix cycle, the outcome and each blocking finding with its text. `review.json` holds only the latest review, so a failed review and its findings stay on record in `reviews`, in the review packet's *Reviews* section and in the closed run's Run section, where each review that failed before the review of record is named under the Review row in the transcript's words (`Final review after 1 fix cycle`), with one row per finding. Each task entry tracks: `id`, `title`, `file`, `status`, `retries`, `durationMs`, `changedFiles`, a `checks` array, `escalated` flag, and `briefHash`. A `checks` entry records one check run: its `id`, `command`, `exitCode`, a bounded `output`, its `artifacts` with their sha256, the `workspaceSnapshotId` and the time. A red reviewer check also carries `preExisting`: the failure keys that the same command also showed at the run base. A red reviewer check whose base re-run returned a result also carries `base`: the exit code and bounded output of that re-run, or the reason it was refused or not run. Any base-tree preparation failure settles the row as not verified, with the error and any cleanup error in its detail, and records no `base`. Cleanup failure after a completed base command settles the row as not verified, with the cleanup error visible. The review continues; its keys stay unverified and the check has no `base` field, even though the command completed. A stale tree that cannot be removed is reported as a warning that names it; the sweep and the current command continue and the row compares keys as usual. A tree whose `.git` file names a missing gitdir is deleted from disk because its registration is gone. Existing repositories remove each registered tree with `git worktree remove --force <dir>`; no repository-wide prune runs. Callback errors propagate unchanged; any cleanup failure is a warning. An older ledger can carry `validation` stage entries and the retired `expectedEvidence` / `observedEvidence` fields; the schema drops them when it loads the ledger. The review packet's line for each brief counts the brief's own check results (`T001 done: 2 of 2 checks passed`, or `no checks`) in the words of the `--plain` task line, so it agrees with the Checks Log.

`persistTaskEvidence` records the attempt's status, method, retries, duration and changed files. A retry also keeps the first attempt's changed files. No new entry writes `validation` stage entries. A brief check does not re-run at the run base: a red brief check retries the brief, also when the same failure is red at the run base.

The ledger is consumed during the final review phase indirectly: `analyzeBriefDrift()` reads the ledger alongside the diff and task list to compute a drift report, and the drift report is injected into the review prompt as a `Deterministic Drift Report` section. The reviewer sees the drift analysis derived from the ledger. After the review, `writeReviewPacket()` writes a combined packet alongside the ledger. Its Recovery Decisions section keeps recovery headlines and automatic or manual seat switches, with both identities and their cause, a crew change made before a continue included; saved `state.seatSwitches` supply missing switch events without duplicating logged switches. The three seat lines use the shared seat identity formatter and only borrow axes from matching `seats.json` identities. Admission readiness keeps the original warnings and capture time from `readiness.json`, scoped to admission rather than the later switched crew.

Final review attributes changes using the separate session artifact `review-changes.json`. When a brief passes, `captureTaskReviewChanges` (`src/engine/orchestrator/evidence/review-capture.ts`) records each file the brief changed in the run workspace since its task-start snapshot, with its before and after bytes and mode, or a symlink by its target, deletion included. Captured pairs carry the task ID and brief hash. A file the capture cannot read records unknown provenance. This artifact is review evidence and grants no write or recovery authority.

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
