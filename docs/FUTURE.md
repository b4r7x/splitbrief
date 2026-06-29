# diptych — Future Work

Scope that is **deliberately deferred** from the current release. These ideas have been discussed, have concrete shape, and will likely be built — but not yet. Keeping them here keeps [docs/WORKFLOW.md](./WORKFLOW.md) focused on the shipped state machine instead of things that are just "not now" rather than "not decided".

Each entry has:
- Why we want it
- What it would look like
- Why it's deferred
- Rough pointer to where implementation would start

---

## Priority legend

Items below are labeled using MoSCoW:

- **Must** — core gap; the current release is incomplete without this.
- **Should** — high value; next major cycle.
- **Could** — nice-to-have; low priority.
- **Won't** — deferred to a later cycle; consciously out-of-scope for now.

Labels are opinions, not contracts. Contributors can argue for re-labeling via PR.

---

## **[Could]** Full message-level rewind (Claude Code "double-Esc" style)

**Why we want it.** Claude Code's double-Esc lets the user pick a prior user-message from the current session and fork the conversation from there — subsequent history dropped, conversation continues from the chosen point. Useful when a mid-session wrong turn requires more than one step of undo.

**What it would look like.**

- `/rewind` slash command opens a picker showing every `kind: "message", role: "user"` entry in `session.jsonl` with its phase and timestamp.
- User selects an entry.
- All subsequent entries in `session.jsonl` are marked `rewound: true` (soft delete; we don't physically truncate the file because we want the audit trail).
- `state.json` is restored to a snapshot captured at the chosen point.
- Artifact files (`spec.md`, `plan.md`, `tasks.md`) are restored from snapshots.
- Planner's backend session (where applicable) is forked: for Claude Code, we spawn a new child session from the chosen turn; for stateless backends, we rebuild messages up to the chosen point only.

**Why deferred.**

- Our phase-based workflow already provides coarse rewind via approval-gate rejection (`REJECT_SPEC` / `REJECT_PLAN`) and the shipped soft rewind commands (`/revise-spec`, `/revise-plan`, `/redo-task`). That covers 90% of cases.
- Full rewind requires versioning every artifact at every rewind-able point, which roughly doubles disk footprint for a session.
- UI complexity is non-trivial: picker, preview of which artifacts will change, confirmation.
- Git commits complicate things: if tasks were already committed (and maybe pushed), rewind can't silently un-commit.

**Where to start when we do it.**

- Add `snapshots/` subfolder inside `sessions/<id>/` to hold versioned `state.json` / artifact copies per user-turn.
- Extend `session.jsonl` with `rewindPointId` markers at each user-turn.
- Reuse the `FilterableList` picker primitive for the rewind UI.

---

## **[Could]** Git-backed per-run code snapshot undo

**Why we want it.** File-level run accept/reject now exists through `/accept-run` and `/reject-run confirm`, using hash-guarded snapshots. A future git-backed variant could additionally manage optional commit history for workflows whose human owner explicitly opts into git commits.

**What it would look like.**

- During the run, commits happen only when commit strategy explicitly enables them.
- At end-of-run or on user request, a git-backed reject could squash-delete the session's commits from branch history after the file-level safety check passes.
- Accept would keep the current branch history.

**Why deferred.**

- Git semantics here are dangerous if the user has pushed generated commits. Need careful UX to detect pushed state and refuse revert.
- Escalation must not depend on commits. Snapshot-revert has to preserve evidence, diffs, and task artifacts even when `git.commitStrategy` is `none`.
- Non-git projects (we don't support them today, but might) can't use git stash; would need file-copy fallback.

**Where to start when we do it.**

- Build on the existing `/accept-run` / `/reject-run confirm` command path.
- Extend `summary.json` with `snapshot: { method: 'stash' | 'copy', ref: string }`.

---

## ~~**[Could]** Parallel sessions in the same project~~ ✅ Done

**Why we wanted it.** Users sometimes want to run multiple diptych workflows against the same codebase at once — e.g., plan one feature while implementing another. The `.diptych/active` lock blocks concurrent runs in a single working tree.

**What was built.**

- `diptych start --worktree <name>` creates `.trees/<name>` on branch `diptych/<name>`, selects it as the run's project root, and starts the workflow there (`--worktree [name]` flag in `src/cli/options.ts`).
- `diptych worktree list` shows every diptych-managed worktree with its branch, status, session, and phase; `diptych worktree switch <name>` prints the shell instructions to enter it, and `diptych worktree remove <name>` tears one down with live-session and dirty-tree guards (`src/cli/commands/worktree.ts`).
- Each worktree gets its own isolated `.diptych/` (sessions, active pointer, snapshots, ledger), with config and hooks copied from the base checkout.
- Full workflow and isolation caveats are documented in [WORKTREES.md](./WORKTREES.md).

**Remaining.** Per-worktree environment isolation (ports, databases) is still the user's responsibility — see the mitigation recipes in WORKTREES.md.

---

## **[Could]** Token-aware transcript compaction

**Why we want it.** `session.jsonl` grows without bound over a session's lifetime. Long sessions with many regenerations, clarifications, and aborts can produce hundreds of KB of message content. On resume, rebuilding context from a 500KB transcript and feeding it into a planner that has an 8K or 32K context window won't fit.

**Current baseline.** Manual compaction exists through `/compact-transcript`. Resume-time auto-compaction is available when `workflow.compactionThreshold` is set. Both paths ask planners with `supportsSelfSummarisation` to summarize older turns, append a summary entry to `session.jsonl`, and let resume rebuild context from the latest summary plus recent messages.

**What remains.**

- Token-count thresholds based on backend context windows instead of message count.
- A separate recent-message retention knob.
- UI feedback when auto-compaction runs during resume.

**Why deferred.**

- Manual compaction and resume-time message-count compaction cover deliberate long-session cleanup.
- Token-counting thresholds need to respect backend-specific context limits.
- Queue-drain compaction must not surprise users during active planner turns.

**Where to start when we do it.**

- Add `workflow.compactionKeepRecentCount`.
- Hook compaction checks into safe queue-drain boundaries.
- Emit a compact `transcript_compacted` event when auto-compaction runs.

---

## **[Could]** Session browser UI

**Current baseline.** The `/sessions` runtime command opens an in-TUI picker (`SessionsPicker`, `src/app/overlays/sessions.tsx`) that lists past sessions, filters by feature, and resumes or views the selected one on Enter. The home screen also shows a recent-sessions list. Each `.diptych/sessions/<id>/` folder is self-contained with a `summary.json` at a glance.

**What remains.**

- A standalone `diptych sessions` CLI command (the picker only exists inside the running TUI today).
- Read-only replay mode that scrolls through `session.jsonl` rendered the way the live TUI renders events.
- `diptych sessions delete <id>` to remove a session folder with confirmation.

**Why deferred.**

- The in-TUI picker plus the self-contained folder layout already cover inspecting and resuming sessions.
- Replay needs the event-cards renderer to work in a read-only mode, and delete needs confirmation UX.

**Where to start when we do it.**

- New command at `src/cli/commands/sessions.ts`.
- Reuse `ConversationFlow` and the event-cards renderer in read-only mode.

---

## ~~**[Should]** Non-TypeScript language support~~ ✅ Done

**Why we want it.** Obvious: not all users are on TS projects.

**What was built.**

- The validator pipeline is now polyglot: it resolves commands from 4 layers — user config > planner-discovered > heuristic fallback > graceful skip.
- Heuristic detection reads project marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`, `package.json`) to infer language and validation tools.
- The research prompt asks the planner to identify the project's validation toolchain, which is persisted to `WorkflowState.discoveredValidation`.
- Planner and implementer prompts are language-aware: TypeScript keeps ESM-with-`.js` guidance, while Python, Go, Rust, JavaScript, and generic contexts avoid TypeScript-specific wording.
- Missing commands at any layer silently skip the stage instead of erroring.
- Default TS projects (`package.json` with `typescript` devDependency) preserve identical behavior to before.

**Remaining.** Deeper language-specific planning heuristics can still be added as usage patterns emerge.

---

## **[Could]** Windows support

**Why we want it.** Many devs still use Windows.

**Why deferred.**

- Not tested on Windows at all.
- Subprocess handling is POSIX-ish (SIGTERM/SIGKILL). Windows uses different signal semantics.
- `.diptych/active` as a text file vs. a file lock differs in concurrency guarantees across platforms.

Testing + CI on Windows would come first, before any behavioural fixes.

---

## **[Could]** Mid-stream injection UX on Claude Code

**Why we want it.** When the user queues a message and it is injected as a native turn into the live planner session, Claude's response may arrive *while* we are still streaming the prior turn. The TUI needs a clear visual separator to make this readable.

**What it would look like.**

A distinct "user interjected →" marker in the conversation flow, followed by the planner's new response chunk, clearly delineated from the prior partial stream — a hairline divider with a label ("you said:") before the injected message and another ("planner continued:") before the resumed output.

**Why deferred.**

Not yet designed. The interaction semantics are clear (see `docs/WORKFLOW.md` §1.7), but the visual treatment requires iteration with real usage data — the exact timing of Claude's response arrival vs. the TUI render cycle is non-deterministic and backend-dependent.

**Where to start when we do it.**

- Extend the `EngineEventSchema` union with an `injection_separator` variant (`src/engine/events/schema.ts`).
- Publish it from the mid-stream dispatch path in `src/engine/orchestrator/` when a queued message is folded into a live session.
- Add a renderer in `src/features/workflow/components/event-cards/`.

---

## EventBus & OTel evolution (mixed)

Follow-ups from the EventBus and OpenTelemetry work — see [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus) and [OTEL.md §Design decisions](./OTEL.md#design-decisions). The bus is in; these are the rough edges that did not make the current release.

- **[Should] Subprocess context propagation.** Planner and implementer spawns do not receive a `traceparent` today, so calls into Claude Code / Ollama / LM Studio appear as opaque windows inside the parent phase span. Fix: thread a W3C trace-context propagator through every runner adapter — as an environment variable for `cli` / `shell` / `agent` kinds, and as a request header for `api` kinds.
- **[Should] CLI bootstrap UX.** Pre-registering a `NodeTracerProvider` from an external wrapper is defeated by ESM's dual-resolution of `@opentelemetry/api` (absolute path vs. bare specifier → distinct module-cache entries). Fix approach: a `--otel-exporter <console|otlp-http>` CLI flag, or a `DIPTYCH_OTEL_EXPORTER` env variable read inside `src/engine/orchestrator/run/init.ts` so the provider is registered in the same resolution context the sink imports from.
- **[Could] Retry span semantics.** Today a task with two retries produces one span covering all attempts. Open question: model retries as sibling spans under a shared parent, or keep a single task span with a `diptych.task.retries` attribute. Ambiguous which users actually want — deferred until we see real trace consumption.
- **[Could] Error status propagation.** `task_full_fail` marks only the task span `ERROR`; parent phase and workflow stay `OK`. OTel convention varies across backends (Honeycomb vs. Tempo bubble-up behavior differs). Needs a calibration pass before codifying.
- **[Won't] Logs via `@opentelemetry/api-logs`.** Structured log records with trace correlation, replacing `console.*` inside the engine. Out of scope for now. Would land alongside a `/log` channel that exposes planner/implementer stdout as log records.
- **[Could] Metric emission.** Counters (`task_completed{method=local|escalated|escalated-full}`), histograms (phase durations), gauges (tokens remaining against budget). Derivable from spans by most backends today; a future `otel.metrics.enabled` flag could emit them natively if derived metrics prove lossy.

---

## Hook system v2 (mixed)

Follow-ups from the workflow hook system — see [HOOKS-CONFIG.md §Design decisions](./HOOKS-CONFIG.md#design-decisions). Today the system ships command-kind hooks, JS/TS module hooks, and `.diptych/hooks/` discovery.

- **[Could] Async fan-out within a single event.** Today hooks run sequentially in declaration order (order matters for `modify` patches). Opt-in parallel execution for events where ordering is irrelevant (`post_*`, `on_*`), with timeout aggregation and an explicit `parallel: true` flag on the entry.

---

## Repo-map v2 (mixed)

Follow-ups from the repo-map subsystem — see [REPOMAP.md §Design decisions](./REPOMAP.md#design-decisions). It supports multiple tree-sitter grammars plus PageRank; these are the axes along which it will grow.

- **[Won't] Embeddings-based retrieval.** Optional `codebase.kind: 'embeddings'` with a pluggable provider (Voyage, OpenAI, a local embedding model). Semantically richer than symbol matching; deferred because of per-call cost, index-sync work, and the cost/latency profile for local-only users. The symbol-graph path stays the default.
- ~~**[Should] Non-TypeScript language support.** Python, Go, Rust via their respective tree-sitter grammars. Each language needs its own `tags.scm`-equivalent extractor and a validator pipeline fit for the language.~~ ✅ Done
- **[Should] Grammar version bumps.** Procedure to increment the `parse_version` column in `.diptych/repomap.sqlite` and force a global cache rebuild when the tree-sitter grammar changes. Today `/repomap rebuild` handles it per-project, but a migration note in release notes and an automatic bump on install is cleaner.
