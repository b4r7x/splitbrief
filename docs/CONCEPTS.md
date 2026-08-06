# SPLITBRIEF — Concepts & Glossary

Shared vocabulary for anyone (human or AI agent) reading the codebase. All terms here are used throughout `src/` and the other docs in this folder.

---

## Core idea

SPLITBRIEF is a CLI that splits AI coding work across two roles:

- A **planner** — an expensive, high-quality model (Claude Code, Codex, GPT-4-class, …) does the *thinking*: researches the codebase and compiles the request into a Task Brief, with optional supporting spec/plan artifacts when the work needs more structure.
- An **implementer** — a weaker **model**, reached either as a CLI tool running a cheap model or as an API model (Ollama, LM Studio, DeepSeek, …) — does the *typing*: turns each task from the list into code, one task at a time. Both transports are first-class; SPLITBRIEF favours neither.

The orchestrator in the middle owns the workflow: it runs the planner, persists the Task Brief transport and supporting artifacts, walks through tasks, validates each one (`typecheck → lint → tests`), records evidence and checkpoint boundaries, and escalates back to the planner when the implementer gets stuck. Git commit strategies are optional and off by default; the default leaves changes unstaged for manual review.

The goal is a change that holds up: the tool that wrote the code never signs it off, and a deterministic pipeline — not the implementer's own opinion — decides whether the task passed. Lower total cost follows from the split; it is a reported outcome, not the promise.

---

## Roles

### Planner

The "smart" side. Its responsibilities, in order:

1. **Research** the project (read files, understand existing patterns).
2. **Compile a Task Brief** — the durable execution contract for the change.
3. **Write supporting docs when needed** — `spec.md` and `plan.md` for larger, riskier, or more ambiguous work.
4. **Write `tasks.md`** — the transport format that carries one or more Task Briefs to the implementer.
5. **Review** the entire diff at the end against the Task Brief and any supporting spec.
6. **Escalate** — when the implementer fails a task 3× in a row, escalation runs through an optional paid intermediate model, then the planner either hints or takes over and fixes the task itself.

The planner also supports **clarifying questions**: it can pause and ask the user questions before finalizing the Task Brief and any supporting spec (only for backends that support this — see `capabilities.supportsConversationalPlanning` on `Planner` in `src/engine/planners/types.ts`).

### Implementer

The "typing" side. Responsibilities:

1. Receive a self-contained task prompt (signature, types, tests, constraints, implementation steps, code context).
2. Produce code: either whole-file write or search/replace markers.
3. Return code to the orchestrator for extraction-based runners (`api`, `shell`), or write files directly in an isolated directory for `cli` / `agent` / `agent-sdk`; SPLITBRIEF inspects filesystem changes afterward and promotes them into the project under a hash guard.

The implementer is *stateless per task*. No conversation is maintained between tasks. This is deliberate: atomic tasks keep the context small enough to fit in an 8K model.

### Orchestrator

The middle layer. Zero React, zero Ink — pure logic in `src/engine/orchestrator/`. Owns:

- The state machine (see `docs/WORKFLOW.md`).
- Disk writes (`tasks.md` as Task Brief transport, mode-dependent planning artifacts such as `research.md`, `spec.md`, and `plan.md`, `sessions/<id>/state.json`, `sessions/<id>/session.jsonl`).
- Validation pipeline (`typecheck → lint → tests`).
- Optional git checkpoint/commit strategy when explicitly configured.
- Event emission through the EventBus to subscribed sinks: TUI, JSONL, session tree, stdout JSON, OTel, and hooks.

---

## Runner kinds

Both the planner and the implementer are configured with a `kind` field. There are five kinds — each corresponds to a different way of invoking a model. The factory in `src/engine/runners/factory.ts` dispatches on this field.

| Kind | What it is | Example | Write mode as implementer | When to use |
|------|-----------|---------|---------------------------|-------------|
| `cli` | A known CLI tool invoked as a subprocess (stream-json or jsonl parsed) | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` | `direct` | Default planner path; uses existing subscriptions. As an implementer, one of the two first-class transports — a known tool pointed at a cheaper model |
| `api` | Any OpenAI-compatible HTTP endpoint | Ollama, LM Studio, DeepSeek, OpenRouter, Together | `extracted-code` | The other first-class implementer transport — a weaker model behind an endpoint, local or remote |
| `shell` | An arbitrary command. Prompt → stdin, code → stdout. No shell/network sandbox | Any custom script | `extracted-code` | Users who want to plug in a tool we don't know |
| `agent` | A command that writes files directly to disk. No stdout extraction or shell/network sandbox | A complete coding agent used as an implementer | `direct` | When the tool handles file writing itself |
| `agent-sdk` | Programmatic call into the Anthropic Agent SDK (no subprocess) | `@anthropic-ai/claude-agent-sdk` | `direct` | When you want SDK-level control and already have `ANTHROPIC_API_KEY` |

Write mode follows mechanically from the kind and cannot be chosen: `capabilities.writesFiles` may be restated per profile, but config load rejects any value that differs from the kind's mode. See [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#write-modes) for what each mode means for isolation and promotion.

All five kinds implement the same `Planner` / `Implementer` interface (`src/engine/planners/types.ts`, `src/engine/implementers/types.ts`). The orchestrator doesn't care which kind is active.

---

## Workflow modes

The `workflow.mode` config field controls how many planner calls run before implementation starts and how many approval gates block on the user. Set via `--mode` CLI flag, config file, or the `/mode` slash command at runtime.

| Mode | Planner calls | Approval gates | Best for |
|------|:---:|:---:|---|
| `instant` | 1 (minimal Task Brief + task transport) | 0 | Tiny fixes, obvious one-step changes |
| `quick` | 1 (small Task Brief + task transport) | 0 | Small work that still needs a little structure |
| `standard` (default) | 4 (research → supporting spec → plan → Task Brief transport) | 2 (supporting spec + briefs) | Normal features |
| `speckit` | 7 (research → supporting spec → clarify → constitution-check → plan → analyze → Task Brief transport) | 3 (supporting spec + plan + briefs) | Large, risky, or audited work |


The dispatch happens in `src/engine/orchestrator/planning/run.ts` on `config.workflow.mode`.

---

## Phases

A workflow is a state machine. Each state is a **phase**. Full definitions live in `src/core/state/machine.ts`; cancel/resume semantics in `src/core/phases.ts`.

```
idle
 ├─► researching       (planner is reading the code)
 ├─► specifying        (planner is writing supporting spec.md)
 │   └─► reviewing-spec   (waiting for user to approve/edit/reject)
 ├─► planning          (planner is compiling the Task Brief + tasks.md transport)
 │   └─► reviewing-plan   (waiting for user, speckit-only by default)
 ├─► implementing      (implementer is working on current task)
 │   └─► validating-task  (typecheck → lint → tests running)
 │       └─► escalating   (validation failed 3× → planner takes over)
 ├─► final-review      (planner reviews whole diff vs Task Brief/supporting spec)
 └─► complete
```

**Live phases** (single Ctrl-C aborts the active call): `researching`, `specifying`, `planning`, `implementing`, `escalating`, and `final-review`.

**Resumable phases** (saved state can continue from here): `planning`, `implementing`, `final-review` — the `RESUMABLE_PHASES` set in `src/core/phases.ts` — plus any phase with `awaitingContinue: true`. Every other phase (the review/gate phases, `analyzing`, `validating-task`, `escalating`, and the generative phases `researching`/`specifying`) is **not resumable** without `awaitingContinue` — if a cold crash wiped the process mid-stream, the stream is lost and the only safe behaviour is to restart the feature.

---

## Task briefs

A **Task Brief** is the atomic semantic unit of implementation. It is transported in `tasks.md` and parsed into structured objects by `src/engine/spec/tasks/parse.ts`.

Task fields (`src/core/schemas/task.ts`):

- `id` — branded `TaskId`, unique inside a workflow
- `file` — path to the file the task edits or creates
- `action` — file operation: `create` or `modify`
- `description` — longer task body
- `signature` — language-appropriate function, interface, or type signature hint
- `typeDefs` — inlined type definitions (the planner resolves types so the implementer doesn't have to)
- `tests` — concrete test cases / acceptance criteria
- `constraints` — rules the implementer must follow
- `implementationSteps` — 3–5 step recipe for the implementation
- `status` — `pending | in_progress | done | escalated | failed | skipped`
- `currentCode` — code as it exists at task start (for whole-file / function-level context)

Task briefs are topologically sorted on dependency. Each task is independently prompt-able — the prompt sent to the implementer is fully self-contained.

---

## Validation pipeline

Runs after every implementer response. Defined in `src/engine/orchestrator/validation/run.ts`.

1. **Type-check** — the configured, discovered, or heuristic command. The built-in `npx tsc --noEmit` default applies only on TypeScript projects (a `tsconfig.json` exists or `typescript` is a dependency); on other languages the stage is skipped when nothing else resolves.
2. **Lint** — the configured, discovered, or heuristic command; the stage is skipped when no lint command resolves.
3. **Tests** — the configured, discovered, or heuristic command, falling back to `npm test`.

A stage that resolves to no command is recorded as *skipped* (not a pass). When every enabled stage is skipped, the run emits a warning so a nothing-validated task is not mistaken for all-green.

A failing stage that was already red at baseline is a third outcome: *failed but pre-existing*. It is recorded separately from skipped — a missing linter and a broken linter do not read the same — and it does not fail the task when the failure names none of the task's changed files. The evidence ledger marks such entries `baselineExempt` and records a `failed (pre-existing)` observed-evidence line so the exemption stays reviewable after the run.

Each step stops at the first failure *attributable to the task* and reports it back to the orchestrator, which either retries or escalates. A stage that was already red at baseline continues the pipeline so the stages behind it still get a verdict, and never produces a retry prompt.

---

## Retry & escalation

On validation failure:

- **Attempts 1–3**: the implementer retries with the same entire context but a slightly higher temperature (+0.1 per attempt). No planner involvement.
- **After 3rd failure**: escalate through the tiers in order.
  - **Tier 0 — intermediate model** (only when `escalation.intermediateProvider` is configured and `escalation.enabled` is not `false`): a paid mid-tier API model retries the task before the planner is involved.
  - **Tier 1 — hint escalation** (if the planner supports it — see `supportsHintEscalation`): planner reads the error, returns a short hint, implementer retries once with the hint.
  - **Tier 2 — full escalation**: planner takes over and writes the code itself. The task is marked `escalated` (not `done`) in the summary so you can see cost impact.

Escalation logic: `src/engine/orchestrator/escalation/handle.ts`.

---

## Approval gates

User-facing pauses where the workflow waits for explicit input. Each gate asks: *approve / edit (with a comment) / reject*.

- **Spec gate** — after `specifying`, before `planning`. Active in `standard` and `speckit` modes.
- **Plan gate** — after `planning`, before `implementing`. Active only in `speckit` mode by default.
- **Briefs gate** — after Task Briefs pass the quality gate, before `implementing`. Active in `standard` and `speckit` modes.

On a gate:

- Approve → if the artifact was edited on disk (via the `edit` action below), the change is treated as feedback and downstream artifacts are regenerated from it; otherwise advance.
- Edit → open the external editor on the artifact, then re-prompt the gate so you can approve the edited file.
- Comment without approve → the planner regenerates the artifact using the comment as feedback, then loops back to the gate.
- Reject without comment → cancel the workflow, return to idle.

Implementation: `src/engine/orchestrator/approval/loop.ts` via `callbacks.onApprovalNeeded`.

---

## Clarifying questions

During `specifying`, a conversation-capable planner can emit inline questions to the user. These come through as `<!-- Q:{JSON} -->` markers in the planner's output and are parsed by `src/engine/parsers/question.ts`.

Up to 5 questions per run. User can answer each, type `skip` to skip one, or type `done` to stop accepting questions.

Answered questions are appended to `spec.md` under a `## Clarifications` section when a supporting spec exists. On the next planner call (regenerate or plan phase), the planner sees them as part of the supporting-spec context.

Since spec 008, clarification answers also route through the same queue as user-initiated interjections (see §Queue & Interjection). Planners that implement `injectUserTurn()` receive the answer immediately; other planners drain it at the next phase boundary.

---

## Skills

Optional markdown files that provide extra context to the planner (coding standards, domain knowledge, architectural notes). `src/engine/skill-discovery.ts` discovers Claude Code skills from `.claude/skills/` and `~/.claude/skills/`, default runner skills from `.splitbrief/skills/` and `~/.splitbrief/skills/`, Codex instructions from `AGENTS.md` plus `~/.codex/skills/`, and Aider conventions from `CONVENTIONS.md`. User picks which skills to include for a given run; selected skills are concatenated into a `skills_context` block and passed to the planner alongside the feature prompt.

Skills are planner-only. The implementer never sees them — its prompts are derived from the resolved Task Brief transport and any supporting artifacts.

---

## Sessions (SPLITBRIEF sessions, not planner sessions)

A **SPLITBRIEF session** is one self-contained piece of work from initial feature prompt to final summary. Every session lives in its own folder under `.splitbrief/sessions/<session-id>/`, where `<session-id>` has the form `<ISO-date>-<slug>` (e.g. `2026-04-14-add-email-validator`). Same-day slug collisions get a `-N` suffix (`2026-04-14-add-email-validator-2`).

Foreground sessions are pointed to by `.splitbrief/active`, a plain text file containing the session-id. Only **one foreground session can be active at a time** in a given project directory — `splitbrief start` fails if `.splitbrief/active` already points at a live session. Detached sessions use lockfiles instead. Users who want to run truly parallel workflows should use separate git worktrees, which naturally isolate `.splitbrief/` per working directory.

This is distinct from a **planner session** — e.g. the `session_id` Claude Code stream-json emits — which is a backend-specific conversation handle. Planner session ids are persisted inside `state.json` so they can be reused on resume (see `docs/WORKFLOW.md` §1.5). One SPLITBRIEF session may own several planner session ids over its lifetime (e.g. if the first expired and a fresh one was opened on resume).

## Queue & Interjection

The **queue** is a workflow-scoped buffer of user messages that the user types while the planner is actively generating. The engine stores queued messages on `WorkflowState.messageQueue`; the TUI stores only the pending queue depth in the workflow lifecycle store. It solves the problem of "I want to add something without restarting the phase".

Flow:

1. During a live planner phase, the TUI composer accepts text. Pressing **Enter with text** appends the message to the queue — it does **not** abort the current call.
2. At the next safe point (end of current planner call, boundary between phases), the orchestrator drains the queue and prepends its contents to the next planner prompt as `[user also says: ...]` blocks.
3. For backends that expose a native session with mid-conversation inject (Claude Code via `--session-id`), each queued message is *also* dispatched as a parallel `user` turn into the live session. The planner sees it on its next model turn without waiting for our orchestrator to start a new phase.
4. Queue drains at safe-points only, never mid-model-output.

**Scope:** the queue is **planner-only**. Implementers (small local models) do not receive queued messages. Mid-task interjection is explicitly disallowed because small models lose coherence when their single-shot task prompt is perturbed. If the user needs to change something during implementation, they abort the current task (Ctrl-C) and use `/redo-task <id>` after updating the spec.

**Message origin.** Each `QueuedMessage` carries an `origin` discriminator: `'user-input'` for text the user typed directly, and `'clarification'` for answers routed from the clarification Q&A flow. The drain block formats them differently: clarification answers use `[clarification answer during <phase>]\nQ: ...\nA: ...\n[/clarification answer]` while user-initiated interjections use the generic `[user also says during <phase>]` wrapper.

## Awaiting-continue

A **sub-state** entered after the user aborts a live model call (single Ctrl-C). Characteristics:

- Workflow phase stays what it was (`researching` / `specifying` / `planning` / `implementing` / `escalating` / `final-review`). The abort does **not** reset the phase.
- Partial planner output up to the abort point is preserved in `session.jsonl` with `interrupted: true`.
- Orchestrator is idle, waiting for user action.
- User can: (a) type text + Enter → queued → next call proceeds with queue appended, (b) press Enter on empty input → explicit continue, next call is a `continue` turn (for Claude Code: native session next turn with `"continue"`; for stateless backends: messages array becomes `[originalPrompt, assistantPartial, "continue"]`).
- No timeout. The state is persisted to `state.json` — user can close the terminal, come back hours later, and continue from the saved session.

## Capability matrix

Each `Planner` implementation exposes a `capabilities` struct declaring what it supports:

```ts
type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;  // inline clarification questions (existing)
  supportsHintEscalation: boolean;          // hint-before-direct escalation (existing)
  supportsSessionResume: boolean;           // --session-id reuse on resume
  supportsEffort: boolean;                  // effort/reasoning hint support
  supportsImages: boolean;                  // image attachment support
  supportsSelfSummarisation: boolean;       // transcript compaction support
};
```

The orchestrator reads capabilities at run start and degrades gracefully per backend. Native user-turn injection is an optional `Planner.injectUserTurn()` method rather than a capability flag.

---

## EventBus, EngineEvent, EventSink

The engine publishes every observable step as an `EngineEvent` on a single `EventBus` (synchronous pub/sub, `src/engine/events/bus.ts`). Sinks subscribe and receive the stream in registration order. The bus is the only broadcast channel between engine and the rest of the system.

- **EngineEvent** — the type-dispatched event contract (snake_case `type`, mandatory `ts: number`, usually `phase: Phase`) defined as `EngineEventSchema` in `src/engine/events/schema.ts`; the `EngineEvent` alias (`z.infer`) is re-exported from `src/engine/events/types.ts`. `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed` are phase-less. Single source of truth for every workflow event that crosses the engine boundary. Extended by adding a new Zod member to the contract — no separate registration step. The legacy `TuiEvent` / `OrchestratorEvent` types were removed in the 2026-04-20 release.
- **EventBus** — synchronous pub/sub port declared in `src/engine/events/types.ts`, created by `createEventBus()`. `publish(event)` fans out to every subscribed sink inline, in registration order; a throw in one sink is caught and swallowed so it does not break fan-out to the others. Sinks that want operator-visible failures must publish their own warning before throwing.
- **EventSink** — any subscriber that matches `(event: EngineEvent) => void`. Synchronous by contract, so ordering is preserved and a slow sink can delay later sinks. Shipped sinks: `jsonlSink`, `treeRecorderSink`, optional `tuiSink`, optional `stdoutJsonSink`, optional `otelSink`, and optional hook sink.
- **Phase** — `'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'clarifying' | 'constitution-check' | 'planning' | 'reviewing-plan' | 'reviewing-briefs' | 'analyzing' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete'` (`src/core/schemas/enums.ts`). Phase-bearing `EngineEvent` variants carry the current `phase` so sinks (OTel span hierarchy, hook dispatcher, TUI router) can filter and group without having to reconstruct workflow position from event type alone.

Gating callbacks (`onApprovalNeeded`, `onQuestionAsked`, `onContinuationNeeded`, `onCostApprovalNeeded`, `onUserEditConflict`, `onTieredApproval`, `onTaskReviewNeeded`) are a **separate** mechanism — they are discrete `await`-able request/response pairs supplied by the workflow host. `onComplete(summary)` is a synchronous completion notification. Budget pressure is not gated by a callback: it publishes `budget_*` events and pauses through the recovery channel. Use the bus for broadcast; use callbacks for gates.

## Headless mode

`splitbrief start --json "feature"` runs the workflow without the Ink TUI. Workflow host callbacks are stubbed: review gates approve, clarifications and continuations answer empty, and budget pause/exceeded recovery exits non-zero. File-write tiered approvals are not auto-approved and can fail closed with `APPROVAL_REQUIRED` unless their tiers allow the write. Events stream as NDJSON on stdout via `stdoutJsonSink` — one JSON-encoded `EngineEvent` per line, parseable by `jq` or any NDJSON consumer. Driver: `src/cli/headless.ts` → `runWorkflow({ headless: true })`. Intended for CI, logging pipelines, and programmatic integration. See [MIGRATION.md §Headless mode](./MIGRATION.md).

## Hooks (workflow)

Workflow lifecycle hooks let users run custom commands or in-process modules at well-known moments (pre/post task, pre/post commit, etc.). Built on top of the EventBus — `post_*`/`on_*` are a fire-and-forget sink; `pre_*` hooks run sequentially at the orchestrator call site and a `deny` outcome short-circuits the upcoming action. Hooks are declared under `hooks:` in `.splitbrief/config.yaml`. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — **not** to be confused with React hooks ([HOOKS.md](./HOOKS.md)).

- **HookEvent** — the lifecycle trigger keys (`src/core/schemas/hooks.ts`): `'pre_planning' | 'pre_task' | 'post_task' | 'pre_validation' | 'post_validation' | 'pre_commit' | 'post_commit' | 'pre_escalation' | 'pre_compact' | 'on_error' | 'on_complete'`. `pre_*` hooks block the upcoming action (a `deny` outcome short-circuits it); `post_*` and `on_*` hooks are fire-and-forget through the EventBus sink.
- **HookEntry** — one configured hook: discriminated on `kind: 'command' | 'module'`. `command` entries carry `{ command, args, timeout_ms, on_failure }`; `module` entries carry `{ path, timeout_ms, on_failure }`. `on_failure` is one of `'block' | 'warn' | 'ignore'`. `timeout_ms` is bounded at 300_000 ms with a 30_000 ms default.
- **HooksConfig** — the `hooks:` section of `.splitbrief/config.yaml`: a map from `HookEvent` to `HookEntry[]`, plus an optional `builtin: Record<string, boolean>` toggles block for shipped hooks (e.g. `prettier-on-change`, `block-secrets`).

## Hook trust

First-time trust gate for hook configs. `src/core/hooks/trust.ts` computes a hash from the hook section plus module hook file digests; `src/cli/hook-trust-prompt.ts` prompts in a TTY the first time, showing each hook's executable, the absolute path it resolves to here, and its argv, then asking `Trust these hooks for this project? [y/N]`. Answering `y` writes a receipt to `~/.splitbrief/trust/hooks.json` keyed by the canonical path of this checkout, so the grant belongs to this machine and this checkout and a repository can neither ship nor forge one. Any edit to the hooks section or module hook files invalidates the hash and re-prompts. In CI (non-TTY), `--allow-hooks` is required — otherwise SPLITBRIEF refuses to start. This prevents silent RCE via a config or hook-file edit.

## Repo-map

Token-budgeted codebase summary injected into the planner prompt at workflow start. Pipeline: tree-sitter parse → SQLite cache → symbol graph → PageRank → token-aware format. Lives in `src/engine/codebase/`. Opt-out via `codebase.enabled: false`. Force a rebuild with `/repomap rebuild` in the TUI. See [REPOMAP.md](./REPOMAP.md).

- **RepoMapOptions** — options to `buildRepoMap(projectDir, opts)` in `src/engine/codebase/repomap.ts`: `{ projectDir, tokenBudget?, include?, exclude?, focusFiles? }`. `tokenBudget` defaults to 4000. `include`/`exclude` default to `['src/**/*.ts', 'src/**/*.tsx']` minus tests, `dist/`, and `node_modules/`. `focusFiles` boosts the PageRank personalization vector for files the planner already knows are relevant.

---

## Artifacts on disk

All workflow state lives under `.splitbrief/` in the target project. Each session gets its own self-contained folder.

```
.splitbrief/
├── config.yaml                             # user config (version: 3)
├── active                                  # plain text: session-id of the currently-active run (or absent)
└── sessions/
    ├── 2026-04-14-add-email-validator/
    │   ├── state.json                      # mutable: phase, tasks, currentTaskIndex, tokenUsage, plannerSessionId
    │   ├── session.jsonl                   # append-only log: type-tagged events + messages
    │   ├── summary.json                    # written once at end of run (Summary: tokens, cost, timings, outcomes)
    │   ├── research.md                     # Standard/speckit research notes when produced
    │   ├── spec.md                         # supporting artifact (optional)
    │   ├── plan.md                         # supporting artifact (optional)
    │   ├── tasks.md                        # Task Brief transport
    │   ├── clarifications.md               # speckit clarification artifact when produced
    │   ├── constitution-check.json         # speckit constitution result when produced
    │   └── analyze.json                    # speckit analysis result when produced
    └── 2026-04-13-fix-auth-bug/
        └── …                               # same shape, one folder per historical session
```

Key rules:

- One session = one folder. The folder name is the session-id.
- `state.json` is what `splitbrief resume` reads to rebuild the in-memory `WorkflowState`. It is overwritten on every phase transition.
- `summary.json` is written exactly once, at end-of-run.
- `session.jsonl` is append-only and the single source of truth for history (see "Events & messages" below).
- `tasks.md` is the human-readable Task Brief transport. `research.md`, `spec.md`, `plan.md`, and speckit artifacts are supporting artifacts written when the corresponding planner phase produces them. They are **always** written when produced, regardless of `workflow.persistTranscript`.
- `.splitbrief/active` holds the session-id for foreground sessions that should block another same-directory `splitbrief start`. Detached sessions use lockfiles instead.

---

## Events & messages

Everything the orchestrator does is logged to `session.jsonl` — a single append-only JSON Lines file per session. Each line is one timestamped entry; event and message records use ISO timestamps, while summary records use the schema's accepted timestamp string/number form. The file serves three consumers: the TUI (for live and replay rendering), the resume path (for transcript rebuild when a native session is unavailable), and humans debugging a run.

Entries come in three **kinds**, distinguished by the `kind` field:

```jsonl
{"ts":"2026-04-14T10:32:00.123Z","kind":"event","type":"workflow_started","phase":"idle","data":{"feature":"add email validator"}}
{"ts":"2026-04-14T10:32:01.001Z","kind":"event","type":"planner_status","phase":"researching","data":{"status":"running"}}
{"ts":"2026-04-14T10:32:05.200Z","kind":"message","role":"assistant","phase":"researching","text":"I'll look at..."}
{"ts":"2026-04-14T10:35:00.000Z","kind":"event","type":"clarifications_collected","phase":"specifying","data":{"count":1,"clarifications":[{"question":"Auth scheme?","answer":"JWT"}]}}
{"ts":"2026-04-14T10:35:30.200Z","kind":"message","role":"user","text":"Use JWT with refresh tokens"}
{"ts":"2026-04-14T10:35:45.000Z","kind":"summary","text":"User chose JWT with refresh tokens.","summarizedUpTo":"2026-04-14T10:35:30.200Z","tokenEstimate":128}
{"ts":"2026-04-14T10:36:00.000Z","kind":"event","type":"plan_approved","phase":"reviewing-plan","data":{}}
```

- `kind: "event"` — operational metadata. Workflow lifecycle, phase transitions, validation results, escalation triggers, artifact writes, errors. Small, always logged.
- `kind: "message"` — conversation content. User prompts, planner text chunks, clarification Q&A, approval comments, planner reviews. Text-heavy, **opt-outable** via `workflow.persistTranscript: false` (default `true`).
- `kind: "summary"` — compaction output. Contains `text`, `summarizedUpTo`, optional `tokenEstimate`, and optional `structured` data. Resume uses the latest summary as a synthetic message, then loads later messages.

Filtering happens at read time: `lines.filter(l => l.kind === 'message')`. There is no separate file for events vs. messages — this is deliberate. A log is a chronological stream, and splitting it would force consumers to merge-sort at every read while opening new crash-atomicity problems. This is the same design Claude Code uses (`~/.claude/projects/<cwd>/<id>.jsonl`), and the same pattern event-sourcing frameworks settle on.

Typed event schema: `src/engine/events/schema.ts` (`EngineEventSchema`; the `EngineEvent` alias is re-exported from `src/engine/events/types.ts`). Reader API (async iterables for log, messages, events): `src/core/sessions/log-reader.ts`. Renderer registry for the TUI: `src/features/workflow/conversation-rows/event-rows/dispatch.ts` (with `visibility.ts`, `planner-text.ts`, and `execution.ts` helpers).

---

## Two-layer config

`.splitbrief/config.yaml` declares **`version: 3`** — the only accepted version. Two top-level role blocks matter:

```yaml
version: 3
planner:     # discriminated union on `kind` — cli | api | shell | agent | agent-sdk
  kind: cli
  tool: claude-code
  model: claude-opus-4-5

implementer: # same five kinds
  kind: api
  provider: ollama
  service: ollama
  offering: local
  model: qwen2.5-coder:7b
  apiBase: http://localhost:11434/v1
```

Optional `implementerProfiles` add named implementer configs that task routing and recovery select between, while preserving the same single implementer role. Schemas: `src/core/schemas/planner-config.ts`, `src/core/schemas/implementer-config.ts`. Any config version other than 3 is rejected at load.
