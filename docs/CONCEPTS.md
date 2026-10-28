# SPLITBRIEF — Concepts & Glossary

Shared vocabulary for anyone (human or AI agent) reading the codebase. All terms here are used throughout `src/` and the other docs in this folder.

---

## Core idea

SPLITBRIEF is a CLI that splits AI coding work across two roles:

- A **planner** — an expensive, high-quality model (Claude Code, Codex, GPT-4-class, …) does the *thinking*: researches the codebase and answers one typed plan, whose tasks become the Task Briefs.
- An **implementer** — a weaker **model**, reached either as a CLI tool running a cheap model or as an API model (Ollama, LM Studio, a custom endpoint) — does the *typing*: turns each task from the list into code, one task at a time. Both transports are first-class; SPLITBRIEF favours neither.

The orchestrator in the middle owns the workflow: it runs the planner, persists the plan and the Task Brief transport, walks through tasks, validates each one (its checks, then the reviewer checks before the review), records evidence and checkpoint boundaries, and consults a seat when the implementer gets stuck: the planner for a plan task, the review seat for a fix task. Git staging and commits belong to the user.

The goal is a change that holds up: the tool that wrote the code never signs it off, and a deterministic pipeline — not the implementer's own opinion — decides whether the task passed. Lower total cost follows from the split; it is a reported outcome, not the promise.

The **pipeline spec** (`src/core/pipeline-spec/`) is where that pipeline's countable rules live — the brief grouping rule, the retry count, the ladder, the bounds, the timeouts, the test check narrowing rule, the halt signatures. The orchestrator imports them and the portable agent skills are rendered from them, so the two cannot drift; `npm run skills:check` fails when they do.

---

## Roles

### Planner

The "smart" side. Its responsibilities, in order:

1. **Research** the project (read files, understand existing patterns).
2. **Answer one typed plan** (`PlanAnswerSchema`) — acceptance criteria, checks, validation commands and tasks. SPLITBRIEF validates it, writes `plan.json`, and renders `plan.md` and `tasks.md` from it; each task is one Task Brief, the durable execution contract for its part of the change.
3. **Review** the entire diff at the end against the plan and its Task Briefs (when no reviewer is configured, the planner holds the review seat). The review seat makes three kinds of call: the plan call that chooses the reviewer checks (`runReviewChecks`, `src/engine/orchestrator/review-checks.ts`), the verdict call, and the consult of a fix task.
4. **Consult** — when the implementer fails a task's attempt and its one retry (or reports `blocked`), one seat answers one read-only typed consult (the planner for a plan task, the review seat for a fix task the reviewer wrote): guidance, a rewritten brief, a split into subtasks, a re-run of the named checks, or one question for the user. A spent bound enters explicit recovery.

The planner also supports **clarifying questions**: it can ask the user questions before it answers the plan. The questions are part of the typed answer (`PlanResultSchema`), so every planner can ask them.

### Implementer

The "typing" side. Responsibilities:

1. Receive a self-contained task prompt (signature, types, tests, constraints, implementation steps, code context).
2. Produce code: either whole-file write or search/replace markers.
3. Return code for SPLITBRIEF to write (`api`, `shell`), or write directly (`cli`, `agent`). Both paths use the run workspace.

**Isolation directory**: the run workspace used by every writer. In checkout mode it is the checkout itself. See [Run workspace](#run-workspace) and [isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks).

The implementer is *stateless per task*. No conversation is maintained between tasks. This is deliberate: atomic tasks keep the context small enough to fit in an 8K model.

### Orchestrator

The middle layer. Zero React, zero Ink — pure logic in `src/engine/orchestrator/`. Owns:

- The state machine (see `docs/WORKFLOW.md`).
- Disk writes (`plan.json`, `plan.md` and `tasks.md` as the plan and its renderings, `sessions/<id>/state.json`, `sessions/<id>/session.jsonl`).
- Validation pipeline (plan checks, then the reviewer checks).
- Filesystem snapshots and manual Git review. An index checkpoint is a retired Git feature; filesystem snapshots remain supported.
- Event emission through the EventBus to subscribed sinks: TUI, JSONL, logger, call evidence, stdout JSON or stdout text, and hooks. See [ENGINE.md §Sinks](./ENGINE.md#sinks).

---

## Runner kinds

Both the planner and the implementer are configured with a `kind` field. There are four kinds — each corresponds to a different way of invoking a model. The factory in `src/engine/runners/factory.ts` dispatches on this field.

| Kind | What it is | Example | Write mode as implementer | When to use |
|------|-----------|---------|---------------------------|-------------|
| `cli` | A known CLI tool invoked as a subprocess (stream-json or jsonl parsed) | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity` | `direct` | Default planner path; uses existing subscriptions. As an implementer, one of the two first-class transports — a known tool pointed at a smaller model |
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
 │   └─► validating-task  (the brief's checks running)
 │       └─► escalating   (retry spent → the consult, then recovery)
 ├─► final-review      (review seat reads the whole diff against the briefs and the request)
 └─► complete
```

The retired phases `researching`, `specifying`, `reviewing-spec`, `clarifying`, `constitution-check`, `reviewing-briefs` and `analyzing` stay in the enum so older states load; such a run continues as one planning session.

**Live phases** (Stop now aborts the active call): `planning`, `implementing`, `escalating`, and `final-review`.

**Run status** (`src/core/sessions/run-status.ts`): `running`, `open`, `ready-to-apply` or `closed`. `deriveRunStatus` supplies the one answer to every listing, guard and screen. [WORKFLOW.md](./WORKFLOW.md#run-status) defines the rules, closure outcomes and older-run compatibility.

**Stop reason**: why an open run came to rest, in one of two kinds (`StopReason`, `src/core/sessions/run-status.ts`). `waiting-for-you`: the run cannot go on without an answer — a planner `question`, a `gate` (the plan card, or an older run's spec or briefs gate) or a `halt` (a pending recovery). `stopped`: the run can go on as it stands — `paused` (at a boundary or mid-step), `failed` (the run recorded a failure) or `interrupted` (nothing said why). The session listing carries the kind as `stop`, and the row spells it `waiting for you` or `stopped`. Older rows that saved `paused`, `waiting`, `halted`, `input-required`, `failed` or `interrupted` read as the kind they put the run in.

**Halt** (`RecoveryHalt`, `src/core/recovery/halt.ts`): a pending recovery as a person sees it, one of two. *Needs you*: a decision only the operator can make — a spent bound, a failed review that made no progress, a protected write, a conflict at Apply. *Seat down*: the seat cannot run — signed out, out of quota, refused its command, or answered off its contract twice. `haltOf(reason)` maps every recovery reason onto one halt, and the halt fixes the actions the reason may offer. Every surface shows `Needs you · <cause>` or `Seat down · <cause>`; the reason code stays in the issue, the events and the log.

**Fallback** (`SeatFallback`, `src/core/crew/fallback.ts`): the CLI runner a seat authorizes for one automatic switch per run and seat on an account refusal or long-reset limit. Set it in Settings › Fallback, or in `.splitbrief/config.yaml`. Its row shows a seat identity or `none · pause and ask`. REVIEW inherits PLAN's fallback until it has its own block. Each halt reads the fallback of record. An automatic switch makes the old CLI seat the fallback, or leaves none for an old non-CLI seat. A manual switch keeps it. See [Seat fallback](./FEATURES.md#seat-fallback).

**Step** (`StepRef`, `src/core/schemas/run-step.ts`): a planner call, gate, brief attempt, review cycle or Apply. Older planner and gate names remain readable. `resumeStep(state)` names the next step. Planning continues as one session.

**Closed**: a run that cannot continue. Workspace runs close as `applied`, `discarded` or `ended`, and an applied run whose Apply was undone reads `undone`. Older passed runs keep `complete`. Closing preserves unapplied work through [the shared close path](./WORKFLOW.md#apply).

**Continuing a run**: `continueRun` (`src/engine/orchestrator/run/continue.ts`) is the one path. A park this process still holds settles in place; a run at rest is re-entered on its saved state with what the operator typed riding along as a *steer*, folded into the step's own prompt rather than replacing it. A cold crash mid-generation loses the stream, not the run: the step loop picks up at the first artifact it has not written.

**Continuation / steer**: the operator's words for the step a stop cut. A continuation never replaces the step's prompt — `composeContinuation` (`src/engine/spec/prompts/continuation.ts`) trails the partial and the steer behind the real prompt, and the planner with a native session gets one extra user turn on the conversation it already ran the step on.

**`awaitingContinue`**: the boolean the state carried before `interruptedStep` existed. It still parses and still reads as parked, but `interruptedStep` is the field that says *which* step and *where* the cut landed.

---

## Run workspace

The **run workspace** is one worktree or staged copy shared by all tasks, retries, checks and code reviews. The checkout receives the run result at Apply. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) defines its creation and data flow.

**Checkout mode** is `workflow.isolation: none`. The implementer of every transport works in your checkout itself, and checks and review run there. Readiness warns about uncommitted changes and names the `reverted/` backup folder. An attempt revert restores only paths that attempt changed and leaves your other uncommitted files untouched. The run records `workspace.kind: 'checkout'` once. It has no Apply: a passing review closes it, and closing it writes no `run.patch`. Every revert SPLITBRIEF makes there first saves the replaced bytes under `.splitbrief/sessions/<id>/reverted/<stamp>/`. See [Implementer isolation](./CONFIGURATION.md#implementer-isolation).

**Staged copy** is one project copy per run. It is the `staged-copy` value and the fallback when the worktree is unavailable. Its task-start and attempt snapshots are **entry snapshots**: each file's hash and mode, with the bytes stored once in the content-addressed store `.splitbrief/sessions/<id>/entries/`. They need no git, so a no-git project runs and restarts from that store. A no-git checkout in checkout mode uses the same snapshots.

**Workspace-base** is the named snapshot captured when the run workspace is created. Apply uses it as the merge base. It includes captured uncommitted files. See [the three Apply states](./HOW-IT-WORKS.md#run-workspace-and-apply).

**Ready to apply** means the workspace result awaits Apply or Discard. A passing review or an Accept as is override can produce this status. It has no unresolved recovery. It is not continued: choose Apply or Discard. See [Run status](./WORKFLOW.md#run-status).

**Apply** merges the checkout's current state into the workspace and writes the assessed candidate into the checkout once. [WORKFLOW.md](./WORKFLOW.md#apply) owns its sequence and safeguards.

**Discard** closes the workspace run without writing its result into the checkout. The shared close path first preserves its work. See [Apply](./WORKFLOW.md#apply).

**Run.patch** is the patch of unapplied workspace work at `.splitbrief/sessions/<id>/run.patch`. Discard and End run preserve it before workspace removal. See [Apply](./WORKFLOW.md#apply) and [patch recovery](./TROUBLESHOOTING.md#symptom-i-discarded-or-ended-a-run-and-need-its-work).

---

## Task briefs

A **Task Brief** is the atomic semantic unit of implementation. SPLITBRIEF renders the plan tasks as Markdown in `tasks.md`.

- **slice** — what one brief covers: one coherent, reviewable outcome, with its tests, callers, wiring, fixtures and necessary documentation, across as many files as that outcome writes. The planner groups by `sliceRuleText()` (`src/core/pipeline-spec/brief.ts`); no brief count, file count or line count decides a boundary. What bounds one brief is the real model context and prompt transport of its runner.
- **declared set** — the paths a slice suggests: its `suggestedFiles`, plus every path token its `scope.inBounds` and `scope.approvedOutOfBounds` bullets name. One module answers "did this brief suggest this path" for every consumer — `src/core/scope/declared-set.ts`. The set is guidance: the implementer may edit another ordinary project file when the change needs it and names it with the reason. SPLITBRIEF records such a write as touched, not suggested, for the reviewer and runs its tests; it never fails the attempt. Only a write to a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) waits for the user to confirm it.

Task fields are defined in `src/core/schemas/task.ts`. See [TASK-CONTRACT.md](./TASK-CONTRACT.md) for the complete contract.

- `id` — branded `TaskId`, unique inside a workflow
- `suggestedFiles` gives the suggested paths, with the anchor first. TaskSchema folds saved `file` and `files` fields into this field.
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

Runs the plan's checks after a brief (`src/engine/orchestrator/validation/run-checks.ts`) and the reviewer checks before a review (`src/engine/orchestrator/review-checks.ts`).

A **stack** is the language toolchain a planner `test` check takes its command from — one of five registered rows (TypeScript, JavaScript, Python, Go, Rust) in `src/core/validation/stacks/`, each naming that language's test command, its test file patterns and the marker files that detect it. The command resolves through `config → manifest → discovered → stack default → none`; on a project that matches no stack, a `test` check without `validation.test_command` is `not-runnable` and says so. The **reviewer checks** do not resolve through a stack: before a review the reviewer reads the project and chooses the reviewer checks (`V1`, `V2`, …) that verify the change. SPLITBRIEF runs them under the **reviewer command policy** (`validation.end_checks`, Settings: End-of-run checks). That policy runs any installed program of any language and refuses only what breaks a danger rule: shell syntax, a program run by path (the project's root `./gradlew` and `./mvnw` run while this run changed none of their wrapper files), inline code, a download-and-run launcher, a setup command, or a package script, task file, build wrapper or interpreter script this run changed or the run base does not hold. Every refused command gets a named row. A plan `cmd` check keeps the **plan command policy**, whose allowlist holds the package managers, `make` and `just` on a bare `typecheck`, `lint` or `test` target, the tools of the five stacks, and `test -e`, `-f`, `-x` or `-L` on one workspace file.

1. **Plan checks** — with `workflow.review: task`, the brief gate runs the task's checks and its due checks after each hand-back; with `end`, a brief runs its own checks, except renders. Before the final review every registered plan and task check runs, including renders.
2. **Reviewer checks** — before each review the reviewer makes the plan call. It chooses at most 6 reviewer checks with a reason each, names each related test it declines, or gives the reason it chose none. With **Approve checks** set to `ask` (`validation.approve_checks`), one card asks Run all or Skip all first; a skipped reviewer check is never a pass. SPLITBRIEF runs them in order under the reviewer command policy, which also refuses a reviewer check whose package script, task file, build wrapper or interpreter script this run changed or the run base does not hold. A failed plan call (a transport error or a protocol error) halts the review the same way a failed verdict call does; it is never a pass. With End-of-run checks off, no reviewer check runs; plan and task checks still run.
3. **Stop rule** — the first reviewer check with new failures stops the list; each later reviewer check reads `not run · <id> failed`.

A test check that resolves to no command is `not-runnable` (not a pass); a required one halts with `required-checks-unrunnable`. When the stack narrows the test command to the check's file and the workspace holds no test file for it, the check fails, so the builder or the reviewer answers it. An explicit `validation.test_command`, a discovered command and a `package.json` test script that chains commands run as written, without adding the check's file, so such a check runs the whole command and can pass.

A red reviewer check whose failures are also red on a disposable run base copy, with the same command text, is *failed but pre-existing*. The base check runs only after a red. The evidence ledger carries `preExisting` keys in check entries, and the base re-run's exit code and output in `base`. The Checks Log reports these keys to the reviewer, and only new failures become pending inputs. A timeout, or a red with no failing test name and no diagnostic line, has no key to compare. When the base re-run is red too, such a red is *not verified at the run base*: it stays new, becomes a pending input, and the reviewer decides.

---

## Retry & consult

On validation failure:

- **One local retry**: the implementer retries once with the exact error message appended to its context. No planner involvement. The rung ends early on the first attempt that read the feedback and still changed nothing; the consult is asked instead. `DEFAULT_LOCAL_RETRIES` is 1 (`src/core/pipeline-spec/retries.ts`), and `workflow.max_retries` is retired with one notice.
- **The consult**: one read-only typed call (`requestConsult`, `src/engine/orchestrator/consult/request.ts`; schema `src/core/schemas/consult.ts`). `consultSeat` chooses the seat: a plan task consults the planner on the planner's own session, and a fix task (`task.fix`) consults the review seat in one stateless call. The seat answers exactly one action — `guidance` (one more implementer attempt carrying the instructions), `rewrite-task` (the brief replaced at the same id, `revision` +1, the current attempt rolled back), `split-task` (2–4 subtasks at the next free ids, dependents re-pointed), `verify` (validation and the named checks run with no implementer call; a clean run completes the task as `consulted`) or `ask-user` (the only question the ladder asks). A `blocked` report goes to the consult without the local retry.
- **The bounds** (`src/core/pipeline-spec/bounds.ts`): 2 consults and 8 attempts per lineage, 10 planner calls per run. A spent bound halts with `consult-bound-spent` or `planner-calls-spent`; `continue` grants +1 consult and +4 attempts, or +5 planner calls.
- **Recovery** follows a spent bound or a ladder that cannot continue. The planner never automatically takes over code-writing implementation.

Ladder logic: `src/engine/orchestrator/escalation/handle.ts`; seat trouble (transient retries, a ≤10-minute reset wait, the opt-in `idleKillMs` cut) in `src/engine/runners/transient.ts` and `src/engine/orchestrator/escalation/seat-wait.ts`.

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

Optional markdown files that provide extra context to every seat — planner, implementer and reviewer (coding standards, domain knowledge, architectural notes). `src/engine/skill-discovery.ts` scans one fixed union of roots, regardless of which tool holds the PLAN seat: eight project roots — `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `./.github/skills/`, `./.commandcode/skills/`, `./.kilo/skills/`, `./.kilocode/skills/`, `./.cursor/skills/` — then nine global ones — `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.commandcode/skills/`, `~/.kilo/skills/`, `~/.config/kilo/skills/`, `~/.cursor/skills/` (the list lives in `src/core/skills/scan-paths.ts`). That order is the precedence order — a skill id or a skill name found in an earlier root wins, so project skills always outrank global ones. `<project>/AGENTS.md` is added as the `agents-root` entry when it exists. User picks which skills to include for a given run; the run renders them once into one `## Active Project Skills` block — each skill's base directory, its `SKILL.md` body and its `references/*.md` under a 16 000-character budget — and every seat call carries it: the planning steps, each implementer brief and its retries, the consult and the final review.

The implementer still never sees the planner's prompt: it gets the skills through its own brief prompt, beside the resolved Task Brief.

---

## Sessions (SPLITBRIEF sessions, not planner sessions)

A **SPLITBRIEF session** is one self-contained piece of work from initial feature prompt to final summary. Every session lives in its own folder under `.splitbrief/sessions/<session-id>/`, where `<session-id>` has the form `<ISO-date>-<slug>` (e.g. `2026-04-14-add-email-validator`). Same-day slug collisions get a `-N` suffix (`2026-04-14-add-email-validator-2`).

The active session is pointed to by `.splitbrief/active`, a JSON receipt `{ "version": 1, "sessionId": …, "generation": … }` (`writeActiveReceiptLocked`, `src/core/sessions/active-pointer.ts`). An older file that holds a bare session-id still reads. Only **one session can be active at a time** in a given project directory — `splitbrief start` fails if `.splitbrief/active` already points at a live session, and clears a pointer whose run is no longer alive. Users who want to run truly parallel workflows should use separate git worktrees, which naturally isolate `.splitbrief/` per working directory.

This is distinct from a **planner session** — e.g. the `session_id` Claude Code stream-json emits — which is a backend-specific conversation handle. Planner session ids are persisted inside `state.json` so they can be reused on resume (see [WORKFLOW.md §What it continues on](./WORKFLOW.md#what-it-continues-on)). One SPLITBRIEF session may own several planner session ids over its lifetime (e.g. if the first expired and a fresh one was opened in its place).

## Message queue

The **queue** stores messages that the operator sends during a live run. Each message goes to the seat of the active stage: PLAN, BUILD, or REVIEW. The engine stores messages on `WorkflowState.messageQueue`. The workflow lifecycle store keeps the queued count until each message's first delivery to any seat.

Enter with text queues a message and lets the current call continue. See [Message queue](./ENGINE.md#message-queue) for delivery rules and [Input footer](./FEATURES.md#input-footer) for the copy. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for tool support and transport details.

`ctrl+⏎` with text stops the run now and continues with the text, like `/steer <text>`. A terminal without extended keys reports this key as Enter, which queues the message. `/steer` works in every terminal.

**Message origin.** Each `QueuedMessage` carries an `origin` discriminator: `'user-input'` for text the user typed directly, and `'clarification'` for answers routed from the clarification Q&A flow. The drain block formats them differently: clarification answers use `[clarification answer during <phase>]\nQ: ...\nA: ...\n[/clarification answer]` while user-initiated interjections use the generic `[user also says during <phase>]` wrapper.

**Mid-call steering** delivers a message after the running call's current tool result. The tool continues without interruption. Claude Code and opencode support this path. Codex never uses it. Other seats read the message after their call.

`createSteeringPort` holds the call, and `deliverToRunningCall` sends the message. `delivered` confirms acknowledgement in that call. `deferred` leaves the message pending. `uncertain` keeps it pending with a possible duplicate warning. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for versions and transport details.

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
- **EventSink** — any subscriber that matches `(event: EngineEvent) => void`. Synchronous by contract, so ordering is preserved and a slow sink can delay later sinks. `attachRunSinks` (`src/engine/orchestrator/run/init-sinks.ts`) registers the shipped sinks in this order: the optional TUI sink (`tuiSink`), the JSONL sink (`createJsonlSink`), the logger sink (`createLoggerSink`), the call-evidence sink (`createCallEvidenceSink`, `src/engine/orchestrator/summary/call-evidence.ts`), in headless mode one stdout sink (`createStdoutJsonSink` for `--json`, `createStdoutTextSink` for `--plain`), the test-only observer `_eventSink`, and the hook sink when hooks are configured.
- **Phase** — `'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'clarifying' | 'constitution-check' | 'planning' | 'reviewing-plan' | 'reviewing-briefs' | 'analyzing' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete'` (`src/core/schemas/enums.ts`). Phase-bearing `EngineEvent` variants carry the current `phase` so sinks (hook dispatcher, TUI router) can filter and group without having to reconstruct workflow position from event type alone.

Gating callbacks (`onApprovalNeeded`, `onPlannerReply`, `onContinuationNeeded`, `onTieredApproval`, `onReviewChecksApproval`) are a **separate** mechanism — they are discrete `await`-able request/response pairs supplied by the workflow host. `onComplete(summary)` is a synchronous completion notification. Use the bus for broadcast; use callbacks for gates.

## Headless mode

`splitbrief start --json "feature"` runs the workflow without the Ink TUI. Workflow host callbacks are stubbed: the plan card is approved unattended (it confirms none of the plan's protected writes), planner questions stop the run with `input_required`, and continuations answer empty. A write to a protected path is denied with `APPROVAL_REQUIRED`; no other write asks. Events stream as NDJSON on stdout via the stdout JSON sink (`createStdoutJsonSink`) — one JSON record per line, parseable by `jq` or any NDJSON consumer. An engine event arrives as `{ "type": "event", "data": <event> }`; other record types (`input_required`, `ready_to_apply`, `warning`, `error` and more) report the run's outcome (`HeadlessJsonRecordSchema`, `src/engine/events/public-json.ts`). Driver: `src/cli/headless.ts` → `runWorkflow({ headless: true })`. Intended for CI, logging pipelines, and programmatic integration. See [MIGRATION.md §Headless mode](./MIGRATION.md).

## Hooks (workflow)

Workflow lifecycle hooks let users run custom commands at well-known moments (pre/post task and validation, etc.). Built on top of the EventBus — `post_*`/`on_*` are a fire-and-forget sink; `pre_*` hooks run sequentially at the orchestrator call site and a `deny` outcome short-circuits the upcoming action. Hooks are declared under `hooks:` in `.splitbrief/config.yaml`. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — **not** to be confused with React hooks ([HOOKS.md](./HOOKS.md)).

- **HookEvent** — the lifecycle trigger keys (`src/core/schemas/hooks.ts`): `'pre_planning' | 'pre_task' | 'post_task' | 'pre_validation' | 'post_validation' | 'pre_escalation' | 'on_error' | 'on_halt' | 'on_complete'`. `pre_*` hooks block the upcoming action (a `deny` outcome short-circuits it); `post_*` and `on_*` hooks are fire-and-forget through the EventBus sink. The retired keys `pre_commit` and `post_commit` never fire: an empty list loads and is dropped, and a list with entries fails the config load.
- **HookEntry** — one configured hook, `kind: 'command'`, carrying `{ command, args, timeout_ms, on_failure }`. `on_failure` is one of `'block' | 'warn' | 'ignore'`. `timeout_ms` is bounded at 300_000 ms with a 30_000 ms default.
- **HooksConfig** — the `hooks:` section of `.splitbrief/config.yaml`: a map from `HookEvent` to `HookEntry[]`.

## Hook trust

First-time trust gate for hook configs. `src/core/hooks/trust-digest.ts` computes a hash from the hook section and `src/core/hooks/trust.ts` holds the grant against that hash; `src/cli/hook-trust-prompt.ts` prompts in a TTY the first time, showing each hook's executable, the absolute path it resolves to here, and its argv, then asking `Trust these hooks for this project? [y/N]`. Answering `y` writes a receipt to `~/.splitbrief/trust/hooks.json` keyed by the canonical path of this checkout, so the grant belongs to this machine and this checkout and a repository can neither ship nor forge one. Any edit to the hooks section invalidates the hash and re-prompts. In CI (non-TTY), `--allow-hooks` is required — otherwise SPLITBRIEF refuses to start. This prevents silent RCE via a config edit.

## Repo-map

Token-budgeted codebase summary injected into the planner prompt at workflow start. Pipeline: tree-sitter parse → SQLite cache → symbol graph → PageRank → token-aware format. Lives in `src/engine/codebase/`. Opt-out via `codebase.enabled: false`. The map rebuilds itself on each planning run when the cache is stale; there is no manual rebuild step. See [REPOMAP.md](./REPOMAP.md).

- **RepoMapOptions** — options to `buildRepoMap(projectDir, opts)` in `src/engine/codebase/repomap.ts`: `{ focusFiles?, featureText?, tokenBudget?, include?, exclude?, onWarn? }`. `tokenBudget` defaults to 4000. With no `include`, discovery walks every known language extension. The default excludes are test files (`\.test\.tsx?$`), `.git/`, `.splitbrief/`, `.trees/`, `node_modules/` and `dist/`; an `exclude` entry adds to them. `focusFiles` and the files `featureText` names boost the PageRank personalization vector for files the planner already knows are relevant.

---

## Artifacts on disk

All workflow state lives under `.splitbrief/` in the target project. Each session gets its own self-contained folder.

```
.splitbrief/
├── config.yaml                             # user config (version: 3)
├── active                                  # JSON receipt of the currently-active run (or absent)
└── sessions/
    ├── 2026-04-14-add-email-validator/
    │   ├── state.json                      # mutable: phase, tasks, currentTaskIndex, tokenUsage, plannerSessionId
    │   ├── session.jsonl                   # append-only log: type-tagged events + messages
    │   ├── summary.json                    # the session row, saved at the end of every run pass (status, stop, apply, Summary)
    │   ├── plan.json                       # the checked plan the planning session answered
    │   ├── plan.md                         # the plan card's body, rendered from plan.json
    │   └── tasks.md                        # Task Brief transport, rendered from plan.json
    └── 2026-04-13-fix-auth-bug/
        └── …                               # same shape, one folder per historical session
```

Key rules:

- One session = one folder. The folder name is the session-id.
- `state.json` is what `splitbrief resume` reads to rebuild the in-memory `WorkflowState`. It is overwritten on every phase transition.
- `summary.json` is saved at the end of every run pass (`saveFinalSession`, `src/engine/orchestrator/session-lifecycle/finalize.ts`). A resumed pass drops the stop the last pass wrote as it starts (`reopenSessionRecord`).
- `session.jsonl` is append-only and the single source of truth for history (see "Events & messages" below).
- `plan.json` is the plan; `plan.md` and `tasks.md` are rendered from it when it compiles. A run planned by an older engine also holds `research.md`, `spec.md`, `clarifications.md`, `constitution-check.json` or `analyze.json`; a new run writes none of them.
- `.splitbrief/active` holds the receipt (`version`, `sessionId`, `generation`) of the session that blocks another same-directory `splitbrief start` while it is live. A closed run releases it; a stopped run keeps it, because it is still continuable. An older bare session-id file still reads.

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
