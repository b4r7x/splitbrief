# Implementer direction

> Status: product direction, implementation guidance.
> Last updated: 2026-08-04. Realigned to ADR-1 through ADR-4 in `.nuke/2026-08-04-decisions.md`.

This document is the source of truth for implementer direction. Other docs should describe the same product boundary in local terms, not redefine it.

## Purpose

SPLITBRIEF's non-goals are the canonical NOT-list in [VISION.md](./VISION.md). The core product direction is narrower:

```text
the stronger tool plans and reviews
  -> SPLITBRIEF turns that thinking into small executable Task Briefs
  -> a weaker model executes those briefs one task at a time, in an isolated checkout
  -> SPLITBRIEF holds the contract: context size, user edits, checkpoints, validation, drift, escalation, evidence
```

The value is the split itself. The stronger tool is used where quality changes the result: research, planning, ambiguity reduction, task decomposition, review, and escalation. Mechanical implementation goes to the weaker model whenever the task is small enough and sufficiently specified.

## Product identity

SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes. SPLITBRIEF holds everything in between.

The pairing is strongest cross-lab — planner and implementer from different model labs — because a model reviewing its own output repeats its own blind spots. Spend is a reported fact of a run, not the headline: a run should be able to say what it spent, and the claim the product makes is a reviewable change with evidence behind it.

It owns:

- planning workflow,
- durable workflow sessions,
- Task Brief quality,
- task sizing and routing,
- isolation and Apply,
- checkpoint boundaries,
- conflict detection,
- validation,
- retry and escalation,
- session artifacts,
- evidence and drift reporting,
- TUI visibility.

It does not own a long-lived project-management database or generalized MCP tool execution, and it does not replace the capabilities of Claude Code, Codex, OpenCode, Kilo, or Copilot. The full non-goals list lives in [VISION.md](./VISION.md).

The core sentence is:

> SPLITBRIEF has the stronger tool decide what should happen, feeds the weaker one small safe chunks in an isolated checkout, proves the result itself, and stops before overwriting the user.

## Sessions, not plan archives

Durable workflow sessions are core product surface. Users should be able to resume work, inspect session history, browse/filter/search previous sessions, and review the artifacts a run produced.

A session is an execution record for one workflow. It may contain `plan.json`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, drift reports, checkpoints, and runner transcripts. These artifacts support resume, review, audit, handoff, and final validation.

A session history is not a plan archive (see the non-goals list in [VISION.md](./VISION.md)). Plan Review is scoped to the current session's Task Briefs and execution readiness.

## Planner role

The planner is the stronger of the two tools, and usually the expensive one. It should be used when quality materially changes the result:

- understanding a rough user request,
- asking clarification questions,
- reading enough codebase context to produce a reliable plan,
- splitting work into atomic Task Briefs,
- identifying risks and stop conditions,
- estimating whether the weaker implementer is likely to succeed,
- reviewing drift after implementation,
- giving hints or taking over when the implementer fails.

The planner should not be used for routine mechanical edits when the weaker implementer can do the work safely.

## Implementer role

The implementer is a weaker **model**, not a weaker kind of tool. What makes something an implementer is the model behind it, not how the bytes travel.

Two transports are first-class and supported equally:

| Transport | Write mode | Example |
|---|---|---|
| Tool CLI driving a smaller model | `direct` — the agent writes files itself | Codex, Claude Code, OpenCode, Kilo, or Copilot pinned to a smaller model |
| Model behind an OpenAI-compatible API | `extracted-code` — the model returns file contents, SPLITBRIEF writes them | Ollama, LM Studio, or a custom endpoint |

SPLITBRIEF does not favour a transport. The user picks; both paths get the same prompt quality, the same isolation, and the same validation. Shell and agent subprocesses remain supported as the escape hatch for custom executors.

The write mode is not a free choice — it follows the runner kind, enforced in `src/core/schemas/implementer-config.ts`: `api` and `shell` return code, `cli` and `agent` write files.

The important point is that this is still one role: implementer. A pool means SPLITBRIEF can choose the capable executor whose context window best fits each Task Brief — it is profile selection, not the swarm/multi-agent behavior ruled out in [VISION.md](./VISION.md).

The implementer should receive a fresh, bounded prompt per task. It should not receive the whole plan, whole transcript, or every previous task unless the current brief explicitly depends on that context. Both write modes get a full system prompt — file scope, stop conditions, validation expectations, reporting format. Neither mode is the side path.

## Who owns validation

The implementer is by definition the weaker side. If its own assessment decided whether a task was done, the weakest link would set the quality bar. It does not.

Correctness is owned by two things:

- SPLITBRIEF's deterministic validation pipeline — typecheck → lint → test, stopping at the first failure attributable to the task, run in the run workspace after each brief (`src/engine/orchestrator/task/step.ts`),
- the planner's review of the finished change.

An implementer implements; it does not run the project gates. The direct-writer preamble (`src/engine/spec/prompts/system.ts`) tells it that SPLITBRIEF runs typecheck, lint, format and test after the call, so it runs at most the focused test files the brief lists, once, and no project-wide gate, whole suite, screenshot or render tool. The P01 run showed why: one brief spent 13% of its tool calls on edits and 87% on reads, gates and renders. Whatever an implementer reports about its own validation lands in the evidence trail as a claim by the agent, never as a verdict.

The brief's files are suggestions. The implementer starts from them, edits another ordinary project file the change needs, and names it in its report as `Also changed (not suggested): <file> — <reason>`. Only a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) is off limits unless the brief asks for that operation.

This is where the cross-lab advantage lands in practice: the review that decides is done by a model that did not write the code.

## Fresh context per task

Local models often have limited context windows. A 32k context model cannot safely execute a 20-task plan if every task is appended to one long chat.

The required execution model is:

```text
Task Brief T001 -> worker call with fresh context
Task Brief T002 -> worker call with fresh context
Task Brief T003 -> worker call with fresh context
```

Each call includes only:

- the selected Task Brief,
- the relevant file contents or extracted code context,
- dependency outputs that are truly needed,
- validation expectations,
- constraints,
- escalation rules,
- retry or hint context when applicable.

If a task does not fit the selected worker's context window, SPLITBRIEF should not stuff more context into the prompt. It should either:

1. ask the planner to split the task,
2. route the task to a larger implementer,
3. escalate to the planner.

Large prompts are a planning failure, not a reason to make every worker remember the whole session.

## Brief grouping

A brief is one coherent, reviewable outcome, not a file: every path it writes is listed under `files`, with `file` as the anchor. A brief that creates `src/health.ts` and its `src/health.test.ts` is one outcome, because splitting it would hand the implementer a test with nothing to test.

The grouping rule is `sliceRuleText()` (`src/core/pipeline-spec/brief.ts`). The planner prompts and the portable skills render it; they do not restate it. The rule keeps tests, callers, wiring, fixtures and necessary documentation with their behavior, and it combines related corrections that share a contract, mechanism or code context. It splits independent outcomes, or a complex mechanism, when separate validation, context or recovery makes the work easier to execute correctly.

No brief count, file count or changed-line count decides a boundary, and no mode caps the number of briefs in a run. What bounds one brief is the real limit of its runner: the model context and the prompt transport, with the system text, skills and retry feedback included. A brief that does not fit follows the refusal path above; the brief is never truncated.

## Implementer pool

The implemented optional profile shape is:

```yaml
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b

implementerProfiles:
  default: local-qwen
  profiles:
    local-qwen:
      kind: api
      provider: ollama
      service: ollama
      offering: local
      apiBase: http://localhost:11434/v1
      model: qwen3-coder:30b
      contextLength: 32768
      capabilities:
        writesFiles: extracted-code
    small-cloud:
      kind: api
      provider: custom-endpoint
      service: custom-endpoint
      offering: payg
      apiBase: https://api.example-endpoint.com/v1
      apiKey: your-key
      model: qwen3-coder
      contextLength: 131072
      capabilities:
        writesFiles: extracted-code
    agent-cli:
      kind: cli
      tool: codex
      model: gpt-5-mini
      contextLength: 200000
      capabilities:
        writesFiles: direct
```

The implemented behavior is:

- default to the capable implementer with the smallest sufficient context window,
- consider context length before dispatch,
- consider runner kind and write mode (`extracted-code` profiles can only return one file's contents; `direct` profiles can edit in-scope files directly),
- keep a record of the routing decision,
- fall back predictably when validation fails, including recovery-time rerouting to a named larger profile for the current task,
- never parallel-write the same checkout in v1.

## Isolation and Apply

An implementer with `writesFiles: direct` needs somewhere to write that is not the user's working tree. That somewhere is a **git worktree, created once per run** — not a copy of the project per task.

- One worktree per run, at `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` (default `~/.local/state/...`) on a `splitbrief/<slug>` branch (`src/engine/orchestrator/isolation/create-worktree.ts`). Tasks share it. Outside `.git/` (direct-writing CLIs refuse paths there) and outside the project tree: it is a second copy of the source that survives every per-task validation, and a project-rooted test glob that reaches it counts every test twice.
- Project dependencies are reachable inside the worktree. A checkout without `node_modules` is a checkout where nothing runs: no typecheck, no tests, no useful self-check by the implementer.
- The worktree carries `.splitbrief/config.yaml` and `.splitbrief/hooks/` over from the real project, so hook and config behaviour matches.
- Worktree is the default, not the only option. A user may configure a different isolation strategy.
- The per-task recursive copy into the system temp directory (`createStagedProject`) is no longer the default path.

Apply is the non-negotiable half. Work that stays inside the run workspace is not a delivered change: the reviewed result is written into the user's real project directory once, when the owner applies it. Apply never overwrites a file that moved under SPLITBRIEF's feet; [WORKFLOW.md §Apply](./WORKFLOW.md#apply) owns the algorithm.

**A worktree is not a security boundary.** It isolates files, not the runtime — same ports, same database, same credentials on disk — and it shares hooks and config with the real repository by design. An implementer running in a worktree is code running with the user's privileges. Runner kinds `shell` and `agent` execute arbitrary commands with no shell or network sandbox, and the worktree does not change that. Documentation and UI must say so plainly rather than implying containment.

## Parallelism

Parallelism is not the first goal. The first goal is reliable execution on the weaker model. One worktree per run isolates the implementer from the user's checkout; it is not a licence for concurrent workers inside it.

Allowed in this direction:

- sequential task execution with fresh context,
- optional fallback to stronger implementer profiles,
- future parallel execution only when each worker owns a separate worktree or equivalent sandbox.

Not allowed in the first implementation:

- multiple workers writing the same working tree at once,
- multiple workers writing the same checkout at once,
- hidden background task fan-out,
- best-of-N workers racing on the same files,
- automatic merge of overlapping changes.

If parallel execution is later considered, it should be a separate design using one worktree per worker, and only for tasks with non-overlapping file ownership. Do not frame parallel writes as near-term work.

## User edits

The user can edit files manually while SPLITBRIEF is planning or implementing. Those edits are not noise. They are source-of-truth changes made by the owner of the repository.

SPLITBRIEF must distinguish:

- files already dirty before a task starts,
- files changed by SPLITBRIEF during a task,
- files changed by the user while SPLITBRIEF was waiting, prompting, validating, or applying,
- files changed by another process after a snapshot/checkpoint.

The default behavior is never to overwrite. Briefs build in the run workspace, so a checkout edit never halts a brief; Apply merges the checkout into the run's result and stops on a conflict instead of overwriting.

Examples:

```text
User edits unrelated file:
  continue; the call logs checkout_changed_during_call, and Apply carries the edit through.

User edits a file a pending brief will change:
  continue; Apply merges the edit with the brief's result.

User edits a file the run also changed, and the two cannot merge:
  Apply halts as apply-conflict and names the file and the workspace.
```

The right UX is not "SPLITBRIEF detected external changes, continue yes/no" only. The TUI should show which files changed, which tasks are affected, and what the safe choices mean.

## Checkpoints

Checkpointing is core to trust, but it should be framed as run safety, not git history management.

Useful checkpoints:

- before implementation begins,
- before each task,
- after each successful task,
- before final review,
- before rejecting a run.

Checkpoint restore must be hash-guarded so later user edits are not overwritten.

In this repository, agents must never run `git add`, `git stage`, or `git commit`. Product support for commits may exist, but this codebase's working rule is manual commits only. Docs should keep this distinction explicit.

## Tool calls

Tools belong to the underlying runner. Truth belongs to SPLITBRIEF.

That means:

- Claude Code, Codex, OpenCode, Kilo, or Copilot may use their own tools and MCP clients when they are the planner or implementer.
- SPLITBRIEF should not become another tool-calling agent that independently reads, writes, browses, and shells around the worker.
- SPLITBRIEF should run deterministic orchestration operations: file snapshots, git status/diff, validation commands, budget checks, drift checks, evidence writes, approval gates.
- SPLITBRIEF exposes no server of its own. It ships no MCP server, and an external agent reaches a run's artifacts by reading the session directory, not by calling into SPLITBRIEF.

## TUI direction

The TUI should make the invisible orchestration understandable.

The important screens are:

1. Intake/planning status.
2. Plan review and Task Brief editing.
3. Execution status by task.
4. Conflict/checkpoint decisions.
5. Context posture.
6. Final review and drift/evidence summary.

The TUI stays within the product boundary in [VISION.md](./VISION.md). It should answer practical questions:

- What is the planner doing?
- What will the implementer receive?
- Will this task fit the selected worker?
- Which files are in scope?
- What did the user change manually?
- What changed after the worker ran?
- What test or validation proves this task is done?
- What will happen if I approve, retry, skip, or rebase?

## Cleanup direction

Existing implementation has valuable pieces, but docs and product surface should be tightened around the core loop.

High-confidence cleanup:

- Update product docs that frame SPLITBRIEF as broad external-agent interop, kanban, archive, or plan-management product.
- Preserve session history/resume/browse/filter/search as core workflow surfaces, but distinguish them from a plan archive.
- Make the no-commit rule explicit for this repository, and separate it from optional product-level commit strategies.
- Update stale config examples that use old snake_case or old config keys.
- Reword Task Contract docs so external Kanban/Jira usage is not presented as the main purpose.
- Audit tests for behavior value, especially hook/wrapper tests and large UI tests that assert "no crash" rather than user-observable behavior.

Lower-confidence cleanup that should not happen blindly:

- Do not delete snapshots before deciding how checkpoint UX should work.
- Do not delete worktree support: it is the default isolation path, not a hypothetical future need.
- Do not reintroduce inline Task Brief editing just because an external editor round-trip feels less integrated; preserve the simple review plus persisted `tasks.md` editor contract unless product direction changes.

## Implemented build order

The 2026-04-28 implementation followed this order:

1. Document the product direction and trim scope language.
2. Add implementer profile/pool schema in a backwards-compatible way.
3. Add task sizing and context-fit checks.
4. Add routing decision recording and display.
5. Keep execution sequential, but make each task a fresh worker context.
6. Improve user-edit conflict modeling and TUI choices.
7. Improve Plan Review v2 to show context/risk and edit operations.
8. Cleanup docs and tests that no longer match the direction.

## Success criteria

This direction is successful when:

- a user can understand which tool is planning, which is executing, and why splitting them earns its keep,
- both transports — tool CLI on a smaller model and API model — reach the same bar, and neither reads as the fallback path,
- each implementer task is small enough to fit its selected context window,
- the implementer works in an isolated checkout where dependencies resolve and validation can actually run,
- every accepted change lands in the user's real project directory, and never on top of a file the user changed underneath it,
- correctness is decided by SPLITBRIEF's validation pipeline and the planner's review, never by the implementer's own claim,
- a finished run can report what it actually spent, as a measurement rather than a headline,
- the user can edit the plan before implementation,
- manual user edits are never silently overwritten,
- TUI explains current state without acting like a project-management tool,
- final review can compare planned work against actual changes,
- future agents can implement features from Task Briefs without reading this entire conversation.
