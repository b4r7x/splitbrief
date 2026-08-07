# Implementer direction

> Status: product direction, implementation guidance.
> Last updated: 2026-08-04. Realigned to ADR-1 through ADR-4 in `.nuke/2026-08-04-decisions.md`; the file name is kept unchanged so inbound links keep resolving.

This document is the source of truth for implementer direction. Other docs should describe the same product boundary in local terms, not redefine it.

## Purpose

SPLITBRIEF's non-goals are the canonical NOT-list in [VISION.md](./VISION.md). The core product direction is narrower:

```text
the stronger tool plans and reviews
  -> SPLITBRIEF turns that thinking into small executable Task Briefs
  -> a weaker model executes those briefs one task at a time, in an isolated checkout
  -> SPLITBRIEF holds the contract: context size, user edits, checkpoints, validation, drift, escalation, evidence
```

The value is the split itself. The stronger tool is used where quality changes the result: research, planning, ambiguity reduction, task decomposition, review, and escalation. Mechanical implementation goes to the weaker model whenever the task is small enough and sufficiently specified. Lower spend follows from that arrangement; it is a consequence, not the promise.

## Product identity

SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes. SPLITBRIEF holds everything in between.

The pairing is strongest cross-lab — planner and implementer from different model labs — because a model reviewing its own output repeats its own blind spots. Cost is a reported fact of a run, not the headline: a run should be able to say what it spent, and the claim the product makes is a reviewable change with evidence behind it.

It owns:

- planning workflow,
- durable workflow sessions,
- Task Brief quality,
- task sizing and routing,
- isolation and promotion,
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

A session is an execution record for one workflow. It may contain `spec.md`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, drift reports, checkpoints, and runner transcripts. These artifacts support resume, review, audit, handoff, and final validation.

A session history is not a plan archive (see the non-goals list in [VISION.md](./VISION.md)). Plan Review is scoped to the current session's Task Briefs and execution readiness.

## Planner role

The planner is the stronger of the two tools, and usually the expensive one. It should be used when quality materially changes the result:

- understanding a rough user request,
- asking clarification questions,
- reading enough codebase context to produce a reliable plan,
- splitting work into atomic Task Briefs,
- identifying risks and stop conditions,
- estimating whether cheap implementation is likely to succeed,
- reviewing drift after implementation,
- giving hints or taking over when a cheap implementer fails.

The planner should not be used for routine mechanical edits when a cheaper implementer can do the work safely.

## Implementer role

The implementer is a weaker **model**, not a weaker kind of tool. What makes something an implementer is the model behind it, not how the bytes travel.

Two transports are first-class and supported equally:

| Transport | Write mode | Example |
|---|---|---|
| Tool CLI driving a cheaper model | `direct` — the agent writes files itself | Codex, Claude Code, OpenCode, Kilo, or Copilot pinned to a cheap model |
| Model behind an OpenAI-compatible API | `extracted-code` — the model returns file contents, SPLITBRIEF writes them | Ollama, LM Studio, OpenRouter, DeepSeek |

SPLITBRIEF does not favour a transport. The user picks; both paths get the same prompt quality, the same isolation, and the same validation. Shell and agent subprocesses remain supported as the escape hatch for custom executors.

The write mode is not a free choice — it follows the runner kind, enforced in `src/core/schemas/implementer-config.ts`: `api` and `shell` return code, `cli`, `agent`, and `agent-sdk` write files.

The important point is that this is still one role: implementer. A pool means SPLITBRIEF can choose the cheapest capable executor for each Task Brief — it is profile selection, not the swarm/multi-agent behavior ruled out in [VISION.md](./VISION.md).

The implementer should receive a fresh, bounded prompt per task. It should not receive the whole plan, whole transcript, or every previous task unless the current brief explicitly depends on that context. Both write modes get a full system prompt — file scope, stop conditions, validation expectations, reporting format. Neither mode is the side path.

## Who owns validation

The implementer is by definition the weaker side. If its own assessment decided whether a task was done, the weakest link would set the quality bar. It does not.

Correctness is owned by two things:

- SPLITBRIEF's deterministic validation pipeline — typecheck → lint → test, stopping at the first failure attributable to the task, run against the user's real project directory after changes are promoted (`src/engine/orchestrator/task/step.ts`),
- the planner's review of the finished change.

An implementer that can run a typecheck or a test in its own workspace is a bonus, not a requirement. It raises first-pass rate and shortens the retry loop; it never becomes the proof. When an implementer reports validation results through the MCP evidence-ledger tools, those land in the evidence trail as claims by the agent, not as a verdict.

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
      costTier: local
      capabilities:
        writesFiles: extracted-code
    cheap-cloud:
      kind: api
      provider: openrouter
      service: openrouter
      offering: payg
      apiBase: https://openrouter.ai/api/v1
      model: qwen/qwen3-coder
      contextLength: 131072
      costTier: cheap
      capabilities:
        writesFiles: extracted-code
    agent-cli:
      kind: cli
      tool: codex
      model: gpt-5-mini
      contextLength: 200000
      costTier: standard
      capabilities:
        writesFiles: direct
```

The implemented behavior is:

- default to the cheapest capable implementer,
- consider context length before dispatch,
- consider runner kind and write mode (`extracted-code` profiles can only return one file's contents; `direct` profiles can edit in-scope files directly),
- keep a record of the routing decision,
- fall back predictably when validation fails, including recovery-time rerouting to a named larger profile for the current task,
- never parallel-write the same checkout in v1.

## Isolation and promotion

An implementer with `writesFiles: direct` needs somewhere to write that is not the user's working tree. That somewhere is a **git worktree, created once per run** — not a copy of the project per task.

- One worktree per run, at `.trees/<slug>` on a `splitbrief/<slug>` branch (`src/engine/worktree/create.ts`). Tasks share it.
- Project dependencies are reachable inside the worktree. A checkout without `node_modules` is a checkout where nothing runs: no typecheck, no tests, no useful self-check by the implementer.
- The worktree carries `.splitbrief/config.yaml` and `.splitbrief/hooks/` over from the real project, so hook and config behaviour matches.
- Worktree is the default, not the only option. A user may configure a different isolation strategy.
- The per-task recursive copy into the system temp directory (`createStagedProject`) is no longer the default path.

Promotion is the non-negotiable half. Work that stays inside an isolated checkout is not a delivered change: accepted changes are written into the user's real project directory. Promotion is hash-guarded (`promoteStagedChanges` in `src/engine/orchestrator/approval/staged-project.ts`) — if a file moved under SPLITBRIEF's feet between snapshot and promotion, promotion stops and reports the conflict instead of overwriting it.

**A worktree is not a security boundary.** It isolates files, not the runtime — same ports, same database, same credentials on disk — and it shares hooks and config with the real repository by design. An implementer running in a worktree is code running with the user's privileges. Runner kinds `shell` and `agent` execute arbitrary commands with no shell or network sandbox, and the worktree does not change that. Documentation and UI must say so plainly rather than implying containment.

## Parallelism

Parallelism is not the first goal. The first goal is reliable cheap execution. One worktree per run isolates the implementer from the user's checkout; it is not a licence for concurrent workers inside it.

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

The default behavior is to pause on conflicts, not overwrite.

Examples:

```text
User edits unrelated file:
  continue, but show it in TUI as external change.

User edits the same file as pending task:
  pause and offer rebase/regenerate/skip/abort.

User edits file after implementer output but before promote/apply:
  block promotion and show conflict.
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

## Tool calls and MCP

Tools belong to the underlying runner. Truth belongs to SPLITBRIEF.

That means:

- Claude Code, Codex, OpenCode, Kilo, Copilot, or Agent SDK may use their own tools and MCP clients when they are the planner or implementer.
- SPLITBRIEF should not become another tool-calling agent that independently reads, writes, browses, and shells around the worker.
- SPLITBRIEF should run deterministic orchestration operations: file snapshots, git status/diff, validation commands, budget checks, drift checks, evidence writes, approval gates.
- SPLITBRIEF's MCP server should keep project resources read-only. The current mutation surface is limited to evidence-ledger tools that let external agents report progress, evidence, validation results, completion, or errors.

MCP is useful as a way for external tools to read SPLITBRIEF session artifacts. It should not become the main execution path.

## TUI direction

The TUI should make the invisible orchestration understandable.

The important screens are:

1. Intake/planning status.
2. Plan review and Task Brief editing.
3. Execution status by task.
4. Conflict/checkpoint decisions.
5. Cost and context posture.
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
- Keep MCP described as read-only project resources plus constrained evidence-ledger tools, not general writable tool execution.
- Audit tests for behavior value, especially hook/wrapper tests and large UI tests that assert "no crash" rather than user-observable behavior.

Lower-confidence cleanup that should not happen blindly:

- Do not delete snapshots before deciding how checkpoint UX should work.
- Do not delete worktree support: it is the default isolation path, not a hypothetical future need.
- Do not delete handoff packs until the product decides whether external runner handoff remains a useful escape hatch.
- Do not reintroduce inline Task Brief editing just because an external editor round-trip feels less integrated; preserve the simple review plus persisted `tasks.md` editor contract unless product direction changes.

## Implemented build order

The 2026-04-28 implementation followed this order:

1. Document the product direction and trim scope language.
2. Add implementer profile/pool schema in a backwards-compatible way.
3. Add task sizing and context-fit checks.
4. Add routing decision recording and display.
5. Keep execution sequential, but make each task a fresh worker context.
6. Improve user-edit conflict modeling and TUI choices.
7. Improve Plan Review v2 to show cost/context/risk and edit operations.
8. Cleanup docs and tests that no longer match the direction.

## Success criteria

This direction is successful when:

- a user can understand which tool is planning, which is executing, and why splitting them earns its keep,
- both transports — tool CLI on a cheap model and API model — reach the same bar, and neither reads as the fallback path,
- each implementer task is small enough to fit its selected context window,
- the implementer works in an isolated checkout where dependencies resolve and validation can actually run,
- every accepted change lands in the user's real project directory, and never on top of a file the user changed underneath it,
- correctness is decided by SPLITBRIEF's validation pipeline and the planner's review, never by the implementer's own claim,
- a finished run can report what it actually cost, as a measurement rather than a headline,
- the user can edit the plan before implementation,
- manual user edits are never silently overwritten,
- TUI explains current state without acting like a project-management tool,
- final review can compare planned work against actual changes,
- future agents can implement features from Task Briefs without reading this entire conversation.
