# SPLITBRIEF — Mental model

Read this first. It explains what SPLITBRIEF does, how it thinks, and why it's built the way it is. No code, no file paths — just the concept. Everything else in these docs builds on this page.

---

## The core idea

SPLITBRIEF orchestrates two coding tools. One plans and reviews, the other executes, and SPLITBRIEF holds everything in between: the contract, the isolation, the validation, the retries, the consult, and the evidence.

**Planner** — the stronger of the two. It understands the feature request, explores the codebase, writes a detailed plan broken into slices — one verifiable change each — answers the build's consults, and reviews the finished work.

**Implementer** — a weaker model, reached over one of two transports that are supported equally:

- a **tool CLI** driving a smaller model, which writes files itself
- an **API model**, which returns file contents that SPLITBRIEF writes

You choose the transport. SPLITBRIEF does not favour one over the other.

The planner thinks, the implementer types, and the implementer never certifies its own work. The advantage compounds when the two tools come from different labs: a reviewer from a different model family does not inherit the implementer's blind spots. Lower spend follows from the split — it is a result, not the headline.

---

## The Task Brief

The Task Brief is the contract between planner and implementer. Each brief describes one slice — one verifiable change, listing every file it writes, with one of them as the anchor it creates or modifies — and contains everything the implementer needs to do the work without looking anything up:

- What to do and why
- The function signatures and types involved
- Step-by-step implementation instructions
- What tests to satisfy
- What's in scope and out of scope
- When to stop and ask instead of guessing

The implementer sees only its own brief. It has no access to the plan or other tasks. This is deliberate — small models lose coherence when given too much context. A self-contained brief keeps them focused.

Task Briefs are the durable contract. The planner writes them as one typed plan: acceptance criteria, checks, and the tasks that serve them. SPLITBRIEF checks that plan before anyone approves it, and the briefs compiled from it are what actually drives implementation.

---

## The workflow

A typical run, step by step:

1. User types `splitbrief start "add email validation"`
2. The planner reads the codebase and may ask up to 3 questions, each with a default, for at most 2 rounds
3. The planner answers one typed plan — criteria, checks, and Task Briefs, one per slice, ordered by dependency and grouped in batches
4. SPLITBRIEF checks the plan deterministically (every criterion has a check and a task, the dependencies make sense, every task fits the implementer's context); a failing plan goes back to the planner once
5. User reviews the plan on one plan card: approve, request changes, edit `plan.json`, or end the run. Approving also confirms the protected writes the plan lists
6. For each task: the implementer writes code in isolation, SPLITBRIEF promotes the approved changes into the project, then validates (typecheck → lint → test)
7. If validation fails: the implementer retries once, then the planner is consulted for one typed answer — guidance, a rewritten or split brief, a re-run of the checks, or one question for the user
8. If the ladder cannot go on (a spent bound, a failed consult call, a runner halt): enter recovery — for a spent bound the user can continue with a note, skip the task or end the run; other halts offer retry same worker, route to a bigger worker, skip, pause or end the run
9. The review seat reviews the final result against the briefs and the request — the planner, unless a `reviewer` is configured
10. Session summary written to disk, workflow done

The user can stop a run at any time — `esc` opens the stop options, `ctrl+c` stops now, and no option reverts files — queue messages while the planner is working, request changes on the plan, or skip individual tasks.

---

## Four layers

The code is organized in four layers with strict import boundaries:

**CLI** — Parses arguments, boots stores, starts the TUI or runs headless. When you type `splitbrief start`, this layer handles everything before the workflow engine takes over.

**Stores** — Module-scoped singletons holding UI and application state. React components subscribe through `store.use(selector)` and non-React CLI/TUI wiring can read with `store.get()`. Stores have no external dependencies — no React, no engine imports.

**Engine** — Runs the workflow: creates planner and implementer, manages phase transitions, emits events, persists state. It receives callbacks and sinks from the host instead of importing stores or UI code. This is what lets the full workflow run under Vitest without bringing up a terminal.

**UI** — React 19 + Ink 6 terminal interface. The workflow screen hosts `runWorkflow()` through runner hooks, supplies callbacks for human gates, and renders store state updated by the TUI event sink.

**How they talk to each other:**

The engine publishes events (like `task_completed` or `planner_status`) through the EventBus. The TUI sink forwards each event into workflow actions, which update split workflow stores. React components subscribe to store slices and re-render.

When the workflow needs a human decision — approve the plan, answer a question, confirm a protected write — the engine awaits a callback. The UI fulfills the callback by switching input mode and resolving the promise when the user answers. These gating callbacks are separate from the EventBus: events are fire-and-forget broadcasts, callbacks are blocking request/response pairs.

---

## One planning session

There are no modes. Every run plans in one typed session, and the same plan card guards every run unless `workflow.approve: none` skips it. A small change gets a small plan; a large one gets more criteria, checks and batches. Older configs that name a `workflow.mode` still load, with one notice.

---

## Sessions and persistence

Every run is a durable record, kept in a folder on disk under `.splitbrief/sessions/<id>/`. It contains:

- **state.json** — Current phase, task progress, and how the run stopped. Overwritten on every phase transition. This is the source of truth for continuing it.
- **session.jsonl** — Every event and message, append-only. The full audit log.
- **plan.json / plan.md / tasks.md** — The typed plan the planner answered and SPLITBRIEF checked, and its two renderings. A run planned by an older engine also holds `research.md` and `spec.md`.
- **summary.json** — Final cost, timing, outcomes. Written once at the end.
- **snapshots/** — Content-addressed working-tree snapshots for undo.

One active session at a time per project directory. `.splitbrief/active` contains the current session ID when the active pointer is present, while the per-session lockfile/heartbeat proves whether a process is still alive. Isolated parallel sessions require git worktrees, which give each worktree its own `.splitbrief/`.

**A run is continuable until you close it.** Not until it is "resumable", and not only when it was interrupted — parked, waiting at a gate, halted on a decision, stopped by an error, or killed outright, it keeps its place and picks up at the first thing it has not finished. Two things close a run: passing the final review, and choosing **End run**. A closed run is the only one nothing will pick up again.

`splitbrief resume` continues the most recent run; `splitbrief continue <session-id>` names one. If the backend supports session persistence (Claude Code, Codex), it reconnects to the thread the tool itself reported. Otherwise it rebuilds context from the JSONL log.

There is no separate results screen. A run stays on the screen it was already on, live or not: opening one from `/sessions` replays its history onto that screen and paints where it stopped, typing a correction flips it back to live in place, and a closed run grows a `Closed ─` block at the tail of its own transcript.

---

## Four runner kinds

Both planner and implementer are pluggable. The same four backend kinds work for either role:

**cli** — Spawns a CLI tool as a subprocess. Claude Code, Codex, Copilot, Opencode, Kilo-Code, Cursor.

**api** — Calls an OpenAI-compatible HTTP endpoint. Ollama, LM Studio, custom endpoint.

**shell** — Runs an arbitrary command with stdin/stdout piping; no shell/network sandbox.

**agent** — Subprocess that writes files directly to disk (no code extraction from response); no shell/network sandbox.


The orchestrator never branches on backend type. It calls the planner's typed call (`requestTyped`) and `implementer.implement()`. The factory dispatches to the right backend based on `config.planner.kind` and `config.implementer.kind`. Each backend exposes a capabilities struct — the orchestrator reads capabilities, not backend identity, to decide what's possible.

---

## Where the implementer works

The two transports need different amounts of isolation, and both end in the same place.

An implementer that writes files itself works in a git worktree — a second checkout of the same repository, created once per run, with the project's dependencies linked in so the agent can type-check and run tests where it stands. That is the default isolation, and it keeps a half-finished task out of your working tree. An implementer that returns file contents has nothing to isolate: SPLITBRIEF writes the file itself, after the approval gate.

Either way the destination is the same, and it is not negotiable: approved changes land in your real project directory. Promotion is guarded by content hashes — if a file changed underneath SPLITBRIEF between approval and write, the promotion stops rather than clobber your edit.

A worktree isolates files, not runtime and not trust. It shares the ports, the database, the hooks, and the config of the checkout it came from. It is not a security boundary.

---

## Validation and consult

Correctness is not the implementer's to judge — it is the weaker of the two models. SPLITBRIEF owns it: a deterministic pipeline of typecheck → lint → test, run in the real project after promotion, stopping at the first failure attributable to the task. A stage already red at baseline does not stop the pipeline: a task that introduces no new failure is accepted even when the tree was already red, and the planner owns the second opinion at final review. An implementer that can also run checks where it works is a bonus — it raises the first-pass rate, it does not decide the outcome.

If validation fails, the implementer retries once with the error message. Then SPLITBRIEF asks the planner, read-only, for one typed answer:

- **Guidance** — the implementer retries once more with the planner's instructions in its error block
- **Rewrite-task** — the brief is replaced at the same id, one revision further, and the failing attempt's own edits are rolled back first
- **Split-task** — the brief becomes 2–4 subtasks at the next free ids, with every pending dependent re-pointed to them
- **Verify** — no implementer call: the validation pipeline and the named checks run again, and a clean run completes the task
- **Ask-user** — the one question the ladder asks you, with a default; the answer continues as guidance

The planner never writes the implementation itself, and each task's lineage is bounded (2 consults, 8 attempts; 10 planner calls per run). If the ladder cannot go on (a spent bound, a failed consult call, a runner halt), the recovery system takes over: for a spent bound the user can continue with a note to grant the extra allowance, skip the task or end the run; other halts offer retry same worker, route to a bigger worker, skip, pause or end the run.

---

## Approval gates

The workflow pauses at two kinds of point for human review:

- **Plan card** — After the plan passes its checks, before any code is written. Approve, request changes (the planner revises the plan), edit `plan.json` (re-checked before it is applied), or end the run. Approving confirms the protected writes the plan lists. `workflow.approve: none` skips the card.
- **Protected-path confirmation** — During implementation, each written path is classified as `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, `sensitive_change`, or `package_change`. A write to a protected path (`destructive`, `sensitive_change`, `package_change`) asks, even under `--yolo`, once per path per run; no other write asks.

---

## What to read next

Now that you have the mental model:

- **[HOW-IT-WORKS.md](./HOW-IT-WORKS.md)** — The same flow from above, but with file paths, function names, and data flow diagrams. Read this to understand where things happen in the code.
- **[WORKFLOW.md](./WORKFLOW.md)** — The state machine: every phase, every transition, every edge case.
- **[ENGINE.md](./ENGINE.md)** — How the orchestrator runs, how the EventBus works, how engine and UI communicate.
