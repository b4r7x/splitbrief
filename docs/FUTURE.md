# SPLITBRIEF — Future Work

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

**Why we want it.** File-level run accept/reject now exists through `/run accept` and `/run reject confirm`, using hash-guarded snapshots. A future git-backed variant could additionally manage optional commit history for workflows whose human owner explicitly opts into git commits.

**What it would look like.**

- During the run, commits happen only when commit strategy explicitly enables them.
- At end-of-run or on user request, a git-backed reject could squash-delete the session's commits from branch history after the file-level safety check passes.
- Accept would keep the current branch history.

**Why deferred.**

- Git semantics here are dangerous if the user has pushed generated commits. Need careful UX to detect pushed state and refuse revert.
- Escalation must not depend on commits. Snapshot-revert has to preserve evidence, diffs, and task artifacts even when `git.commitStrategy` is `none`.
- Non-git projects (we don't support them today, but might) can't use git stash; would need file-copy fallback.

**Where to start when we do it.**

- Build on the existing `/run accept` / `/run reject confirm` command path.
- Extend `summary.json` with `snapshot: { method: 'stash' | 'copy', ref: string }`.

---

## **[Could]** Token-aware transcript compaction

**Why we want it.** `session.jsonl` grows without bound over a session's lifetime. Long sessions with many regenerations, clarifications, and aborts can produce hundreds of KB of message content. On resume, rebuilding context from a 500KB transcript and feeding it into a planner that has an 8K or 32K context window won't fit.

**Current baseline.** Resume-time auto-compaction is available when `workflow.compactionThreshold` is set. It asks planners with `supportsSelfSummarisation` to summarize older turns, append a summary entry to `session.jsonl`, and let resume rebuild context from the latest summary plus recent messages.

**What remains.**

- Token-count thresholds based on backend context windows instead of message count.
- A separate recent-message retention knob.
- UI feedback when auto-compaction runs during resume.

**Why deferred.**

- Resume-time message-count compaction covers deliberate long-session cleanup.
- Token-counting thresholds need to respect backend-specific context limits.
- Queue-drain compaction must not surprise users during active planner turns.

**Where to start when we do it.**

- Add `workflow.compactionKeepRecentCount`.
- Hook compaction checks into safe queue-drain boundaries.
- Emit a compact `transcript_compacted` event when auto-compaction runs.

---

## **[Could]** Session browser UI

**Current baseline.** The `/sessions` runtime command opens an in-TUI picker (`SessionsPicker`, `src/app/overlays/sessions.tsx`) that lists past sessions, filters by feature, and resumes or views the selected one on Enter. The home screen also shows a recent-sessions list. Each `.splitbrief/sessions/<id>/` folder is self-contained with a `summary.json` at a glance.

**What remains.**

- A standalone `splitbrief sessions` CLI command (the picker only exists inside the running TUI today).
- Read-only replay mode that scrolls through `session.jsonl` rendered the way the live TUI renders events.
- `splitbrief sessions delete <id>` to remove a session folder with confirmation.

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
- `.splitbrief/active` as a text file vs. a file lock differs in concurrency guarantees across platforms.

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

## Hook system v2 (mixed)

Follow-ups from the workflow hook system — see [HOOKS-CONFIG.md §Design decisions](./HOOKS-CONFIG.md#design-decisions). Today the system ships command-kind hooks and `.splitbrief/hooks/` discovery.

- **[Could] Async fan-out within a single event.** Today hooks run sequentially in declaration order (order matters for `modify` patches). Opt-in parallel execution for events where ordering is irrelevant (`post_*`, `on_*`), with timeout aggregation and an explicit `parallel: true` flag on the entry.

---

## Repo-map v2 (mixed)

Follow-ups from the repo-map subsystem — see [REPOMAP.md §Design decisions](./REPOMAP.md#design-decisions). It supports multiple tree-sitter grammars plus PageRank; these are the axes along which it will grow.

- **[Won't] Embeddings-based retrieval.** Optional `codebase.kind: 'embeddings'` with a pluggable provider (Voyage, OpenAI, a local embedding model). Semantically richer than symbol matching; deferred because of per-call cost, index-sync work, and the cost/latency profile for local-only users. The symbol-graph path stays the default.
- ~~**[Should] Non-TypeScript language support.** Python, Go, Rust via their respective tree-sitter grammars. Each language needs its own `tags.scm`-equivalent extractor and a validator pipeline fit for the language.~~ ✅ Done
- **[Should] Grammar version bumps.** Procedure to increment the `parse_version` column in `.splitbrief/repomap.sqlite` and force a global cache rebuild when the tree-sitter grammar changes. Today bumping the compiled-in constant invalidates every row on the next planning run, but a migration note in release notes and an automatic bump on install is cleaner.
