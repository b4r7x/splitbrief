# SPLITBRIEF — Mental model

Read this first. It explains what SPLITBRIEF does, how it thinks, and why it's built the way it is. No code, no file paths — just the concept. Everything else in these docs builds on this page.

---

## The core idea

SPLITBRIEF splits AI coding work into two roles:

**Planner** — an expensive, capable model (Claude, GPT-4, Codex CLI, etc.) that understands the feature request, explores the codebase, and writes a detailed plan broken into single-file tasks.

**Implementer** — a cheap, fast model (local Ollama, small API model, Codex, etc.) that executes one task at a time against a self-contained brief.

The planner thinks. The implementer types. You pay for thinking once, then execute cheaply.

---

## The Task Brief

The Task Brief is the contract between planner and implementer. Each brief describes exactly one file operation — create or modify — and contains everything the implementer needs to do the work without looking anything up:

- What to do and why
- The function signatures and types involved
- Step-by-step implementation instructions
- What tests to satisfy
- What's in scope and out of scope
- When to stop and ask instead of guessing

The implementer sees only its own brief. It has no access to the spec, the plan, or other tasks. This is deliberate — small models lose coherence when given too much context. A self-contained brief keeps them focused.

Task Briefs are the durable contract. The spec and plan are supporting documents for the human to review; the briefs are what actually drives implementation.

---

## The workflow

A typical run, step by step:

1. User types `splitbrief start "add email validation"`
2. Planner researches the codebase — reads files, maps imports, understands patterns
3. Planner writes a specification — what the feature should do, how it fits
4. User reviews and approves the spec (or comments, or rejects)
5. Planner writes Task Briefs — one per file, ordered by dependency
6. User reviews the briefs
7. For each task: implementer writes code, SPLITBRIEF validates (typecheck → lint → test)
8. If validation fails: retry up to 3 times, then escalate to bigger models
9. If escalation fails: enter recovery — user picks next action (retry same worker, route to a bigger worker, skip, pause, abort)
10. Planner reviews the final result against the spec
11. Session summary written to disk, workflow done

The user can interrupt live model calls with Ctrl-C, queue messages while the planner is working, rewind to re-plan a spec or plan, or skip individual tasks.

---

## Four layers

The code is organized in four layers with strict import boundaries:

**CLI** — Parses arguments, boots stores, starts the TUI or runs headless. When you type `splitbrief start`, this layer handles everything before the workflow engine takes over.

**Stores** — Module-scoped singletons holding UI and application state. React components subscribe through `store.use(selector)` and non-React CLI/TUI wiring can read with `store.get()`. Stores have no external dependencies — no React, no engine imports.

**Engine** — Runs the workflow: creates planner and implementer, manages phase transitions, emits events, persists state. It receives callbacks and sinks from the host instead of importing stores or UI code. This is what lets the full workflow run under Vitest without bringing up a terminal.

**UI** — React 19 + Ink 6 terminal interface. The workflow screen hosts `runWorkflow()` through runner hooks, supplies callbacks for human gates, and renders store state updated by the TUI event sink.

**How they talk to each other:**

The engine publishes events (like `task_completed` or `planner_status`) through the EventBus. The TUI sink forwards each event into workflow actions, which update split workflow stores. React components subscribe to store slices and re-render.

When the workflow needs a human decision — approve a spec, answer a question, confirm a costly action — the engine awaits a callback. The UI fulfills the callback by switching input mode and resolving the promise when the user answers. These gating callbacks are separate from the EventBus: events are fire-and-forget broadcasts, callbacks are blocking request/response pairs.

---

## Modes

Four modes trade speed for thoroughness:

**instant** — One planner call. Produces tasks directly. No spec, no approval gates. For renaming a variable or fixing a typo.

**quick** — One planner call. Tasks only, no supporting documents. For small, well-understood changes.

**standard** — Four planner calls: research → spec → plan → tasks. Spec approval gate before planning. The default for most work.

**speckit** — Six to seven calls: adds clarification questions, constitution check, and post-plan analysis. Spec, plan, and briefs gates are active by default. For large, risky, or externally visible work.

All four modes produce the same output: a list of Task Briefs. The difference is how much the planner thinks before writing them.

---

## Sessions and persistence

Every workflow run is a session. A session is a folder on disk under `.splitbrief/sessions/<id>/`. It contains:

- **state.json** — Current phase, task progress. Overwritten on every phase transition. This is the source of truth for resume.
- **session.jsonl** — Every event and message, append-only. The full audit log.
- **research.md / spec.md / plan.md / tasks.md** — Planning artifacts, written once per planning phase when the selected mode produces them. Speckit can also write clarification, constitution-check, and analysis artifacts.
- **summary.json** — Final cost, timing, outcomes. Written once at the end.
- **snapshots/** — Content-addressed working-tree snapshots for undo.

One foreground active session at a time per project directory. `.splitbrief/active` contains the current foreground session ID when the active pointer is present, while the per-session lockfile/heartbeat proves whether a process is still alive. Detached sessions use lockfiles. Isolated parallel sessions require git worktrees, which give each worktree its own `.splitbrief/`.

`splitbrief resume` picks up the active interrupted workflow. If the active pointer is absent, use `splitbrief continue <session-id>` for a known resumable session. If the backend supports session persistence (Claude Code, Agent SDK), it reconnects. Otherwise, it rebuilds context from the JSONL log.

---

## Five runner kinds

Both planner and implementer are pluggable. The same five backend kinds work for either role:

**cli** — Spawns a CLI tool as a subprocess. Claude Code, Codex, Aider, Copilot, Opencode, Kilo-Code.

**api** — Calls an OpenAI-compatible HTTP endpoint. Ollama, LM Studio, Anthropic, OpenRouter, DeepSeek, OpenAI, Groq, Together.

**shell** — Runs an arbitrary command with stdin/stdout piping; no shell/network sandbox.

**agent** — Subprocess that writes files directly to disk (no code extraction from response); no shell/network sandbox.

**agent-sdk** — Anthropic Agent SDK library call with thread persistence.

The orchestrator never branches on backend type. It calls `planner.plan()` and `implementer.implement()`. The factory dispatches to the right backend based on `config.planner.kind` and `config.implementer.kind`. Each backend exposes a capabilities struct — the orchestrator reads capabilities, not backend identity, to decide what's possible.

---

## Validation and escalation

After the implementer writes code for a task, SPLITBRIEF runs validation: typecheck → lint → test. The pipeline stops on the first failure.

If validation fails, the implementer retries with the error message (up to 3 attempts by default). If those local retries are exhausted, escalation kicks in:

- **Tier 0** — Intermediate model: a paid mid-tier API model (configured via `escalation.intermediateProvider`) retries the task. Runs only when an intermediate provider is set
- **Tier 1** — Hint escalation: the planner reads the error and writes a short hint, then the implementer retries once with that hint
- **Tier 2** — Full escalation: the planner takes over and writes the code itself

If all tiers fail, the recovery system takes over: the user sees the failure and picks an action — retry the same worker, route to a bigger worker, skip the task, pause, or abort.

---

## Approval gates

The workflow pauses at defined points for human review:

- **Spec gate** — After the planner writes the spec. Approve, comment (planner regenerates), or reject.
- **Plan gate** — After the planner writes the plan (speckit mode by default).
- **Briefs gate** — After Task Briefs pass the quality gate. The user reviews tasks.md before any code is written.
- **Tiered approval** — During implementation, declared/promoted file-write requests are classified as `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, or `package_change` and gated at three tiers: `auto` (allow silently), `sticky` (remember the user's choice), `confirm` (always ask). `network` is accepted only for config compatibility; it is not shell/network sandboxing.
- **Cost gate** — Before tasks start, if the predicted cost exceeds the budget.

`--approve none` skips spec/plan document gates. Briefs review is separate and still runs in modes that produce reviewable briefs. `--approve all` enables spec and plan gates. The mode sets the default: instant/quick skip spec/plan gates, standard gates on spec, speckit gates on spec and plan.

---

## What to read next

Now that you have the mental model:

- **[HOW-IT-WORKS.md](./HOW-IT-WORKS.md)** — The same flow from above, but with file paths, function names, and data flow diagrams. Read this to understand where things happen in the code.
- **[WORKFLOW.md](./WORKFLOW.md)** — The state machine: every phase, every transition, every edge case.
- **[ENGINE.md](./ENGINE.md)** — How the orchestrator runs, how the EventBus works, how engine and UI communicate.
