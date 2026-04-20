# diptych — Future Work

Scope that is **deliberately deferred** from v1. These ideas have been discussed, have concrete shape, and will likely be built — but not yet. Keeping them here avoids cluttering `docs/WORKFLOW.md` Part 2 ("still open") with things that are just "not now" rather than "not decided".

Each entry has:
- Why we want it
- What it would look like
- Why it's deferred
- Rough pointer to where implementation would start

---

## Priority legend

Items below are labeled using MoSCoW:

- **Must** — core gap; v1 is incomplete without this.
- **Should** — high value; next major cycle.
- **Could** — nice-to-have; low priority.
- **Won't-v1** — deferred to v2 or beyond; consciously out-of-scope.

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

- Our phase-based workflow already provides coarse rewind via approval-gate rejection (`REJECT_SPEC` / `REJECT_PLAN`) and the v1 soft rewind commands (`/revise-spec`, `/revise-plan`, `/redo-task`). That covers 90% of cases.
- Full rewind requires versioning every artifact at every rewind-able point, which roughly doubles disk footprint for a session.
- UI complexity is non-trivial: picker, preview of which artifacts will change, confirmation.
- Git commits complicate things: if tasks were already committed (and maybe pushed), rewind can't silently un-commit.

**Where to start when we do it.**

- Add `snapshots/` subfolder inside `sessions/<id>/` to hold versioned `state.json` / artifact copies per user-turn.
- Extend `session.jsonl` with `rewindPointId` markers at each user-turn.
- Reuse the `FilterableList` picker primitive for the rewind UI.

---

## **[Could]** Cursor-style per-run code snapshot undo

**Why we want it.** Cursor Composer snapshots the working-tree state at the start of each agent run and lets the user "accept" or "reject" the whole diff at the end. If rejected, the working tree reverts. This is more fine-grained than git-commit-per-task — it lets you try a whole feature and throw it away without polluting git history.

**What it would look like.**

- Before the first `implementing` phase begins (after `APPROVE_PLAN`), snapshot the working tree: either as a `git stash` tagged with the session-id, or as a file-level copy under `sessions/<id>/snapshot/`.
- During the run, every per-task commit still happens (for the granular retry/escalation behaviour we already rely on).
- At end-of-run or on user request (`/reject-run`), revert the working tree to the snapshot and squash-delete the session's commits from the branch history.
- `/accept-run` (default at session end) does nothing — commits stay.

**Why deferred.**

- Git semantics here are dangerous if the user has pushed the per-task commits. Need careful UX to detect pushed state and refuse revert.
- Our per-task commits are load-bearing for escalation (planner can see the diff of each task). Snapshot-revert has to preserve the ability to inspect individual task commits before throwing them away.
- Non-git projects (we don't support them today, but might) can't use git stash; would need file-copy fallback.

**Where to start when we do it.**

- Hook into the workflow at `APPROVE_PLAN` to take the snapshot.
- Add `/accept-run` / `/reject-run` slash commands.
- Extend `summary.json` with `snapshot: { method: 'stash' | 'copy', ref: string }`.

---

## **[Could]** Parallel sessions in the same project

**Why we want it.** Users sometimes want to run multiple diptych workflows against the same codebase at once — e.g., plan one feature while implementing another. Today this is blocked by the `.diptych/active` lock.

**What it would look like.**

The canonical solution is git worktrees: each worktree is an isolated checkout and has its own `.diptych/`. Users should use `git worktree add` to create a new branch and working directory, then run `diptych` inside the worktree. Claude Code v2.1.50+ has first-class `-w` support for this.

**Why deferred.**

- We don't need new diptych code to support this — git worktrees are the answer. What *would* be new is tooling to make worktree setup seamless (`diptych start --worktree <branch>` that creates the worktree, switches into it, and starts the workflow). That's convenience, not a capability.
- Without worktrees, truly concurrent workflows in the same directory share working-tree files and git index, which always leads to conflicts. The experience is so bad that we'd rather not offer the option.

**Where to start when we do it.**

- Add `--worktree <branch-name>` flag to `diptych start`.
- Add a `diptych worktree list` command that shows all worktrees with active diptych sessions.
- Document the workflow in `docs/CONCEPTS.md` as a "Concurrent workflows" section.

---

## **[Should]** Transcript compaction / summarisation

**Why we want it.** `session.jsonl` grows without bound over a session's lifetime. Long sessions with many regenerations, clarifications, and aborts can produce hundreds of KB of message content. On resume, rebuilding context from a 500KB transcript and feeding it into a planner that has an 8K or 32K context window won't fit.

**What it would look like.**

- `/compact-transcript` slash command (or automatic when transcript token count > threshold).
- Planner is asked to summarise older turns into a single `<!-- summary: ... -->` block.
- `session.jsonl` gets a `kind: "summary"` entry marking the compaction point.
- On subsequent transcript rebuilds, only entries after the last summary are used verbatim; earlier entries are represented by the summary.

**Why deferred.**

- v1 sessions are unlikely to hit this problem. Most feature workflows end in under 100 turns.
- Requires a new planner capability flag (`supportsSelfSummarisation`) and a standardised summary prompt.
- The summary prompt is itself a design problem: what information must be preserved?

**Where to start when we do it.**

- Add `PlannerCapabilities.supportsSelfSummarisation`.
- Add a `summarise(transcript)` method to `Planner`.
- Hook compaction check into the resume path and into `ENQUEUE_USER_MSG`.

---

## **[Could]** Session browser UI

**Why we want it.** Today there is no UI for browsing past sessions. `.diptych/sessions/` is visible in the filesystem, but discoverability is bad — summary is buried in `summary.json`, transcripts require manual file opening.

**What it would look like.**

- `diptych sessions` command opens a picker of historical sessions sorted by date.
- Selecting one shows summary + artifact preview + "replay" option.
- Replay mode scrolls through `session.jsonl` rendered the same way the live TUI renders events — read-only.
- `diptych sessions delete <id>` removes a session folder.

**Why deferred.**

- The new sessions-folder layout already gives users enough to inspect sessions by hand (each folder is self-contained, summary.json at a glance).
- UI work is not small: picker, replay renderer (we already have one, but needs to work in read-only mode), delete confirmation.

**Where to start when we do it.**

- New command at `src/cli/commands/sessions.ts`.
- Reuse `conversationFlow` and event-cards renderer in read-only mode.

---

## **[Should]** Non-TypeScript language support

**Why we want it.** Obvious: not all users are on TS projects.

**Why deferred.**

- The validator pipeline is hardcoded TS-shaped (`tsc → lint → test`).
- Prompts have TS-specific framing ("emit TypeScript with types", etc.).
- Would require a language-detection step, per-language validators, and per-language prompt variants.

No work yet. Will be a separate design effort when demand appears.

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

- Extend the `EngineEvent` union with an `injection_separator` variant (`src/engine/events/types.ts`).
- Publish it from the mid-stream dispatch path in `src/engine/orchestrator/` when a queued message is folded into a live session.
- Add a renderer in `src/components/event-cards/`.

---

## EventBus & OTel evolution (mixed)

Follow-ups from the EventBus and OpenTelemetry work — see [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus) and [OTEL.md §Design decisions](./OTEL.md#design-decisions). The bus is in; these are the rough edges that did not make v1.

- **[Should] Subprocess context propagation.** Planner and implementer spawns do not receive a `traceparent` today, so calls into Claude Code / Ollama / LM Studio appear as opaque windows inside the parent phase span. Fix: thread a W3C trace-context propagator through every runner adapter — as an environment variable for `cli` / `shell` / `agent` kinds, and as a request header for `api` kinds.
- **[Should] CLI bootstrap UX.** Pre-registering a `NodeTracerProvider` from an external wrapper is defeated by ESM's dual-resolution of `@opentelemetry/api` (absolute path vs. bare specifier → distinct module-cache entries). Fix approach: a `--otel-exporter <console|otlp-http>` CLI flag, or a `DIPTYCH_OTEL_EXPORTER` env variable read inside `src/engine/orchestrator/run/init.ts` so the provider is registered in the same resolution context the sink imports from.
- **[Could] Retry span semantics.** Today a task with two retries produces one span covering all attempts. Open question: model retries as sibling spans under a shared parent, or keep a single task span with a `diptych.task.retries` attribute. Ambiguous which users actually want — deferred until we see real trace consumption.
- **[Could] Error status propagation.** `task_failed` marks only the task span `ERROR`; parent phase and workflow stay `OK`. OTel convention varies across backends (Honeycomb vs. Tempo bubble-up behavior differs). Needs a calibration pass before codifying.
- **[Won't-v1] Logs via `@opentelemetry/api-logs`.** Structured log records with trace correlation, replacing `console.*` inside the engine. Out of scope for v1. Would land alongside a `/log` channel that exposes planner/implementer stdout as log records.
- **[Could] Metric emission.** Counters (`task_completed{method=local|escalated|full}`), histograms (phase durations), gauges (tokens remaining against budget). Derivable from spans by most backends today; a future `otel.metrics.enabled` flag could emit them natively if derived metrics prove lossy.

---

## Hook system v2 (mixed)

Follow-ups from the workflow hook system — see [HOOKS-CONFIG.md §Design decisions](./HOOKS-CONFIG.md#design-decisions). v1 ships command-kind hooks; the schema already reserves space for more.

- **[Should] JS/TS module hooks.** `kind: 'module'` with `path: './hooks/my-hook.ts'` is validated by the v1 schema but not yet invoked. Dynamic-import semantics, return-value contract, and timeout behavior need to match the command-kind dispatcher's outcome model (`{ kind: 'allow' | 'deny', message? }`).
- **[Could] Async fan-out within a single event.** Today hooks run sequentially in declaration order (order matters for `modify` patches). Opt-in parallel execution for events where ordering is irrelevant (`post_*`, `on_*`), with timeout aggregation and an explicit `parallel: true` flag on the entry.
- **[Could] Hook discovery.** Auto-detect `.diptych/hooks/*.ts` files and register them under a conventional event inferred from the filename (e.g. `pre-task.ts` → `pre_task`). Avoids configuring the obvious.

---

## Repo-map v2 (mixed)

Follow-ups from the repo-map subsystem — see [REPOMAP.md §Design decisions](./REPOMAP.md#design-decisions). v1 is TypeScript-only via tree-sitter + PageRank; these are the axes along which it will grow.

- **[Won't-v1] Embeddings-based retrieval.** Optional `codebase.kind: 'embeddings'` with a pluggable provider (Voyage, OpenAI, a local embedding model). Semantically richer than symbol matching; deferred because of per-call cost, index-sync work, and the cost/latency profile for local-only users. The symbol-graph path stays the default.
- **[Should] Non-TypeScript language support.** Python, Go, Rust via their respective tree-sitter grammars. Each language needs its own `tags.scm`-equivalent extractor and a validator pipeline fit for the language. Blocked on the separate "Non-TypeScript language support" item above.
- **[Should] Grammar version bumps.** Procedure to increment the `parse_version` column in `.diptych/repomap.sqlite` and force a global cache rebuild when the tree-sitter grammar changes. Today `/repomap rebuild` handles it per-project, but a migration note in release notes and an automatic bump on install is cleaner.
