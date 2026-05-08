# diptych — Concepts & Glossary

Shared vocabulary for anyone (human or AI agent) reading the codebase. All terms here are used throughout `src/` and the other docs in this folder.

---

## Core idea

diptych is a CLI that splits AI coding work across two roles:

- A **planner** — an expensive, high-quality model (Claude Code, Codex, GPT-4-class, …) does the *thinking*: researches the codebase and compiles the request into a Task Brief, with optional supporting spec/plan artifacts when the work needs more structure.
- An **implementer** — a cheap or local model (Ollama, LM Studio, DeepSeek, …) does the *typing*: turns each task from the list into code, one task at a time.

The orchestrator in the middle owns the workflow: it runs the planner, persists the Task Brief transport and supporting artifacts, walks through tasks, validates each one (`tsc → lint → tests`), records evidence and checkpoint boundaries, and escalates back to the planner when the implementer gets stuck. Product-level git commit strategies are optional; agents working in this repository must never stage or commit.

The goal is *same planning quality, lower total cost*. Typical split: ~350K planner tokens per feature, ~$0 implementer tokens when running locally.

---

## Roles

### Planner

The "smart" side. Its responsibilities, in order:

1. **Research** the project (read files, understand existing patterns).
2. **Compile a Task Brief** — the durable execution contract for the change.
3. **Write supporting docs when needed** — `spec.md` and `plan.md` for larger, riskier, or more ambiguous work.
4. **Write `tasks.md`** — the transport format that carries one or more Task Briefs to the implementer.
5. **Review** the entire diff at the end against the Task Brief and any supporting spec.
6. **Escalate** — when the implementer fails a task 3× in a row, the planner either hints or takes over and fixes the task itself.

The planner also supports **clarifying questions**: it can pause and ask the user questions before finalizing the Task Brief and any supporting spec (only for backends that support this — see `capabilities.supportsConversationalPlanning` on `Planner` in `src/engine/planners/types.ts`).

### Implementer

The "typing" side. Responsibilities:

1. Receive a self-contained task prompt (signature, types, tests, constraints, implementation steps, code context).
2. Produce code: either whole-file write or search/replace markers.
3. Return that code to the orchestrator — it never touches disk directly.

The implementer is *stateless per task*. No conversation is maintained between tasks. This is deliberate: atomic tasks keep the context small enough to fit in an 8K model.

### Orchestrator

The middle layer. Zero React, zero Ink — pure logic in `src/engine/orchestrator/`. Owns:

- The state machine (see `docs/WORKFLOW.md`).
- Disk writes (`tasks.md` as Task Brief transport, optional `spec.md` / `plan.md`, `sessions/<id>/state.json`, `sessions/<id>/session.jsonl`).
- Validation pipeline (`tsc → lint → tests`).
- Optional git checkpoint/commit strategy when explicitly configured.
- Event emission to the TUI.

---

## Runner kinds

Both the planner and the implementer are configured with a `kind` field. There are five kinds — each corresponds to a different way of invoking a model. The factory in `src/engine/runners/factory.ts` dispatches on this field.

| Kind | What it is | Example | When to use |
|------|-----------|---------|-------------|
| `cli` | A known CLI tool invoked as a subprocess (stream-json or jsonl parsed) | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` | Default planner path; uses existing subscriptions |
| `api` | Any OpenAI-compatible HTTP endpoint | Ollama, LM Studio, DeepSeek, OpenRouter, Together | Default implementer path |
| `shell` | An arbitrary command. Prompt → stdin, code → stdout | Any custom script | Users who want to plug in a tool we don't know |
| `agent` | A command that writes files directly to disk (no stdout code extraction) | A complete coding agent used as an implementer | When the tool handles file writing itself |
| `agent-sdk` | Programmatic call into the Anthropic Agent SDK (no subprocess) | `@anthropic-ai/claude-agent-sdk` | When you want SDK-level control and already have `ANTHROPIC_API_KEY` |

All five kinds implement the same `Planner` / `Implementer` interface (`src/engine/planners/types.ts`, `src/engine/implementers/types.ts`). The orchestrator doesn't care which kind is active.

---

## Workflow modes

The `workflow.mode` config field controls how many planner calls run before implementation starts and how many approval gates block on the user. Set via `--mode` CLI flag, config file, or the `/mode` slash command at runtime.

| Mode | Planner calls | Approval gates | Best for |
|------|:---:|:---:|---|
| `instant` | 1 (minimal Task Brief + task transport) | 0 | Tiny fixes, obvious one-step changes |
| `quick` | 1 (small Task Brief + task transport) | 0 | Small work that still needs a little structure |
| `standard` (default) | 4 (research → supporting spec → plan → Task Brief transport) | 1 (supporting spec) | Normal features |
| `speckit` | 7 (research → supporting spec → clarify → constitution-check → plan → analyze → Task Brief transport) | 2 (supporting spec + plan) | Large, risky, or audited work |

`full` is a legacy alias for `speckit` at the CLI/config boundary.

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
 │   └─► validating-task  (tsc → lint → tests running)
 │       └─► escalating   (validation failed 3× → planner takes over)
 ├─► final-review      (planner reviews whole diff vs Task Brief/supporting spec)
 └─► complete
```

**Cancellable phases** (Ctrl-C quits gracefully): everything except `idle` and `complete`.

**Resumable phases** (`diptych resume` picks up from here): `reviewing-spec`, `reviewing-plan`, `implementing`, `validating-task`, `escalating`, `final-review`, plus any phase with `awaitingContinue: true`. The planner-generation phases (`researching`, `specifying`, `planning`) are **not resumable** without `awaitingContinue` — if a cold crash wiped the process mid-generation, the stream is lost and the only safe behaviour is to restart the feature.

---

## Task briefs

A **Task Brief** is the atomic semantic unit of implementation. It is transported in `tasks.md` and parsed into structured objects by `src/engine/spec/parser.ts`.

Task fields (`src/core/schemas/task.ts`):

- `id` — branded `TaskId`, unique inside a workflow
- `file` — path to the file the task edits or creates
- `action` — file operation: `create` or `modify`
- `description` — longer task body
- `signature` — TypeScript signature for the function/class being added
- `typeDefs` — inlined type definitions (the planner resolves types so the implementer doesn't have to)
- `tests` — concrete test cases / acceptance criteria
- `constraints` — rules the implementer must follow
- `implementationSteps` — 3–5 step recipe for the implementation
- `status` — `pending | in_progress | done | escalated | failed | skipped`
- `currentCode` — code as it exists at task start (for whole-file / function-level context)

Task briefs are topologically sorted on dependency. Each task is independently prompt-able — the prompt sent to the implementer is fully self-contained.

---

## Validation pipeline

Runs after every implementer response. Defined in `src/engine/orchestrator/validation.ts`.

1. **Type-check** — `tsc --noEmit` (or project's equivalent).
2. **Lint** — `npm run lint` / Biome / ESLint, depending on config.
3. **Tests** — the `testCommand` from config, typically `npm test`.

Each step *stops on first failure* and reports the error back to the orchestrator, which either retries or escalates.

---

## Retry & escalation

On validation failure:

- **Attempts 1–3**: the implementer retries with the same entire context but a slightly higher temperature (+0.1 per attempt). No planner involvement.
- **After 3rd failure**: escalate.
  - **Hint escalation** (if the planner supports it — see `supportsHintEscalation`): planner reads the error, returns a short hint, implementer retries once with the hint.
  - **Full escalation**: planner takes over and writes the code itself. The task is marked `escalated` (not `done`) in the summary so you can see cost impact.

Escalation logic: `src/engine/orchestrator/escalation.ts`.

---

## Approval gates

User-facing pauses where the workflow waits for explicit input. Each gate asks: *approve / edit (with a comment) / reject*.

- **Spec gate** — after `specifying`, before `planning`. Active in `standard` and `speckit` modes.
- **Plan gate** — after `planning`, before `implementing`. Active only in `speckit` mode by default.

On a gate:

- Approve → advance.
- Comment without approve → the planner regenerates the artifact using the comment as feedback, then loops back to the gate.
- Reject without comment → cancel the workflow, return to idle.

Implementation: `src/engine/orchestrator/approval.ts` via `callbacks.onApprovalNeeded`.

---

## Clarifying questions

During `specifying`, a conversation-capable planner (Claude Code today) can emit inline questions to the user. These come through as `<!-- Q:{JSON} -->` markers in the planner's output and are parsed by `src/engine/parsers/question-parser.ts`.

Up to 5 questions per run. User can answer each, type `skip` to skip one, or type `done` to stop accepting questions.

Answered questions are appended to `spec.md` under a `## Clarifications` section when a supporting spec exists. On the next planner call (regenerate or plan phase), the planner sees them as part of the supporting-spec context.

Since spec 008, clarification answers also route through the same queue as user-initiated interjections (see §Queue & Interjection). On backends with `supportsMidStreamInjection`, the answer reaches the live session immediately; on stateless backends it is drained at the next phase boundary.

---

## Skills

Optional markdown files under `.claude/skills/` that provide extra context to the planner (coding standards, domain knowledge, architectural notes). Discovered at startup via `src/engine/skills/discovery.ts`. User picks which skills to include for a given run; selected skills are concatenated into a `skills_context` block and passed to the planner alongside the feature prompt.

Skills are planner-only. The implementer never sees them — its prompts are derived from the resolved Task Brief transport and any supporting artifacts.

---

## Sessions (diptych sessions, not planner sessions)

A **diptych session** is one self-contained piece of work from initial feature prompt to final summary. Every session lives in its own folder under `.diptych/sessions/<session-id>/`, where `<session-id>` has the form `<ISO-date>-<slug>` (e.g. `2026-04-14-add-email-validator`). Same-day slug collisions get a `-N` suffix (`2026-04-14-add-email-validator-2`).

The currently-active session is pointed to by `.diptych/active`, a plain text file containing the session-id. Only **one session can be active at a time** in a given project directory — `diptych start` fails if `.diptych/active` already points at a live session. Users who want to run truly parallel workflows should use separate git worktrees, which naturally isolate `.diptych/` per working directory.

This is distinct from a **planner session** — e.g. the `session_id` Claude Code stream-json emits — which is a backend-specific conversation handle. Planner session ids are persisted inside `state.json` so they can be reused on resume (see `docs/WORKFLOW.md` §1.5). One diptych session may own several planner session ids over its lifetime (e.g. if the first expired and a fresh one was opened on resume).

## Queue & Interjection

The **queue** is a workflow-scoped buffer of user messages that the user types while the planner is actively generating. Implemented on `workflowStore`. It solves the problem of "I want to add something without restarting the phase".

Flow:

1. During a live planner phase, the TUI composer accepts text. Pressing **Enter with text** appends the message to the queue — it does **not** abort the current call.
2. At the next safe point (end of current planner call, boundary between phases), the orchestrator drains the queue and prepends its contents to the next planner prompt as `[user also says: ...]` blocks.
3. For backends that expose a native session with mid-conversation inject (Claude Code via `--session-id`), each queued message is *also* dispatched as a parallel `user` turn into the live session. The planner sees it on its next model turn without waiting for our orchestrator to start a new phase.
4. Queue drains at safe-points only, never mid-model-output.

**Scope:** the queue is **planner-only**. Implementers (small local models) do not receive queued messages. Mid-task interjection is explicitly disallowed because small models lose coherence when their single-shot task prompt is perturbed. If the user needs to change something during implementation, they abort the current task (Ctrl-C) and use `/redo-task <id>` after updating the spec.

**Message origin.** Each `QueuedMessage` carries an `origin` discriminator: `'user-input'` for text the user typed directly, and `'clarification'` for answers routed from the clarification Q&A flow. The drain block formats them differently: clarification answers use `[clarification answer during <phase>]\nQ: ...\nA: ...\n[/clarification answer]` while user-initiated interjections use the generic `[user also says during <phase>]` wrapper.

## Awaiting-continue

A **sub-state** of any planner phase that the workflow enters after the user aborts (single Ctrl-C). Characteristics:

- Workflow phase stays what it was (`researching` / `specifying` / `planning` / `reviewing-*` / `escalating` / `final-review`). The abort does **not** reset the phase.
- Partial planner output up to the abort point is preserved in `session.jsonl` with `interrupted: true`.
- Orchestrator is idle, waiting for user action.
- User can: (a) type text + Enter → queued → next call proceeds with queue appended, (b) press Enter on empty input → explicit continue, next call is a `continue` turn (for Claude Code: native session next turn with `"continue"`; for stateless backends: messages array becomes `[originalPrompt, assistantPartial, "continue"]`).
- No timeout. The state is persisted to `state.json` — user can close the terminal, come back hours later, and `diptych resume` picks up right here.

## Capability matrix

Each `Planner` implementation exposes a `capabilities` struct declaring what it supports:

```ts
type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;  // inline clarification questions (existing)
  supportsHintEscalation: boolean;          // hint-before-direct escalation (existing)
  supportsSessionResume: boolean;           // --session-id reuse on resume
  supportsMidStreamInjection: boolean;      // parallel user turn into live session
};
```

The orchestrator reads capabilities at run start and degrades gracefully per backend. Example: Claude Code has all four; a shell planner defaults to none and gets queue + transcript-rebuild behaviour instead of native session reuse.

---

## EventBus, EngineEvent, EventSink

The engine publishes every observable step as an `EngineEvent` on a single `EventBus` (synchronous pub/sub, `src/engine/events/bus.ts`). Sinks subscribe and receive the stream in registration order. The bus is the only broadcast channel between engine and the rest of the system.

- **EngineEvent** — the discriminated union (snake_case `type`, mandatory `ts: number` and `phase: Phase`) in `src/engine/events/types.ts`. Single source of truth for every workflow event that crosses the engine boundary. Extended by adding a new variant to the union — no separate registration step. The legacy `TuiEvent` / `OrchestratorEvent` types were removed during the 2026-04 uplift.
- **EventBus** — synchronous pub/sub port declared in `src/engine/events/types.ts`, created by `createEventBus()`. `publish(event)` fans out to every subscribed sink inline, in registration order; a throw in one sink is caught and surfaced as a warning but does not break fan-out to the others.
- **EventSink** — any subscriber that matches `(event: EngineEvent) => void`. Synchronous by contract (so ordering is preserved and one slow sink cannot starve another). Four are shipped: `tuiSink` (workflow store), `jsonlSink` (session log), `stdoutJsonSink` (NDJSON on stdout for `--json`), `otelSink` (OpenTelemetry spans). The workflow hook system attaches its own sink for `post_*`/`on_*` events.
- **Phase** — `'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'clarifying' | 'constitution-check' | 'planning' | 'reviewing-plan' | 'analyzing' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete'` (`src/core/schemas/enums.ts`). Every `EngineEvent` carries the current `phase` so sinks (OTel span hierarchy, hook dispatcher, TUI router) can filter and group without having to reconstruct workflow position from event type alone.

Gating callbacks (`onApprovalNeeded`, `onQuestionAsked`, `onContinuationNeeded`, `onBudgetExceeded`, `onUserEditConflict`, `onComplete`) are a **separate** mechanism — they are discrete `await`-able request/response pairs supplied by the workflow host. Use the bus for broadcast; use callbacks for gates. `onExternalChanges` is legacy compatibility; file-aware edit handling now flows through `onUserEditConflict`.

## Headless mode

`diptych start --json "feature"` runs the workflow without the Ink TUI. All gating callbacks are stubbed (`auto-approve`, empty clarifications, continue on budget). Events stream as NDJSON on stdout via `stdoutJsonSink` — one JSON-encoded `EngineEvent` per line, parseable by `jq` or any NDJSON consumer. Driver: `src/cli/headless.ts` → `runWorkflow({ headless: true })`. Intended for CI, logging pipelines, and programmatic integration. See [MIGRATION.md §Headless mode](./MIGRATION.md).

## Hooks (workflow)

Workflow lifecycle hooks let users run custom commands or in-process modules at well-known moments (pre/post task, pre/post commit, etc.). Built on top of the EventBus — `post_*`/`on_*` are a fire-and-forget sink; `pre_*` hooks run sequentially at the orchestrator call site and a `deny` outcome short-circuits the upcoming action. Hooks are declared under `hooks:` in `.diptych/config.yaml`. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — **not** to be confused with React hooks ([HOOKS.md](./HOOKS.md)).

- **HookEvent** — the lifecycle trigger keys (`src/core/schemas/hooks.ts`): `'pre_planning' | 'post_planning' | 'pre_task' | 'post_task' | 'pre_validation' | 'post_validation' | 'pre_commit' | 'post_commit' | 'pre_escalation' | 'pre_compact' | 'on_error' | 'on_complete'`. `pre_*` hooks block the upcoming action (a `deny` outcome short-circuits it); `post_*` and `on_*` hooks are fire-and-forget through the EventBus sink.
- **HookEntry** — one configured hook: discriminated on `kind: 'command' | 'module'`. `command` entries carry `{ command, args, timeout_ms, on_failure }`; `module` entries carry `{ path, timeout_ms, on_failure }`. `on_failure` is one of `'block' | 'warn' | 'ignore'`. `timeout_ms` is bounded at 300_000 ms with a 30_000 ms default.
- **HooksConfig** — the `hooks:` section of `.diptych/config.yaml`: a map from `HookEvent` to `HookEntry[]`, plus an optional `builtin: Record<string, boolean>` toggles block for shipped hooks (e.g. `prettier-on-change`, `block-secrets`).

## Hook trust

First-time trust gate for hook configs. `src/core/hooks/trust.ts` computes `sha256(canonical-JSON)` of the hook section; `src/cli/hook-trust-prompt.ts` prompts in a TTY the first time (`Trust these hooks for this project? [y/N]`) and stores the accepted hash in `.diptych/hook-trust.json`. Any edit to the hooks section invalidates the hash and re-prompts. In CI (non-TTY), `--allow-hooks` is required — otherwise diptych refuses to start. This prevents silent RCE via a config edit.

## Repo-map

Token-budgeted codebase summary injected into the planner prompt at workflow start. Pipeline: tree-sitter parse → SQLite cache → symbol graph → PageRank → token-aware format. Lives in `src/engine/codebase/`. Opt-out via `codebase.enabled: false`. Force a rebuild with `/repomap rebuild` in the TUI. See [REPOMAP.md](./REPOMAP.md).

- **RepoMapOptions** — options to `buildRepoMap(projectDir, opts)` in `src/engine/codebase/repomap.ts`: `{ projectDir, tokenBudget?, include?, exclude?, focusFiles? }`. `tokenBudget` defaults to 4000. `include`/`exclude` default to `['src/**/*.ts', 'src/**/*.tsx']` minus tests, `dist/`, and `node_modules/`. `focusFiles` boosts the PageRank personalization vector for files the planner already knows are relevant.

---

## Artifacts on disk

All workflow state lives under `.diptych/` in the target project. Each session gets its own self-contained folder.

```
.diptych/
├── config.yaml                             # user config (version: 3)
├── active                                  # plain text: session-id of the currently-active run (or absent)
└── sessions/
    ├── 2026-04-14-add-email-validator/
    │   ├── state.json                      # mutable: phase, tasks, currentTaskIndex, tokenUsage, plannerSessionId
    │   ├── session.jsonl                   # append-only log: type-tagged events + messages
    │   ├── summary.json                    # written once at end of run (Summary: tokens, cost, timings, outcomes)
    │   ├── spec.md                         # supporting artifact (optional)
    │   ├── plan.md                         # supporting artifact (optional)
    │   └── tasks.md                        # Task Brief transport
    └── 2026-04-13-fix-auth-bug/
        └── …                               # same shape, one folder per historical session
```

Key rules:

- One session = one folder. The folder name is the session-id.
- `state.json` is what `diptych resume` reads to rebuild the in-memory `WorkflowState`. It is overwritten on every phase transition.
- `summary.json` is written exactly once, at end-of-run.
- `session.jsonl` is append-only and the single source of truth for history (see "Events & messages" below).
- `tasks.md` is the human-readable Task Brief transport. `spec.md` and `plan.md` are supporting artifacts written when the corresponding planner phase needs them. They are **always** written when produced, regardless of `workflow.persistTranscript`.
- `.diptych/active` holds the session-id of whichever session is currently running. Its presence acts as a lock against a second concurrent `diptych start` in the same project directory.

---

## Events & messages

Everything the orchestrator does is logged to `session.jsonl` — a single append-only JSON Lines file per session. Each line is one entry with an ISO timestamp. The file serves three consumers: the TUI (for live and replay rendering), the resume path (for transcript rebuild when a native session is unavailable), and humans debugging a run.

Entries come in two **kinds**, distinguished by the `kind` field:

```jsonl
{"ts":"2026-04-14T10:32:00.123Z","kind":"event","type":"workflow_started","feature":"add email validator"}
{"ts":"2026-04-14T10:32:01.001Z","kind":"event","type":"phase","phase":"researching"}
{"ts":"2026-04-14T10:32:05.200Z","kind":"message","role":"assistant","phase":"researching","text":"I'll look at..."}
{"ts":"2026-04-14T10:35:00.000Z","kind":"event","type":"clarification_asked","questionId":"q1"}
{"ts":"2026-04-14T10:35:30.200Z","kind":"message","role":"user","text":"Use JWT with refresh tokens"}
{"ts":"2026-04-14T10:36:00.000Z","kind":"event","type":"spec_written","path":"spec.md","bytes":2340}
```

- `kind: "event"` — operational metadata. Workflow lifecycle, phase transitions, validation results, escalation triggers, artifact writes, errors. Small, always logged.
- `kind: "message"` — conversation content. User prompts, planner text chunks, clarification Q&A, approval comments, planner reviews. Text-heavy, **opt-outable** via `workflow.persistTranscript: false` (default `true`).

Filtering happens at read time: `lines.filter(l => l.kind === 'message')`. There is no separate file for events vs. messages — this is deliberate. A log is a chronological stream, and splitting it would force consumers to merge-sort at every read while opening new crash-atomicity problems. This is the same design Claude Code uses (`~/.claude/projects/<cwd>/<id>.jsonl`), and the same pattern event-sourcing frameworks settle on.

Typed event schema: `src/core/types/events.ts`. Reader API (async iterables for log, messages, events): `src/core/sessions/log-reader.ts`. Renderer registry for the TUI: `src/components/event-cards/index.tsx`.

---

## Two-layer config

`.diptych/config.yaml` has **`version: 3`** in current configs. `version: 2` is accepted and migrated for backwards compatibility, but new examples should use v3. Two top-level role blocks matter:

```yaml
version: 3
planner:     # discriminated union on `kind` — cli | api | shell | agent | agent-sdk
  kind: cli
  tool: claude-code
  model: claude-opus-4-5

implementer: # same five kinds
  kind: api
  provider: ollama
  model: qwen2.5-coder:7b
  apiBase: http://localhost:11434/v1
```

Optional `implementerProfiles` add named cheap/local/fallback implementer configs for routing while preserving the same single implementer role. Schemas: `src/core/schemas/planner-config.ts`, `src/core/schemas/implementer-config.ts`. `version: 1` and `version: 2` configs are migrated automatically by `src/core/config/load/migrate.ts`.
