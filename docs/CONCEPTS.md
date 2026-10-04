# SPLITBRIEF — Concepts & Glossary

Shared vocabulary for anyone (human or AI agent) reading the codebase. All terms here are used throughout `src/` and the other docs in this folder.

---

## Core idea

SPLITBRIEF is a CLI that splits AI coding work across two roles:

- A **planner** — an expensive, high-quality model (Claude Code, Codex, GPT-4-class, …) does the *thinking*: researches the codebase and answers one typed plan, whose tasks become the Task Briefs.
- An **implementer** — a weaker **model**, reached either as a CLI tool running a cheap model or as an API model (Ollama, LM Studio, a custom endpoint) — does the *typing*: turns each task from the list into code, one task at a time. Both transports are first-class; SPLITBRIEF favours neither.

The orchestrator in the middle owns the workflow: it runs the planner, persists the plan and the Task Brief transport, walks through tasks, validates each one (`typecheck → lint → tests`), records evidence and checkpoint boundaries, and consults the planner when the implementer gets stuck. Git staging and commits belong to the user.

The goal is a change that holds up: the tool that wrote the code never signs it off, and a deterministic pipeline — not the implementer's own opinion — decides whether the task passed. Lower total cost follows from the split; it is a reported outcome, not the promise.

The **pipeline spec** (`src/core/pipeline-spec/`) is where that pipeline's countable rules live — the brief grouping rule, the retry count, the ladder, the bounds, the timeouts, the gate order, the halt signatures, the review cycle cap. The orchestrator imports them and the portable agent skills are rendered from them, so the two cannot drift; `npm run skills:check` fails when they do.

---

## Roles

### Planner

The "smart" side. Its responsibilities, in order:

1. **Research** the project (read files, understand existing patterns).
2. **Answer one typed plan** (`PlanAnswerSchema`) — acceptance criteria, checks, validation commands and tasks. SPLITBRIEF validates it, writes `plan.json`, and renders `plan.md` and `tasks.md` from it; each task is one Task Brief, the durable execution contract for its part of the change.
3. **Review** the entire diff at the end against the plan and its Task Briefs (when no reviewer is configured, the planner holds the review seat).
4. **Consult** — when the implementer fails a task's attempt and its one retry (or reports `blocked`, or its inputs turn stale), the planner answers one read-only typed consult: guidance, a rewritten brief, a split into subtasks, a re-run of the named checks, or one question for the user. A spent bound enters explicit recovery.

The planner also supports **clarifying questions**: it can ask the user questions before it answers the plan. The questions are part of the typed answer (`PlanResultSchema`), so every planner can ask them.

### Implementer

The "typing" side. Responsibilities:

1. Receive a self-contained task prompt (signature, types, tests, constraints, implementation steps, code context).
2. Produce code: either whole-file write or search/replace markers.
3. Return code for SPLITBRIEF to write (`api`, `shell`), or write directly (`cli`, `agent`). Both paths use the run workspace.

**Isolation directory**: the run workspace used by every writer. See [Run workspace](#run-workspace) and [isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks).

The implementer is *stateless per task*. No conversation is maintained between tasks. This is deliberate: atomic tasks keep the context small enough to fit in an 8K model.

### Orchestrator

The middle layer. Zero React, zero Ink — pure logic in `src/engine/orchestrator/`. Owns:

- The state machine (see `docs/WORKFLOW.md`).
- Disk writes (`plan.json`, `plan.md` and `tasks.md` as the plan and its renderings, `sessions/<id>/state.json`, `sessions/<id>/session.jsonl`).
- Validation pipeline (`typecheck → lint → tests`).
- Filesystem snapshots and manual Git review. An index checkpoint is a retired Git feature; filesystem snapshots remain supported.
- Event emission through the EventBus to subscribed sinks: TUI, JSONL, logger, stdout JSON, and hooks.

---

## Runner kinds

Both the planner and the implementer are configured with a `kind` field. There are four kinds — each corresponds to a different way of invoking a model. The factory in `src/engine/runners/factory.ts` dispatches on this field.

| Kind | What it is | Example | Write mode as implementer | When to use |
|------|-----------|---------|---------------------------|-------------|
| `cli` | A known CLI tool invoked as a subprocess (stream-json or jsonl parsed) | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor` | `direct` | Default planner path; uses existing subscriptions. As an implementer, one of the two first-class transports — a known tool pointed at a smaller model |
| `api` | Any OpenAI-compatible HTTP endpoint | Ollama, LM Studio, custom endpoint | `extracted-code` | The other first-class implementer transport — a weaker model behind an endpoint, local or remote |
| `shell` | An arbitrary command. Prompt → stdin, code → stdout. No shell/network sandbox | Any custom script | `extracted-code` | Users who want to plug in a tool we don't know |
| `agent` | A command that writes files directly to disk. No stdout extraction or shell/network sandbox | A complete coding agent used as an implementer | `direct` | When the tool handles file writing itself |

Write mode follows the runner kind. Config rejects a `capabilities.writesFiles` value that differs from the kind's mode. See [Write modes](./PLANNERS-AND-IMPLEMENTERS.md#write-modes). [Run workspace and Apply](./HOW-IT-WORKS.md#run-workspace-and-apply) defines their execution directory.

All four kinds implement the same `Planner` / `Implementer` interface (`src/engine/planners/types.ts`, `src/engine/implementers/types.ts`). The orchestrator doesn't care which kind is active.

---

## Planning session

Every run plans in one typed planning session (`src/engine/orchestrator/planning/session.ts`). The planner may ask up to 3 questions per round, each with a default, for at most 2 rounds; then it answers one typed plan (`PlanAnswerSchema`): criteria, checks and tasks. SPLITBRIEF checks the plan (`checkPlan` plus the context fit), sends a failing plan back once, writes `plan.json`, and renders `plan.md` and `tasks.md` from it. There are no workflow modes: `workflow.mode` is a retired key that loads with one notice, and the CLI has no `--mode` flag. Full flow: [WORKFLOW.md §3](./WORKFLOW.md#3-the-planning-session).

---

## Phases

A workflow is a state machine. Each state is a **phase**. Full definitions live in `src/core/state/machine.ts`; cancel/resume semantics in `src/core/phases.ts`.

```
idle
 ├─► planning          (the planning session: questions, typed plan, checks)
 │   └─► reviewing-plan   (the plan card waits for the user; skipped with approve: none)
 ├─► implementing      (implementer is working on current task)
 │   └─► validating-task  (typecheck → lint → tests running)
 │       └─► escalating   (retry spent → the planner's consult, then recovery)
 ├─► final-review      (review seat reads the whole diff against the briefs and the request)
 └─► complete
```

The retired phases `researching`, `specifying`, `reviewing-spec`, `clarifying`, `constitution-check`, `reviewing-briefs` and `analyzing` stay in the enum so older states load; such a run continues as one planning session.

**Live phases** (Stop now aborts the active call): `planning`, `implementing`, `escalating`, and `final-review`.

**Run status** (`src/core/sessions/run-status.ts`): `running`, `open`, `ready-to-apply` or `closed`. `deriveRunStatus` supplies the one answer to every listing, guard and screen. [WORKFLOW.md](./WORKFLOW.md#run-status) defines the rules, closure outcomes and older-run compatibility.

**Stop reason**: why an open run came to rest — `paused` (at a boundary or mid-step), `waiting` (at the plan card, or at an older run's spec or briefs gate), `halted` (a pending recovery), `failed` (the run recorded a failure) or `interrupted` (nothing said why). The session listing carries it as `stop` and the row spells it as one word.

**Step** (`StepRef`, `src/core/schemas/run-step.ts`): a planner call, gate, brief attempt, review cycle or Apply. Older planner and gate names remain readable. `resumeStep(state)` names the next step. Planning continues as one session.

**Closed**: a run that cannot continue. Workspace runs close as `applied`, `discarded` or `ended`. Older passed runs keep `complete`. Closing preserves unapplied work through [the shared close path](./WORKFLOW.md#apply).

**Continuing a run**: `continueRun` (`src/engine/orchestrator/run/continue.ts`) is the one path. A park this process still holds settles in place; a run at rest is re-entered on its saved state with what the operator typed riding along as a *steer*, folded into the step's own prompt rather than replacing it. A cold crash mid-generation loses the stream, not the run: the step loop picks up at the first artifact it has not written.

**Continuation / steer**: the operator's words for the step a stop cut. A continuation never replaces the step's prompt — `composeContinuation` (`src/engine/spec/prompts/continuation.ts`) trails the partial and the steer behind the real prompt, and the planner with a native session gets one extra user turn on the conversation it already ran the step on.

**`awaitingContinue`**: the boolean the state carried before `interruptedStep` existed. It still parses and still reads as parked, but `interruptedStep` is the field that says *which* step and *where* the cut landed.

---

## Run workspace

The **run workspace** is one worktree or staged copy shared by all tasks, retries, checks and code reviews. The checkout receives the run result at Apply. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) defines its creation and data flow.

**Workspace-base** is the named snapshot captured when the run workspace is created. Apply uses it as the merge base. It includes captured uncommitted files. See [the three Apply states](./HOW-IT-WORKS.md#run-workspace-and-apply).

**Ready to apply** means the workspace result awaits Apply or Discard. A passing review or owner override can produce this status. It has no unresolved recovery. It is not continued: choose Apply or Discard. See [Run status](./WORKFLOW.md#run-status).

**Apply** merges the checkout's current state into the workspace and writes the assessed candidate into the checkout once. [WORKFLOW.md](./WORKFLOW.md#apply) owns its sequence and safeguards.

**Discard** closes the workspace run without writing its result into the checkout. The shared close path first preserves its work. See [Apply](./WORKFLOW.md#apply).

**Run.patch** is the patch of unapplied workspace work at `.splitbrief/sessions/<id>/run.patch`. Discard and End run preserve it before workspace removal. See [Apply](./WORKFLOW.md#apply) and [patch recovery](./TROUBLESHOOTING.md#symptom-i-discarded-or-ended-a-run-and-need-its-work).

---

## Task briefs

A **Task Brief** is the atomic semantic unit of implementation. It is transported in `tasks.md` and parsed into structured objects by `src/engine/spec/tasks/parse.ts`.

- **slice** — what one brief covers: one coherent, reviewable outcome, with its tests, callers, wiring, fixtures and necessary documentation, across as many files as that outcome writes. The planner groups by `sliceRuleText()` (`src/core/pipeline-spec/brief.ts`); no brief count, file count or line count decides a boundary. What bounds one brief is the real model context and prompt transport of its runner.
- **declared set** — the paths a slice suggests: its `files`, plus every path token its `scope.inBounds` and `scope.approvedOutOfBounds` bullets name. One module answers "did this brief suggest this path" for every consumer — `src/core/scope/declared-set.ts`. The set is guidance: the implementer may edit another ordinary project file when the change needs it and names it with the reason. SPLITBRIEF records such a write as touched, not suggested, for the reviewer and runs its tests; it never fails the attempt. Only a write to a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) waits for the user to confirm it.

Task fields (`src/core/schemas/task.ts`):

- `id` — branded `TaskId`, unique inside a workflow
- `file` — the slice's anchor path; the file the task creates or modifies
- `files` — every path the slice writes, the anchor among them; absent means `[file]`
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

A **stack** is the language toolchain the project's gates come from — one of five registered rows (TypeScript, JavaScript, Python, Go, Rust) in `src/core/validation/stacks/`, each naming that language's typecheck, lint and test commands and the file patterns that detect it. A command resolves through `config → manifest → discovered → stack default → none`; a project that matches no stack runs review-only and says so (`gates: NONE — review-only`).

1. **Type-check** — the configured, discovered, or heuristic command. The built-in `npx tsc --noEmit` default applies only on TypeScript projects (a `tsconfig.json` exists or `typescript` is a dependency); on other languages the stage is skipped when nothing else resolves.
2. **Lint** — the configured, discovered, or heuristic command; the stage is skipped when no lint command resolves.
3. **Tests** — the configured, discovered, or heuristic command, falling back to `npm test`.

A stage that resolves to no command is recorded as *skipped* (not a pass). When every enabled stage is skipped, the run emits a warning so a nothing-validated task is not mistaken for all-green.

A failing stage that was already red at baseline is a third outcome: *failed but pre-existing*. It is recorded separately from skipped — a missing linter and a broken linter do not read the same — and it does not fail the task when the failure names none of the task's changed files. The evidence ledger marks such entries `baselineExempt` and records a `failed (pre-existing)` observed-evidence line so the exemption stays reviewable after the run.

Each step stops at the first failure *attributable to the task* and reports it back to the orchestrator, which either retries or consults the planner. A stage that was already red at baseline continues the pipeline so the stages behind it still get a verdict, and never produces a retry prompt.

---

## Retry & consult

On validation failure:

- **One local retry**: the implementer retries once with the exact error message appended to its context. No planner involvement. The rung ends early on the first attempt that read the feedback and still changed nothing; the consult is asked instead. `DEFAULT_LOCAL_RETRIES` is 1 (`src/core/pipeline-spec/retries.ts`), and `workflow.max_retries` is retired with one notice.
- **The consult**: one read-only typed call on the planner's own session (`requestConsult`, `src/engine/orchestrator/consult/request.ts`; schema `src/core/schemas/consult.ts`). The planner answers exactly one action — `guidance` (one more implementer attempt carrying the instructions), `rewrite-task` (the brief replaced at the same id, `revision` +1, the current attempt rolled back), `split-task` (2–4 subtasks at the next free ids, dependents re-pointed), `verify` (validation and the named checks run with no implementer call; a clean run completes the task as `consulted`) or `ask-user` (the only question the ladder asks). A `blocked` report or a stale input goes to the consult without the local retry.
- **The bounds** (`src/core/pipeline-spec/bounds.ts`): 2 consults and 8 attempts per lineage, 10 planner calls per run. A spent bound halts with `consult-bound-spent` or `planner-calls-spent`; `continue` grants +1 consult and +4 attempts, or +5 planner calls.
- **Recovery** follows a spent bound or a ladder that cannot continue. The planner never automatically takes over code-writing implementation.

Ladder logic: `src/engine/orchestrator/escalation/handle.ts`; seat trouble (transient retries, a ≤10-minute reset wait, the 20-minute no-progress cut) in `src/engine/runners/transient.ts` and `src/engine/orchestrator/escalation/seat-wait.ts`.

---

## Approval gates

User-facing pauses where the workflow waits for explicit input.

- **Plan card** — after the plan passes its checks, before `implementing`. Active with `workflow.approve: plan` (the default); `approve: none` skips it. Rows: approve (also confirms the protected writes the plan lists), request changes (the planning session revises the plan, then the card opens again), edit `plan.json` (re-validated; an invalid edit is not applied), end run (`CLOSE_RUN`).
- **Protected-path confirmation** — during the build, a write to a protected path asks once per path per run, unless the approved plan listed it.

Implementation: `runPlanApproval` (`src/engine/orchestrator/planning/session.ts`) via `callbacks.onApprovalNeeded`.

---

## Clarifying questions

A planning-session turn answers either `{ kind: 'questions' }` or `{ kind: 'plan' }` (`PlanResultSchema`, `src/core/schemas/plan.ts`). A round carries at most 3 questions, each with a default, and a session takes at most 2 rounds (`MAX_QUESTION_ROUNDS`, `src/engine/orchestrator/planning/plan-session.ts`); a third round halts the run with `plan-questions-exhausted`. An empty `⏎` takes the defaults.

The questions are persisted in `state.pendingPlannerConversation` before waiting, and the answers before the next planner call. The answers go back on the same native planner session when the tool has one. Stopping leaves the round pending; recorded answers are not asked again. Headless runs emit `input_required` and exit non-zero instead of answering. See [WORKFLOW.md](./WORKFLOW.md#clarification-questions).

---

## Skills

Optional markdown files that provide extra context to every seat — planner, implementer and reviewer (coding standards, domain knowledge, architectural notes). `src/engine/skill-discovery.ts` scans one fixed union of roots, regardless of which tool holds the PLAN seat: eight project roots — `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `./.github/skills/`, `./.commandcode/skills/`, `./.kilo/skills/`, `./.kilocode/skills/`, `./.cursor/skills/` — then nine global ones — `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.commandcode/skills/`, `~/.kilo/skills/`, `~/.config/kilo/skills/`, `~/.cursor/skills/` (the list lives in `src/core/skills/scan-paths.ts`). That order is the precedence order — a skill id found in an earlier root wins, so project skills always outrank global ones. `<project>/AGENTS.md` is added as the `agents-root` entry when it exists. User picks which skills to include for a given run; the run renders them once into one `## Active Project Skills` block — each skill's base directory, its `SKILL.md` body and its `references/*.md` under a 16 000-character budget — and every seat call carries it: the planning steps, each implementer brief and its retries, the consult and the final review.

The implementer still never sees the planner's prompt: it gets the skills through its own brief prompt, beside the resolved Task Brief.

---

## Sessions (SPLITBRIEF sessions, not planner sessions)

A **SPLITBRIEF session** is one self-contained piece of work from initial feature prompt to final summary. Every session lives in its own folder under `.splitbrief/sessions/<session-id>/`, where `<session-id>` has the form `<ISO-date>-<slug>` (e.g. `2026-04-14-add-email-validator`). Same-day slug collisions get a `-N` suffix (`2026-04-14-add-email-validator-2`).

The active session is pointed to by `.splitbrief/active`, a plain text file containing the session-id. Only **one session can be active at a time** in a given project directory — `splitbrief start` fails if `.splitbrief/active` already points at a live session. Users who want to run truly parallel workflows should use separate git worktrees, which naturally isolate `.splitbrief/` per working directory.

This is distinct from a **planner session** — e.g. the `session_id` Claude Code stream-json emits — which is a backend-specific conversation handle. Planner session ids are persisted inside `state.json` so they can be reused on resume (see `docs/WORKFLOW.md` §1.5). One SPLITBRIEF session may own several planner session ids over its lifetime (e.g. if the first expired and a fresh one was opened in its place).

## Queue & Interjection

The **queue** is a workflow-scoped buffer of user messages that the user types while the planner is actively generating. The engine stores queued messages on `WorkflowState.messageQueue`; the TUI stores only the pending queue depth in the workflow lifecycle store. It solves the problem of "I want to add something without restarting the phase".

Flow:

1. During a live planner phase, the TUI composer accepts text. Pressing **Enter with text** appends the message to the queue — it does **not** abort the current call.
2. At the next safe point (end of current planner call, boundary between phases), the orchestrator drains the queue and prepends its contents to the next planner prompt as `[user also says: ...]` blocks.
3. For backends that expose a native session with mid-conversation inject (Claude Code via `--session-id`), each queued message is *also* dispatched as a parallel `user` turn into the live session. The planner sees it on its next model turn without waiting for our orchestrator to start a new phase.
4. Queue drains at safe-points only, never mid-model-output.

**Scope:** the queue is **planner-only**. Implementers (small local models) do not receive queued messages. Mid-task interjection is explicitly disallowed because small models lose coherence when their single-shot task prompt is perturbed. If the user needs to change something during implementation, they stop the current task (`ctrl+c`) and use `/redo-task <id>`.

**Message origin.** Each `QueuedMessage` carries an `origin` discriminator: `'user-input'` for text the user typed directly, and `'clarification'` for answers routed from the clarification Q&A flow. The drain block formats them differently: clarification answers use `[clarification answer during <phase>]\nQ: ...\nA: ...\n[/clarification answer]` while user-initiated interjections use the generic `[user also says during <phase>]` wrapper.

## Stop sheet

The **stop menu** opens above the composer after `esc` during a live run, preserving the draft and visible transcript. It offers **Stop now**, **Pause after this brief** (or **Keep running** when requested), and **End run**. `↑↓` selects, `Enter` executes, a second `esc` stops now, and `Tab` dismisses. Stopping preserves partial changes and allows continuation; End run explicitly closes the run.

## Awaiting-continue

A **sub-state** entered after the user stops a live model call (Stop now). Characteristics:

- Workflow phase stays what it was (`planning` / `implementing` / `escalating` / `final-review`). The abort does **not** reset the phase.
- Partial planner output up to the abort point is preserved in `session.jsonl` with `interrupted: true`.
- Orchestrator is idle, waiting for user action.
- User can: (a) type text + Enter → queued → next call proceeds with queue appended, (b) press Enter on empty input → explicit continue, next call is a `continue` turn (for Claude Code: native session next turn with `"continue"`; for stateless backends: messages array becomes `[originalPrompt, assistantPartial, "continue"]`).
- No timeout. The state is persisted to `state.json` — user can close the terminal, come back hours later, and continue from the saved session.

## Capability matrix

Each `Planner` implementation exposes a `capabilities` struct declaring what it supports:

```ts
type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;  // declared; the planning session does not read it
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
- **EventSink** — any subscriber that matches `(event: EngineEvent) => void`. Synchronous by contract, so ordering is preserved and a slow sink can delay later sinks. Shipped sinks: `jsonlSink`, `loggerSink`, optional `tuiSink`, optional `stdoutJsonSink`, and optional hook sink.
- **Phase** — `'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'clarifying' | 'constitution-check' | 'planning' | 'reviewing-plan' | 'reviewing-briefs' | 'analyzing' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete'` (`src/core/schemas/enums.ts`). Phase-bearing `EngineEvent` variants carry the current `phase` so sinks (hook dispatcher, TUI router) can filter and group without having to reconstruct workflow position from event type alone.

Gating callbacks (`onApprovalNeeded`, `onPlannerReply`, `onContinuationNeeded`, `onUserEditConflict`, `onTieredApproval`) are a **separate** mechanism — they are discrete `await`-able request/response pairs supplied by the workflow host. `onComplete(summary)` is a synchronous completion notification. Use the bus for broadcast; use callbacks for gates.

## Headless mode

`splitbrief start --json "feature"` runs the workflow without the Ink TUI. Workflow host callbacks are stubbed: the plan card is approved unattended (it confirms none of the plan's protected writes), planner questions stop the run with `input_required`, and continuations answer empty. A write to a protected path is denied with `APPROVAL_REQUIRED`; no other write asks. Events stream as NDJSON on stdout via `stdoutJsonSink` — one JSON-encoded `EngineEvent` per line, parseable by `jq` or any NDJSON consumer. Driver: `src/cli/headless.ts` → `runWorkflow({ headless: true })`. Intended for CI, logging pipelines, and programmatic integration. See [MIGRATION.md §Headless mode](./MIGRATION.md).

## Hooks (workflow)

Workflow lifecycle hooks let users run custom commands at well-known moments (pre/post task and validation, etc.). Built on top of the EventBus — `post_*`/`on_*` are a fire-and-forget sink; `pre_*` hooks run sequentially at the orchestrator call site and a `deny` outcome short-circuits the upcoming action. Hooks are declared under `hooks:` in `.splitbrief/config.yaml`. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — **not** to be confused with React hooks ([HOOKS.md](./HOOKS.md)).

- **HookEvent** — the lifecycle trigger keys (`src/core/schemas/hooks.ts`): `'pre_planning' | 'pre_task' | 'post_task' | 'pre_validation' | 'post_validation' | 'pre_escalation' | 'on_error' | 'on_complete'`. `pre_*` hooks block the upcoming action (a `deny` outcome short-circuits it); `post_*` and `on_*` hooks are fire-and-forget through the EventBus sink.
- **HookEntry** — one configured hook, `kind: 'command'`, carrying `{ command, args, timeout_ms, on_failure }`. `on_failure` is one of `'block' | 'warn' | 'ignore'`. `timeout_ms` is bounded at 300_000 ms with a 30_000 ms default.
- **HooksConfig** — the `hooks:` section of `.splitbrief/config.yaml`: a map from `HookEvent` to `HookEntry[]`.

## Hook trust

First-time trust gate for hook configs. `src/core/hooks/trust-digest.ts` computes a hash from the hook section and `src/core/hooks/trust.ts` holds the grant against that hash; `src/cli/hook-trust-prompt.ts` prompts in a TTY the first time, showing each hook's executable, the absolute path it resolves to here, and its argv, then asking `Trust these hooks for this project? [y/N]`. Answering `y` writes a receipt to `~/.splitbrief/trust/hooks.json` keyed by the canonical path of this checkout, so the grant belongs to this machine and this checkout and a repository can neither ship nor forge one. Any edit to the hooks section invalidates the hash and re-prompts. In CI (non-TTY), `--allow-hooks` is required — otherwise SPLITBRIEF refuses to start. This prevents silent RCE via a config edit.

## Repo-map

Token-budgeted codebase summary injected into the planner prompt at workflow start. Pipeline: tree-sitter parse → SQLite cache → symbol graph → PageRank → token-aware format. Lives in `src/engine/codebase/`. Opt-out via `codebase.enabled: false`. The map rebuilds itself on each planning run when the cache is stale; there is no manual rebuild step. See [REPOMAP.md](./REPOMAP.md).

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
    │   ├── plan.json                       # the checked plan the planning session answered
    │   ├── plan.md                         # the plan card's body, rendered from plan.json
    │   └── tasks.md                        # Task Brief transport, rendered from plan.json
    └── 2026-04-13-fix-auth-bug/
        └── …                               # same shape, one folder per historical session
```

Key rules:

- One session = one folder. The folder name is the session-id.
- `state.json` is what `splitbrief resume` reads to rebuild the in-memory `WorkflowState`. It is overwritten on every phase transition.
- `summary.json` is written exactly once, at end-of-run.
- `session.jsonl` is append-only and the single source of truth for history (see "Events & messages" below).
- `plan.json` is the plan; `plan.md` and `tasks.md` are rendered from it when it compiles. A run planned by an older engine also holds `research.md`, `spec.md`, `clarifications.md`, `constitution-check.json` or `analyze.json`; a new run writes none of them.
- `.splitbrief/active` holds the session-id of the session that should block another same-directory `splitbrief start`.

---

## Events & messages

Everything the orchestrator does is logged to `session.jsonl` — a single append-only JSON Lines file per session. Each line is one timestamped entry; event and message records use ISO timestamps, while summary records use the schema's accepted timestamp string/number form. The file serves three consumers: the TUI (for live and replay rendering), the resume path (for transcript rebuild when a native session is unavailable), and humans debugging a run.

Entries come in three **kinds**, distinguished by the `kind` field:

```jsonl
{"ts":"2026-04-14T10:32:00.123Z","kind":"event","type":"workflow_started","phase":"idle","data":{"feature":"add email validator"}}
{"ts":"2026-04-14T10:32:01.001Z","kind":"event","type":"planner_status","phase":"planning","data":{"status":"running"}}
{"ts":"2026-04-14T10:32:05.200Z","kind":"message","role":"assistant","phase":"planning","text":"I'll look at..."}
{"ts":"2026-04-14T10:35:30.200Z","kind":"message","role":"user","text":"Use JWT with refresh tokens"}
{"ts":"2026-04-14T10:35:45.000Z","kind":"summary","text":"User chose JWT with refresh tokens.","summarizedUpTo":"2026-04-14T10:35:30.200Z","tokenEstimate":128}
{"ts":"2026-04-14T10:36:00.000Z","kind":"event","type":"plan_approved","phase":"reviewing-plan","data":{}}
```

- `kind: "event"` — operational metadata. Workflow lifecycle, phase transitions, validation results, consult answers, artifact writes, errors. Small, always logged.
- `kind: "message"` — conversation content. User prompts, planner text chunks, clarification Q&A, approval comments, planner reviews. Text-heavy.
- `kind: "summary"` — compaction output. Contains `text`, `summarizedUpTo`, optional `tokenEstimate`, and optional `structured` data. Resume uses the latest summary as a synthetic message, then loads later messages.

Filtering happens at read time: `lines.filter(l => l.kind === 'message')`. There is no separate file for events vs. messages — this is deliberate. A log is a chronological stream, and splitting it would force consumers to merge-sort at every read while opening new crash-atomicity problems. This is the same design Claude Code uses (`~/.claude/projects/<cwd>/<id>.jsonl`), and the same pattern event-sourcing frameworks settle on.

Typed event schema: `src/engine/events/schema.ts` (`EngineEventSchema`; the `EngineEvent` alias is re-exported from `src/engine/events/types.ts`). Reader API (async iterables for log, messages, events): `src/core/sessions/log-reader.ts`. Renderer registry for the TUI: `src/features/workflow/conversation-rows/event-rows/dispatch.ts` (with `visibility.ts`, `planner-text.ts`, and `execution.ts` helpers).

---

## Two-layer config

`.splitbrief/config.yaml` declares **`version: 3`** — the only accepted version. Two top-level role blocks matter:

```yaml
version: 3
planner:     # discriminated union on `kind` — cli | api | shell | agent
  kind: cli
  tool: claude-code
  model: claude-opus-4-5

implementer: # same four kinds
  kind: api
  provider: ollama
  service: ollama
  offering: local
  model: qwen2.5-coder:7b
  apiBase: http://localhost:11434/v1
```

Optional `implementerProfiles` add named implementer configs that task routing and recovery select between, while preserving the same single implementer role. Schemas: `src/core/schemas/planner-config.ts`, `src/core/schemas/implementer-config.ts`. Any config version other than 3 is rejected at load.
