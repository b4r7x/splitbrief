# SPLITBRIEF — Future Work

Scope that is **deliberately deferred** from the current release. These ideas have been discussed, have concrete shape, and will likely be built — but not yet. Keeping them here keeps [docs/WORKFLOW.md](./WORKFLOW.md) focused on the shipped state machine instead of things that are just "not now" rather than "not decided".

Each entry has:
- Why we want it
- What it would look like
- Why it's deferred
- Rough pointer to where implementation would start

Automatic Git history management is outside the current product scope.

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
- Artifact files (`plan.json`, `plan.md`, `tasks.md`) are restored from snapshots.
- Planner's backend session (where applicable) is forked: for Claude Code, we spawn a new child session from the chosen turn; for stateless backends, we rebuild messages up to the chosen point only.

**Why deferred.**

- Our phase-based workflow already provides coarse rewind via the plan card's **Request changes** row. That covers 90% of cases.
- Full rewind requires versioning every artifact at every rewind-able point, which roughly doubles disk footprint for a session.
- UI complexity is non-trivial: picker, preview of which artifacts will change, confirmation.
- Git commits complicate things: if tasks were already committed (and maybe pushed), rewind can't silently un-commit.

**Where to start when we do it.**

- Add `snapshots/` subfolder inside `sessions/<id>/` to hold versioned `state.json` / artifact copies per user-turn.
- Extend `session.jsonl` with `rewindPointId` markers at each user-turn.
- Reuse the `FilterableList` picker primitive for the rewind UI.

---

## **[Could]** Git-backed per-run code snapshot undo

**Why we want it.** File-level run accept/reject now exists through `/run accept` and `/run reject confirm`, using hash-guarded snapshots. A future git-backed variant could additionally manage optional commit history for a separately designed future workflow; no such option exists today.

**What it would look like.**

- Current runs never stage or commit. Any future history-management design would require a separate product decision and explicit authorization.
- At end-of-run or on user request, a git-backed reject could squash-delete the session's commits from branch history after the file-level safety check passes.
- Accept would keep the current branch history.

**Why deferred.**

- Git semantics here are dangerous if the user has pushed generated commits. Need careful UX to detect pushed state and refuse revert.
- Escalation must not depend on commits. Snapshot-revert has to preserve evidence, diffs, and task artifacts without relying on the Git index or commits.
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
- `splitbrief sessions delete <id>` to remove a session folder with confirmation.

**Why deferred.**

- The in-TUI picker plus the self-contained folder layout already cover inspecting and resuming sessions.
- Session deletion needs a confirmation step.

**Where to start when we do it.**

- New command at `src/cli/commands/sessions.ts`.

---

## ~~**[Should]** Non-TypeScript language support~~ ✅ Done

**Why we want it.** Obvious: not all users are on TS projects.

**What was built.**

- Before each review the reviewer reads the project and chooses the reviewer checks that verify the change. SPLITBRIEF runs them under the reviewer command policy, which runs any installed program of any language and refuses only what breaks a danger rule (shell syntax, a program run by path, inline code, a download-and-run launcher, a setup command, a script this run changed). Every refused command gets a named row. Plan `cmd` checks keep the allowlist of the five registry stacks. A planner `test` check resolves its command through `config → manifest → discovered → stack default → none`; with none it is `not-runnable`.
- Heuristic detection reads project marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`, `package.json`) to infer language and validation tools.
- The planning session asks the planner to identify the project's test toolchain (`language`, `test`, `testPattern`), which is persisted to `WorkflowState.discoveredValidation`.
- Planner and implementer prompts are language-aware: TypeScript keeps ESM-with-`.js` guidance, while Python, Go, Rust, JavaScript, and generic contexts avoid TypeScript-specific wording.
- A `test` check with no command at any layer is `not-runnable` with its reason instead of erroring; a required one halts with `required-checks-unrunnable`.
- Default TS projects (`package.json` with `typescript` devDependency) preserve identical behavior to before.

**Remaining.** Deeper language-specific planning heuristics can still be added as usage patterns emerge.

---

## **[Won't]** Confinement for checks and seats, and per-action approval

Owner decision, 2026-10-09. Today a check runs the project's own code with your user's permissions in the run workspace. SPLITBRIEF isolates its working directory, its environment (secrets dropped), its time, its output and its process group, but not the file system, the network or other processes ([CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach)). The `claude-code` implementer runs its shell in Claude Code's own sandbox and stops when that sandbox cannot start. The other seats are as [PLANNERS-AND-IMPLEMENTERS.md §Posture, trust, and auth](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth) says.

**Why we want it.** A reviewer check, a base re-run or a fix check runs test files and scripts the implementer wrote. Only an OS boundary stops such code from reading `~/.ssh` or calling the network.

**What it would look like.** These items are out of scope for now:

- An OS sandbox or confinement for checks or seats (research report R3, B-1 and B-2): for example bubblewrap or Seatbelt around each check, or a container per run.
- A network proxy that limits what checks and seats can reach (R3, B-3).
- `workflow.approve: each` or `yolo` (R3, A-1): an approval for each brief, or none at all.
- Per-action approval inside a seat: the Agent Client Protocol (ACP), a bridge to Claude Code's permission prompts, or the Codex app-server.

**Why deferred.** The minimal leak fixes shipped first: a sanitized environment for every command SPLITBRIEF runs itself, `sandbox.failIfUnavailable: true` for the `claude-code` implementer, and `validation.approve_checks: ask`. A sandbox for checks must keep every language's toolchain, cache and registry working; that needs its own design and measurements on macOS and Linux.

Decided 2026-10-09: checks inherit defined environment variables and drop credential names, selectors and helpers. No pass-through option is needed.

The changed-definition refusal compares these definitions with the run base: the scripts in every `package.json`, the `scripts` and `scripts-aliases` of `composer.json`, `Makefile`, `justfile`, `Rakefile` and `rakelib`, the Gradle and Maven wrappers, and interpreter scripts. SPLITBRIEF does not compare build manifests (`pom.xml`, `build.gradle`, `composer.json` as a dependency manifest, `Gemfile`, `mix.exs`, `build.rs`). A dependency change edits these files, and a refusal would block the check that verifies it. The refusal guards against a swapped check definition. It does not establish trusted execution.

**Where to start when we do it.**

- `runCommand` (`src/lib/process/spawn/run-command.ts`) is the one function every check routes through; a sandbox wraps its spawn there.

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
- Add the row in `src/features/workflow/components/conversation-flow/row-view.tsx`.

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
