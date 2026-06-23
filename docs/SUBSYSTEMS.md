# diptych — Supporting subsystems

These subsystems sit outside the core workflow loop but are essential to the full system. Each section explains what it does, where the code lives, and how to use it. For the core workflow, see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md). For the engine and EventBus, see [ENGINE.md](./ENGINE.md). For approval and recovery, see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

## 1. Workflow hooks

`src/engine/hooks/`

User-declared commands that fire on workflow events. Configured in the `hooks` section of the diptych config file, or auto-discovered from `.diptych/hooks/` as ES module files named by event (e.g. `pre-task.ts`, `post-commit.js`). Discovery and merge logic lives in `src/engine/hooks/discover.ts`.

**Pre-hooks** (`pre_planning`, `pre_task`, `pre_validation`, `pre_commit`, `pre_escalation`) run synchronously before the action. If a hook exits non-zero or returns `{ kind: 'deny' }`, the action is blocked. Dispatched at the orchestrator call site via `src/engine/hooks/run-pre.ts`, which also runs active built-in hooks before user entries. `pre_compact` is a reserved event key — it is config-validated but has no dispatch site yet (see `docs/HOOKS-CONFIG.md`).

**Post-hooks and on-hooks** (`post_task`, `post_validation`, `post_commit`, `on_complete`, `on_error`) fire asynchronously after the action through the hook sink on the EventBus (`src/engine/hooks/sink.ts`). A deny outcome from a post-hook is informational only -- it cannot block the already-completed action.

Hooks support two kinds: `command` (spawns a subprocess, receives the event as JSON on stdin) and `module` (loads an ES module exporting a handler function). Variable substitution in command args uses `${event.<path>}` syntax -- for example `${event.taskId}`, `${event.phase}`. Resolved by `src/engine/hooks/substitute.ts`. Each hook entry declares an `on_failure` policy: `block`, `warn`, or `ignore`.

**Trust model:** hooks must be trusted before first execution. `src/core/hooks/trust.ts` computes a SHA-256 hash of the hooks config and stores it in `.diptych/hook-trust.json`. If the config changes, the user is prompted to re-trust. Deep-dive: `docs/HOOKS-CONFIG.md`.

---

## 2. Snapshots

`src/engine/snapshots/`

Content-addressed working-tree snapshots stored under `.diptych/sessions/<id>/snapshots/`. The snapshot store handles creation (`src/engine/snapshots/create.ts`), manifest management (`src/engine/snapshots/manifest.ts`), and file collection (`src/engine/snapshots/files.ts`). Restore logic lives in `src/engine/snapshots/restore.ts`. Run-level accept/reject logic lives in `src/engine/snapshots/run.ts`.

The first snapshot creates the **baseline snapshot** -- the "before" state. It stores every tracked file (excluding `.git`, `.diptych`, `node_modules`, `.trees`). Subsequent snapshots store only files whose hash differs from the baseline, with the manifest recording every file's hash. File blobs are stored under hex-encoded path names within each snapshot directory.

Auto-snapshot triggers fire at `preTask`, `postTask`, and `preFinalReview` phases. Manual snapshots are available via `diptych snapshot create`. The run ledger (`run-ledger.json`) tracks which snapshots belong to the current run so that `/accept-run` and `/reject-run confirm` operate on the correct state. Rejection restores baseline files, deletes files that were created during the run, and reports conflicts where the working tree diverged from both baseline and snapshot. Events: `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`.

---

## 3. IPC and attach/detach

`src/engine/ipc/`

`diptych start --detach` spawns a background server process (`src/engine/ipc/spawn-server.ts` -> `src/engine/ipc/server-entry.ts`). The server runs the workflow headlessly and exposes a Unix domain socket at `.diptych/sessions/<id>/ipc.sock`. The IPC protocol (`src/engine/ipc/protocol.ts`) defines `ServerMessage` and `ClientMessage` types over newline-delimited JSON.

`diptych attach <session-id>` connects a TUI client to the socket. On connect, the server sends `session_meta`, replays historical events from the session JSONL log (`src/engine/ipc/replay.ts`), then streams live events. The client sends user input and prompt responses back to the server. Only one client can attach at a time -- a second connection enters a control-channel grace window where it can send `{kind:'detach'}` to steal the session, or gets rejected with `already_attached`. When the session is stolen, the server sends the displaced client a terminal `already_attached` error frame before destroying its socket, so the displaced client stops (does not reconnect) instead of treating the close as a transient drop.

`diptych ps` lists active IPC sockets. `diptych detach` (or sending a `detach` message) disconnects the client without stopping the server. If the server process dies, crash diagnostics are built from the lockfile and server log tail (`src/engine/ipc/crash-diagnostic.ts`), showing a post-mortem with PID, timestamps, exit code, signal, and the last log lines. Events: `ipc_server_started`, `ipc_client_attached`, `ipc_client_detached`.

---

## 4. Repo-map

`src/engine/codebase/`

Token-budgeted codebase summary fed to every planner call. `src/engine/codebase/repomap.ts` is the entry point: `buildRepoMap(projectDir, opts)`.

The pipeline: discover source files -> parse them with tree-sitter (`src/engine/codebase/parse.ts`, grammars for TypeScript, JavaScript, Python, Go, Rust via `src/engine/codebase/languages.ts`) -> build an import graph from symbols and references (`src/engine/codebase/graph.ts`) -> score with PageRank (`src/engine/codebase/pagerank.ts`, files imported by many others rank higher, explicit focus files get a rank boost) -> trim to fit the token budget (`src/engine/codebase/budget.ts`). Feature text is scanned for mentioned filenames (`src/engine/codebase/extract-mentioned-filenames.ts`) which get added to focus files.

Parse results are cached in SQLite at `.diptych/repomap.sqlite` via `src/engine/codebase/cache.ts`. The `/repomap rebuild` slash command clears the cache. Default budget is 4000 tokens. Deep-dive: `docs/REPOMAP.md`.

---

## 5. Handoff

`src/engine/handoff/`

Export compiled briefs to formats other agents consume. `src/engine/handoff/render.ts` dispatches to built-in renderers based on the target:

- `spec-kit` -- `src/engine/handoff/renderers/spec-kit.ts`
- `agents-md` -- `src/engine/handoff/renderers/agents-md.ts`
- `claude-code` -- `src/engine/handoff/renderers/claude-code.ts`
- `copilot-issue` -- `src/engine/handoff/renderers/copilot-issue.ts`

Custom renderers are loaded from runtime-loadable `.diptych/handoff-renderers/<target>.ts` or `.js` files via `src/engine/handoff/load-renderer.ts`. A handoff manifest with metadata (session ID, brief hash, source commit, task IDs, artifact paths) is written alongside the pack (`src/engine/handoff/manifest.ts`). Custom targets are supported by the `diptych handoff <target>` CLI; `/handoff` currently validates against built-in `HANDOFF_TARGETS`.

---

## 6. MCP server

`src/engine/mcp/`

Exposes session artifacts as MCP resources for external clients. Started via `diptych mcp serve`. The HTTP server (`src/engine/mcp/server.ts`) implements Streamable HTTP MCP (protocol version `2025-11-25`), with bearer token auth and local-origin CORS enforcement.

The resolver (`src/engine/mcp/resolver.ts`) serves the sessions index at `mcp://diptych/sessions` and per-session resources under `mcp://diptych/sessions/<id>/`: manifest, spec, plan, tasks (list and individual briefs), evidence ledger, drift report, workflow state, and summary. All resources are read from the session directory on disk.

The server optionally exposes MCP tools when a tool handler is provided (`src/engine/mcp/tool/`). The tools mutate the evidence ledger: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. Input validation uses Zod schemas (`src/engine/mcp/tool/schemas.ts`). These tools let external agents report work back into a diptych session.

---

## 7. Git worktrees

`src/engine/worktree.ts` + `src/cli/commands/worktree.ts`

`diptych worktree list | switch | remove` manages isolated working directories under `.trees/<name>/`. `diptych start --worktree "feature"` creates a worktree on branch `diptych/<name>` and runs the session inside it. Each worktree gets its own `.diptych/` directory and therefore its own session lock, enabling parallel workflows on the same repo.

Worktree names are validated against a strict whitelist (`[A-Za-z0-9_][A-Za-z0-9._-]{0,63}`). Creation refuses to proceed if the source working tree is dirty. Removal checks for live sessions and uncommitted changes, requiring `--force` to bypass. The optional `--delete-branch` flag removes the `diptych/<name>` branch after worktree removal. `detectWorktree()` determines whether the current project directory is inside a diptych-managed worktree by comparing `git rev-parse --git-dir` and `--git-common-dir`.

---

## 8. Runtime commands

`src/core/runtime/commands/`

User-facing commands typed as `/name args` in the composer. Registered in `src/core/runtime/commands/registry.ts` via `createRuntimeCommands(ctx)`, which takes a `RuntimeCommandContext` providing access to navigation, overlays, detection, rewind, handoff, snapshots, and other capabilities.

Each command declares: `name`, optional `aliases`, a `kind` discriminant (`noarg` or `arg`), `handler`, `validScreens` (which screens the command can run on), optional `phaseGuard` (function that checks whether the current workflow phase allows execution), and optional `label` and `shortcut`. Commands with a `label` appear in the command palette (Ctrl-K).

Dispatch (`src/core/runtime/commands/dispatch.ts`): parse the raw input, split name from args, look up the command via fuzzy matching (`src/core/runtime/commands/lookup.ts`), validate screen and phase guards, then execute the handler. Errors are surfaced through the `onError` callback. Full reference: `docs/SLASH-COMMANDS-REFERENCE.md`.

---

## 9. Session export

`src/engine/export/`

Export a session's outcomes as a self-contained HTML report. Triggered via `/export` slash command or `diptych export` CLI.

`src/engine/export/collect.ts` gathers export data from the session directory: summary, evidence ledger, drift report, and brief quality report. `src/engine/export/html-renderer.ts` renders this into a single HTML file with inline CSS -- dark-theme, monospace, no external dependencies. The report includes: header with feature name and session ID, cost savings breakdown, metadata (planner, implementer, mode, total time), task summary with outcome badges, evidence and drift scores, and phase timing bars. Output goes to `<session-dir>/report.html`.

---

## 10. Detection

`src/engine/detection/`

Auto-detect available planner and implementer tools on startup. `src/engine/detection/detect.ts` probes CLI tools (claude-code, codex, aider, copilot, opencode, kilo-code) by spawning them and checking `isAvailable()` + `getVersion()`, checks API providers for valid keys or reachable endpoints, and always includes the `shell` planner as available.

Results are cached in `.diptych/detection-cache.json` with a 5-minute TTL (`src/engine/detection/cache.ts`). The detection service (`src/engine/detection/service.ts`) coordinates cache loading, persistence, and refresh. It also fetches the models-dev catalog (provider model lists) and discovers CLI tool model capabilities in parallel.

The `/refresh` slash command invalidates the cache and re-runs detection. Detection results feed the planner picker and implementer picker overlays in the TUI.

---

## 11. Session compaction

`src/core/sessions/compaction.ts`, `src/engine/orchestrator/transcript-rebuild.ts`, `src/engine/orchestrator/resume-context.ts`

Compaction summarizes older turns in `session.jsonl` without deleting them. A summary entry is appended to the log; original messages remain intact. On resume, `readCompactedMessages()` returns the latest summary entry plus only the messages after its `summarizedUpTo` timestamp -- the planner rebuilds context from that smaller window instead of replaying the full log.

**Auto-compaction** fires during `autoCompactResumeContext()` when the planner supports self-summarization (`supportsSelfSummarisation` capability) and the message count exceeds `workflow.compactionThreshold`. The threshold is an integer minimum of 10, set in config. If the threshold is unset or the planner lacks the capability, auto-compaction is skipped. **Manual compaction** is triggered via `/compact-transcript`, which creates a planner instance and calls `performManualCompaction()`. If the planner does not support summarization, the command returns `unsupported`.

**Two formats.** `workflow.compactionFormat` controls the output shape. When set to `auto` (the default), the format is selected by planner kind: `api` and `agent-sdk` use `structured`, everything else uses `freeform`. Freeform summaries are plain text. Structured summaries are JSON objects with fields: `goal`, `stepsCompleted`, `currentStep`, `filesModified`, `constraintsDiscovered`, `remainingWork`. If a structured summarization call returns invalid JSON, the system falls back to freeform and emits a warning.

---

## 12. Evidence ledger

`src/core/evidence/ledger.ts`, `src/engine/orchestrator/evidence/{approval,persistence,reporting,retry-counts,task}.ts`, `src/core/schemas/evidence.ts`

The evidence ledger records what happened during implementation -- approval decisions, validation outcomes, task completions, skip reasons, escalation results, and rejection reasons. One ledger per session, persisted as `evidence.json` inside the session directory (`.diptych/sessions/<id>/evidence.json`).

The ledger schema (`EvidenceLedgerSchema`, version 1) contains: `sessionId`, `feature`, `mode`, `generatedAt`, a `tasks` array, a `validationSummary` rollup, and optional `approvals`, `rejections`, and `finalReview` fields. Each task entry tracks: `id`, `title`, `file`, `status`, `retries`, `durationMs`, `changedFiles`, a `validation` array (stage + passed + optional error summary and retry state), `expectedEvidence` (from the brief's Evidence and Tests sections), `observedEvidence` (accumulated at runtime -- "typecheck passed", "diff written for X", "task reached done"), `escalated` flag, and `briefHash`.

The ledger is consumed during the final review phase indirectly: `analyzeBriefDrift()` reads the ledger alongside the diff and task list to compute a drift report, and the drift report is injected into the review prompt as a `Deterministic Drift Report` section. The planner does not see the raw ledger -- it sees the drift analysis derived from it. After the review, `writeReviewPacket()` writes a combined packet for export consumers.

---

## 13. RPC protocol

`src/cli/rpc/`

Activated via `diptych start --rpc`. The workflow runs headlessly with a machine-readable command interface over stdin/stdout. Both directions use newline-delimited JSON -- one object per line.

**Client commands** (stdin). Validated against `RpcCommandSchema` in `src/cli/rpc/types.ts`. Nine command types:

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
