# SPLITBRIEF — Supporting subsystems

These subsystems sit outside the core workflow loop but are essential to the full system. Each section explains what it does, where the code lives, and how to use it. For the core workflow, see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). For the engine and EventBus, see [ENGINE.md](./ENGINE.md). For approval and recovery, see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

## 1. Workflow hooks

`src/engine/hooks/`

User-declared commands that fire on workflow events. Configured in the `hooks` section of the SPLITBRIEF config file, or auto-discovered from `.splitbrief/hooks/` as ES module files named by event (e.g. `pre-task.ts`, `post-commit.js`). Discovery and merge logic lives in `src/engine/hooks/discover.ts`.

**Pre-hooks** (`pre_planning`, `pre_task`, `pre_validation`, `pre_commit`, `pre_escalation`) run synchronously before the action. If a hook exits non-zero or returns `{ kind: 'deny' }`, the action is blocked. Dispatched at the orchestrator call site via `src/engine/hooks/run-pre.ts`, which also runs active built-in hooks before user entries. `pre_compact` is a reserved event key — it is config-validated but has no dispatch site yet (see `docs/HOOKS-CONFIG.md`).

**Post-hooks and on-hooks** (`post_task`, `post_validation`, `post_commit`, `on_complete`, `on_error`) fire asynchronously after the action through the hook sink on the EventBus (`src/engine/hooks/sink.ts`). A deny outcome from a post-hook is informational only -- it cannot block the already-completed action.

Hooks support two kinds: `command` (spawns a subprocess, receives the event as JSON on stdin) and `module` (loads an ES module exporting a handler function). Variable substitution in command args uses `${event.<path>}` syntax -- for example `${event.taskId}`, `${event.phase}`. Resolved by `src/engine/hooks/substitute.ts`. Each hook entry declares an `on_failure` policy: `block`, `warn`, or `ignore`.

**Trust model:** hooks must be trusted before first execution. `src/core/hooks/trust-digest.ts` computes a SHA-256 hash of the hooks config and `src/core/hooks/trust.ts` stores a receipt in the owner's trust store (`~/.splitbrief/trust/hooks.json`), keyed by the canonical path of this checkout — the same store and key custom runner trust uses, so a repository can neither ship nor forge a grant. If the config changes, the user is prompted to re-trust. Deep-dive: `docs/HOOKS-CONFIG.md`.

---

## 2. Snapshots

`src/engine/snapshots/`

Content-addressed working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/`. The snapshot store handles creation (`src/engine/snapshots/create.ts`), manifest management (`src/engine/snapshots/manifest.ts`), and file collection (`src/engine/snapshots/files.ts`). Restore logic lives in `src/engine/snapshots/restore.ts`. Run-level accept/reject logic lives in `src/engine/snapshots/run/` (`lifecycle.ts`, `ledger.ts`, `rollback.ts`).

The first snapshot creates the **baseline snapshot** -- the "before" state. It stores every tracked file (excluding `.git`, `.splitbrief`, `node_modules`, `.trees`). Subsequent snapshots store only files whose hash differs from the baseline, with the manifest recording every file's hash. File blobs are stored under hex-encoded path names within each snapshot directory.

Snapshots track the run's project directory, never the implementer's isolation directory -- run isolation lives at `$XDG_STATE_HOME/splitbrief/trees/<repo-key>/<session-id>/` (default `~/.local/state/splitbrief/trees/...`), outside both `.git/` and the project root, and the `.trees` exclusion keeps a `--worktree` session's checkout out of another worktree's snapshots. What a snapshot captures is therefore the promoted result, the same thing the user would see in `git status`.

Separate from snapshots, the run's changed-files baseline (`src/engine/orchestrator/changed-files-baseline.ts`) fingerprints every changed file at task-loop entry into a sha256 hex or one of two sentinels: `missing` (deleted since the baseline) and `unreadable` (a symlink, a directory, or a file SPLITBRIEF could not read). The old `changed-file-fingerprint-read` error kind was removed with the throw-on-unreadable behaviour: an unreadable entry is recorded, named once in a run-start warning, and excluded from user-edit detection -- never treated as missing and never opened.

Auto-snapshot triggers fire at `preTask`, `postTask`, and `preFinalReview` phases. Manual snapshots are available via `splitbrief snapshot create`. The run ledger (`run-ledger.json`) tracks which snapshots belong to the current run so that `/accept-run` and `/reject-run confirm` operate on the correct state. Rejection restores baseline files, deletes files that were created during the run, and reports conflicts where the working tree diverged from both baseline and snapshot. Events: `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`.

---

## 3. IPC and attach/detach

`src/engine/ipc/`

`splitbrief start --detach` spawns a background server process (`src/engine/ipc/spawn-server.ts` -> `src/engine/ipc/server-entry.ts`). The server runs the workflow headlessly and exposes a Unix domain socket at `.splitbrief/sessions/<id>/ipc.sock`. The IPC protocol (`src/engine/ipc/protocol.ts`) defines `ServerMessage` and `ClientMessage` types over newline-delimited JSON.

`splitbrief attach <session-id>` connects a TUI client to the socket. On connect, the server sends `session_meta`, replays historical events from the session JSONL log (`src/engine/ipc/replay.ts`), then streams live events. The client sends user input and prompt responses back to the server. Only one client can attach at a time -- a second connection enters a control-channel grace window where it can send `{kind:'detach'}` to steal the session, or gets rejected with `already_attached`. When the session is stolen, the server sends the displaced client a terminal `already_attached` error frame before destroying its socket, so the displaced client stops (does not reconnect) instead of treating the close as a transient drop.

`splitbrief ps` lists active IPC sockets. `splitbrief detach` (or sending a `detach` message) disconnects the client without stopping the server. If the server process dies, crash diagnostics are built from the lockfile and server log tail (`src/engine/ipc/crash-diagnostic.ts`), showing a post-mortem with PID, timestamps, exit code, signal, and the last log lines. Events: `ipc_server_started`, `ipc_client_attached`, `ipc_client_detached`.

---

## 4. Repo-map

`src/engine/codebase/`

Token-budgeted codebase summary fed to every planner call. `src/engine/codebase/repomap.ts` is the entry point: `buildRepoMap(projectDir, opts)`.

The pipeline: discover source files -> parse them with tree-sitter (`src/engine/codebase/parse.ts`, grammars for TypeScript, JavaScript, Python, Go, Rust via `src/engine/codebase/languages.ts`) -> build an import graph from symbols and references (`src/engine/codebase/graph.ts`) -> score with PageRank (`src/engine/codebase/pagerank.ts`, files imported by many others rank higher, explicit focus files get a rank boost) -> trim to fit the token budget (`src/engine/codebase/budget.ts`). Feature text is scanned for mentioned filenames (`src/engine/codebase/extract-mentioned-filenames.ts`) which get added to focus files.

Parse results are cached in SQLite at `.splitbrief/repomap.sqlite` via `src/engine/codebase/cache.ts`; stale rows are re-parsed on each planning run, so there is no manual rebuild step. Default budget is 4000 tokens. Deep-dive: `docs/REPOMAP.md`.

---

## 5. Handoff

`src/engine/handoff/`

Export compiled briefs to formats other agents consume. `src/engine/handoff/render.ts` dispatches to built-in renderers based on the target:

- `spec-kit` -- `src/engine/handoff/renderers/spec-kit.ts`
- `agents-md` -- `src/engine/handoff/renderers/agents-md.ts`
- `claude-code` -- `src/engine/handoff/renderers/claude-code.ts`
- `copilot-issue` -- `src/engine/handoff/renderers/copilot-issue.ts`

Custom renderers are loaded from runtime-loadable `.splitbrief/handoff-renderers/<target>.ts` or `.js` files via `src/engine/handoff/load-renderer.ts`. A handoff manifest with metadata (session ID, brief hash, source commit, task IDs, artifact paths) is written alongside the pack (`src/engine/handoff/manifest.ts`). Custom targets are supported by the `splitbrief handoff <target>` CLI; `/handoff` currently validates against built-in `HANDOFF_TARGETS`.

---

## 6. MCP server

`src/engine/mcp/`

Exposes session artifacts as MCP resources for external clients. Started via `splitbrief mcp serve`. The HTTP server (`src/engine/mcp/server.ts`) implements Streamable HTTP MCP (protocol version `2025-11-25`), with bearer token auth and local-origin CORS enforcement.

The resolver (`src/engine/mcp/resolver.ts`) serves the sessions index at `mcp://splitbrief/sessions` and per-session resources under `mcp://splitbrief/sessions/<id>/`: manifest, spec, plan, tasks (list and individual briefs), evidence ledger, drift report, workflow state, and summary. All resources are read from the session directory on disk.

The server optionally exposes MCP tools when a tool handler is provided (`src/engine/mcp/tool/`). The tools mutate the evidence ledger: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. Input validation uses Zod schemas (`src/engine/mcp/tool/schemas.ts`). These tools let external agents report work back into a SPLITBRIEF session.

---

## 7. Git worktrees

`src/engine/worktree/{create,status,remove,detect,path,cleanliness,errors}.ts` + `src/cli/commands/worktree.ts` + `src/cli/commands/start/worktree.ts`

Worktrees serve two jobs. **Run isolation:** a run whose implementer writes files itself (`writesFiles: 'direct'`) works in a git worktree created once for the run rather than in the user's checkout, at `$XDG_STATE_HOME/splitbrief/trees/<hash>/<session-id>/` (default `~/.local/state/...`) — outside `.git/` and the project root so direct-writing CLIs can edit freely and project-rooted test globs never walk the second copy — see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) §Isolation and promotion. **Parallel sessions:** `splitbrief start --worktree "feature"` creates a worktree on branch `splitbrief/<name>` and runs the whole session inside it, so it gets its own `.splitbrief/` directory and therefore its own session lock. `splitbrief worktree list | switch | path | remove` manages the directories under `.trees/<name>/`.

Worktree names are validated against a strict whitelist (`[A-Za-z0-9_][A-Za-z0-9._-]{0,63}`, `validateWorktreeName` in `path.ts`), and the resolved path is confined — under `.trees/` for a `--worktree` checkout (`resolveConfinedWorktreePath`), under the per-repo trees root for run isolation (`resolveConfinedIsolationWorktreePath`, `isolationWorktreePath` in `paths.ts`). Creation refuses to proceed when the source working tree is dirty, unless the caller opts out with `requireCleanSource: false` — run isolation does, and seeds the uncommitted working state into the fresh checkout instead. Creation copies `.splitbrief/config.yaml` and `.splitbrief/hooks/` from the base checkout, and runs `git submodule update --init --recursive` when the repo declares submodules. Removal checks for live sessions and uncommitted changes, requiring `--force` to bypass. The optional `--delete-branch` flag removes the `splitbrief/<name>` branch after worktree removal. `detectWorktree()` determines whether the current project directory is inside a SPLITBRIEF-managed worktree by comparing `git rev-parse --git-dir` and `--git-common-dir`.

A worktree shares refs, git config, and hooks with the real repository. It isolates files, not the machine, and it is not a security boundary. Deep-dive: `docs/WORKTREES.md`.

---

## 8. Runtime commands

`src/core/runtime/commands/`

User-facing commands typed as `/name args` in the composer. Defined in `src/core/runtime/commands/defs/<category>.ts` and assembled by `createRuntimeCommands(ctx)` in `src/core/runtime/commands/registry.ts`, which takes a `RuntimeCommandContext` providing access to navigation, overlays, detection, rewind, handoff, snapshots, and other capabilities.

Each command declares: `name`, a `kind` discriminant (`noarg` or `arg`), `handler`, `validScreens` (which screens the command can run on), a one-line `description`, and a `category` from `COMMAND_CATEGORIES` (`navigate` | `crew` | `workflow` | `view` | `io`). `'arg'` commands also declare `args` -- either a closed option set or a free-form hint. Optional: `aliases` (`{ name, args? }` pairs, so an alias can pin an argument), `label` (display override), `shortcut`, `hidden`, and `guard: (ctx) => string | undefined` -- a returned string is the reason the command is unavailable. The command palette (Ctrl-K) lists every command that is not `hidden`, is valid on the current screen, and whose `guard` returns `undefined`; a blocked command is hidden rather than shown and errored. Recipe: `docs/EXTENDING.md` section 2 is canonical.

Dispatch (`src/core/runtime/commands/dispatch.ts`): parse the raw input, split name from args, look up the command via fuzzy matching (`src/core/runtime/commands/lookup.ts`), validate screen and phase guards, then execute the handler. Errors are surfaced through the `onError` callback. Full reference: `docs/SLASH-COMMANDS-REFERENCE.md`.

---

## 9. Session export

`src/engine/export/`

Export a session's outcomes as a self-contained HTML report. Triggered via `/export` slash command or `splitbrief export` CLI.

`src/engine/export/collect.ts` gathers export data from the session directory: summary, evidence ledger, drift report, and brief quality report. `src/engine/export/html-renderer.ts` renders this into a single HTML file with inline CSS -- dark-theme, monospace, no external dependencies. The report includes: header with feature name and session ID, cost savings breakdown, metadata (planner, implementer, mode, total time), task summary with outcome badges, evidence and drift scores, and phase timing bars. Output goes to `<session-dir>/report.html`.

---

## 10. Detection

`src/engine/detection/`

Auto-detect available planner and implementer tools on startup. `src/engine/detection/detect.ts` probes CLI tools (claude-code, codex, copilot, opencode, kilo-code, cursor, command-code) by spawning them and checking `isAvailable()` + `getVersion()`, checks API providers for valid keys or reachable endpoints, and always includes the `shell` planner as available.

The sanitized readiness projection is remembered locally in `.splitbrief/detection-cache.json` (`src/engine/detection/cache.ts`). The record is written for the current project and carries the non-secret configuration context it was produced under. Alongside readiness rows it remembers sanitized model rows — provider model lists and per-role CLI catalog inventories reduced to identity, sizing, and ordering fields — so pickers render a remembered catalog immediately on the next start; the rows hydrate as stale presentation data and the live refresh replaces them. It omits private configured-provider outcomes, credentials, connection context keys, and trusted executable receipts; restored CLI rows have no executable identity. Startup hydration is project-scoped: a record whose configuration context does not match still hydrates, as presentation-only rows with their generation reset to 0, so they never outrank a live lane and the refresh replaces them. The strict context match still gates the detection service's authoritative reads. An invalid record is ignored, and legacy cache formats that contained private fields are removed.

Store initialization publishes the remembered snapshot as stale presentation data before starting the asynchronous discovery refresh. With no remembered result, Setup shows the "Waking your crew…" boot manifest — configured seats with live per-seat marks and discovery lanes ticking in — and waits for a fresh result. With remembered data, the picker stays usable and shows a compact "Refreshing your tools…" status; refresh failure preserves the remembered rows with a failure/stale indication. The detection service (`src/engine/detection/service.ts`) coordinates this refresh, a five-minute soft in-memory readiness TTL, models-dev catalog fetching, and CLI model discovery.

The models.dev catalog (`src/engine/providers/models-dev.ts`, cached under the user cache directory) is a metadata source for the model catalog resolver (`src/engine/providers/model/catalog.ts`): context window, pricing, release date, display name, and the per-model reasoning ladder (`reasoning_options` → `nativeReasoningEfforts`; only an `effort` entry names rungs, any other entry set means "this row names none", and a row without the field says nothing — no key). Which lanes may create picker rows is decided by `src/engine/providers/model/lane-policy.ts` from the tool's `modelDiscoveryMode`, so a tool with its own authoritative listing renders that listing alone. `src/core/providers/claude-code-options.ts` supplies claude-code's best-effort local option cache, reached through the `ModelCacheAccessor` seam (`getClaudeCodeModelOptions`) so a caller without one — every test, `NULL_CACHE` — sees no disk; it tolerates an absent or malformed `~/.claude.json` and is never a network call. The Anthropic `/v1/models` endpoint is never called.

Detection memory is presentation-only, never execution authority. Workflow start, resume, and `spec` independently call the runner preparation boundary against the exact current configuration; cached or stale success cannot produce execution `gates`, authorize offline execution, create a session, or start a process.

The `/refresh` slash command invalidates the cache and re-runs detection. Detection results feed the planner, implementer, reviewer, and escalation seat pickers and the Crew section of the Settings overlay.

---

## 11. Session compaction

`src/core/sessions/compaction.ts`, `src/engine/orchestrator/transcript/rebuild.ts`, `src/engine/orchestrator/transcript/compaction.ts`, `src/engine/orchestrator/resume-context.ts`

Compaction summarizes older turns in `session.jsonl` without deleting them. A summary entry is appended to the log; original messages remain intact. On resume, `readCompactedMessages()` returns the latest summary entry plus only the messages after its `summarizedUpTo` timestamp -- the planner rebuilds context from that smaller window instead of replaying the full log.

**Auto-compaction** fires during `autoCompactResumeContext()` when the planner supports self-summarization (`supportsSelfSummarisation` capability) and the message count exceeds `workflow.compactionThreshold`. The threshold is an integer minimum of 10, set in config. If the threshold is unset or the planner lacks the capability, auto-compaction is skipped. **Manual compaction** is triggered via `/compact-transcript`, which creates a planner instance and calls `performManualCompaction()`. If the planner does not support summarization, the command returns `unsupported`.

**Two formats.** `workflow.compactionFormat` controls the output shape. When set to `auto` (the default), the format is selected by planner kind: `api` uses `structured`, everything else uses `freeform`. Freeform summaries are plain text. Structured summaries are JSON objects with fields: `goal`, `stepsCompleted`, `currentStep`, `filesModified`, `constraintsDiscovered`, `remainingWork`. If a structured summarization call returns invalid JSON, the system falls back to freeform and emits a warning.

---

## 12. Evidence ledger

`src/core/evidence/{ledger-state,ledger-storage}.ts`, `src/engine/orchestrator/evidence/{approval,persistence,reporting,retry-counts,task}.ts`, `src/core/schemas/evidence.ts`

The evidence ledger records what happened during implementation -- approval decisions, validation outcomes, task completions, skip reasons, escalation results, and rejection reasons. One ledger per session, persisted as `evidence.json` inside the session directory (`.splitbrief/sessions/<id>/evidence.json`).

The ledger schema (`EvidenceLedgerSchema`, version 1) contains: `sessionId`, `feature`, `mode`, `generatedAt`, a `tasks` array, a `validationSummary` rollup, and optional `approvals`, `rejections`, and `finalReview` fields. Each task entry tracks: `id`, `title`, `file`, `status`, `retries`, `durationMs`, `changedFiles`, a `validation` array (stage + passed + optional error summary, retry state, and `baselineExempt` — set on a failing entry whose stage was already red before any task ran and was exempted at acceptance), `expectedEvidence` (from the brief's Evidence and Tests sections), `observedEvidence` (accumulated at runtime -- "typecheck passed", "typecheck failed (pre-existing)", "diff written for X", "task reached done"), `escalated` flag, and `briefHash`.

`persistTaskEvidence` (`src/engine/orchestrator/evidence/persistence.ts`) stamps every entry with the acceptance of the attempt that produced it. A retry write carries two sets: `initialExemptStages` — the first attempt's acceptance, threaded from `task/step.ts` through `retryAndRecord` — governs the `initial-failure` entries, and `exemptStages` — `result.acceptance.exemptStages`, the retry/escalation that finally completed the task — governs the final entries. A blocking failure that drove the retry is therefore never marked `baselineExempt` or reported as "pre-existing" on the strength of the retry's verdict, and a genuinely pre-existing first-attempt failure keeps its exemption even when the retry fixed the stage. The local-done write in `task/step.ts` passes its own acceptance as `exemptStages`.

The ledger is consumed during the final review phase indirectly: `analyzeBriefDrift()` reads the ledger alongside the diff and task list to compute a drift report, and the drift report is injected into the review prompt as a `Deterministic Drift Report` section. The planner does not see the raw ledger -- it sees the drift analysis derived from it. After the review, `writeReviewPacket()` writes a combined packet for export consumers.

---

## 13. RPC protocol

`src/cli/rpc/`

Activated via `splitbrief start --rpc`. The workflow runs headlessly with a machine-readable command interface over stdin/stdout. Both directions use newline-delimited JSON -- one object per line.

**Client commands** (stdin). Validated against `RpcCommandSchema` in `src/cli/rpc/types.ts`. The command types:

| `type` | Fields | What it does |
|---|---|---|
| `approve` | optional `confirmationPhrase`, `confirmationReason` | Resolves a pending approval gate (spec, plan, briefs). For confirm-tier approvals, the client must supply a valid confirmation phrase and reason. |
| `reject` | -- | Terminally rejects a pending approval gate without feedback |
| `regenerate` | `comment` (required) | Rejects a pending approval gate with feedback so the planner can regenerate |
| `brief_review` | `command`, optional `id`, `operationId`, `promptId` | Prompt-scoped Task Brief review command. `command.action` is `approve`, `reject`, `revise`, `external_edit_applied`, `save_draft`, or `status`. Settling commands require a pending briefs prompt; `status` reports the current prompt; `save_draft` re-reads the active `tasks.md`, updates draft quality/state, and leaves the prompt pending. |
| `message` | `text` | Sends a user message -- resolves a pending message gate, or queues for the next planner drain |
| `recovery` | `action` | Picks a recovery action (retry, skip, abort, etc.) |
| `status` | -- | Requests current workflow state |
| `abort` | -- | Aborts the workflow |
| `slash` | `command` | Executes a runtime command by slash name (e.g. `/mode quick`, `/queue clear`) |

**Server responses** (stdout). Each response has a `type` field: `ack` (command accepted, with optional `command` and `data`), `error` (with `error` message), `status` (current workflow state in `data`), or `event` (a forwarded `EngineEvent`).

**How gates work.** When the engine hits an approval callback (`onApprovalNeeded`), it publishes a status event and blocks. The client sees the status, sends legacy `approve` / `reject` / `regenerate`, or sends `brief_review` for Task Brief prompts. The dispatch handler (`src/cli/rpc/dispatch.ts`) resolves the gate's promise for settling commands and acks. Non-settling `brief_review` commands report status or save draft state while keeping the prompt open. If no matching gate is pending, the command returns an error. Message gates work the same way -- if no gate is pending, the message goes to the queue instead.

**Difference from `--json`.** Both are headless. `--json` auto-approves workflow review gates and streams events to stdout -- it's observe-only; file-write tiered approvals still follow approval config and can fail closed. `--rpc` keeps gates interactive -- the client must explicitly approve or reject. Use `--json` for CI pipelines that just want to watch. Use `--rpc` for programmatic clients that need to make decisions.

---

## 14. Session directory lifecycle

`src/core/sessions/prepare.ts`, `src/core/sessions/ownership-marker.ts`, `src/core/sessions/detached-handoff.ts`, `src/core/sessions/active-pointer.ts`, `src/core/sessions/liveness.ts`, `src/core/sessions/session-id.ts`, `src/core/sessions/orphans.ts`, `src/engine/orchestrator/run/orphan-reaper.ts`

**Creation.** `prepareNewSession` (`src/core/sessions/prepare.ts`) allocates `.splitbrief/sessions/<id>/` under the project mutation lock, writes a private ownership marker (`.prepare-owner.json`) proving dev/ino identity plus a session generation, and finally publishes `.splitbrief/active` with a v1 receipt (or a legacy plain session id on older paths). Nothing is ever created outside these steps.

**Rollback.** `rollbackPreparedSession` reclaims the directory before `readiness.json` lands: it re-verifies the ownership proof, renames the directory into a quarantine claim name, asserts the canonical path was not recreated, then removes it. `removeAllocatedDirectory` is the same safe-delete template for the allocation path. All of it runs inside the mutation lock.

**Ownership release.** `releasePreparedSession` removes only the ownership marker, leaving the session directory and its artifacts in place. From that moment the directory is no longer protected by preparation.

**What an orphan is.** A session directory that holds nothing but `readiness.json` (or is completely empty) is collectable. It is what an abort or crash after readiness lands leaves behind -- preparation never cleans up after ownership is released, and no command acted on such directories. They are neither live sessions (a run that reached the workflow wrote a lockfile first) nor active ones (a run that has not is the active session).

**The four recognition guards.** A directory is collectable only when **all** hold: (1) it is a directory with a valid session id (quarantine claim names are not valid session ids, so they are never collected); (2) its entries are nothing at all or exactly `readiness.json` as a regular file -- an allowlist, so a future artifact name cannot silently become collectable; (3) it is not the directory the active record names, for both record shapes (a legacy plain session id and a v1 receipt); (4) it is older than the 24-hour grace period (`ORPHAN_SESSION_GRACE_MS`). `discardOrphanSessionDirectory` performs the safe delete under the mutation lock with the same claim/re-verify/assert-not-recreated sequence as rollback, and restores the directory instead when it gains a file between the scan and the claim.

**Where the sweep runs.** `pruneOrphanSessions` (`src/core/sessions/orphans.ts`) sweeps the collectable directories at run start, immediately after the process orphan reaper (`src/engine/orchestrator/run/orphan-reaper.ts`), mirroring its outer catch so an unreadable sessions root cannot abort the workflow. The explicit collection entry point is `splitbrief ps --prune` (see `docs/CLI-REFERENCE.md`), which collects before listing and reports each removed directory. `ps` itself omits directories holding no lockfile, no `state.json` and no `summary.json`; that set is not identical to the collectable set — a directory holding only `tasks.md` is hidden from `ps` yet not collectable, because the allowlist admits only `readiness.json`.

**Prevention half.** `splitbrief spec` is the one path that would otherwise hold an unguarded window: it never writes a lockfile or `state.json`, so a directory released before the planner call would sit as a plain orphan for the whole planning run. `spec` therefore keeps preparation ownership across the planner call — released only after planning resolves, rolled back (directory removed, active pointer cleared) when the call fails. T036's sweep is the collection half for everything that still lands on disk.
