# Cost-aware implementer direction

> Status: product direction, implementation guidance.
> Last updated: 2026-04-28.

This document is the source of truth for cost-aware implementer work. Other docs should describe the same product boundary in local terms, not redefine it.

## Purpose

Diptych's non-goals are the canonical NOT-list in [VISION.md](./VISION.md). The core product direction is narrower:

```text
expensive planner thinks clearly
  -> diptych turns that thinking into small executable Task Briefs
  -> cheap or local implementers execute those briefs one task at a time
  -> diptych guards context size, user edits, checkpoints, validation, drift, and escalation
```

The value is cost control without giving up planning quality. A user should pay the expensive model for the parts where it matters: research, planning, ambiguity reduction, task decomposition, review, and escalation. Mechanical implementation should be delegated to cheaper models or local tools whenever the task is small enough and sufficiently specified.

## Product identity

Diptych is a cost-aware planner-to-implementer orchestrator.

It owns:

- planning workflow,
- durable workflow sessions,
- Task Brief quality,
- task sizing and routing,
- checkpoint boundaries,
- conflict detection,
- validation,
- retry and escalation,
- session artifacts,
- evidence and drift reporting,
- TUI visibility.

It does not own a long-lived project-management database or generalized MCP tool execution, and it does not replace the capabilities of Claude Code, Codex, OpenCode, Kilo, or Copilot. The full non-goals list lives in [VISION.md](./VISION.md).

The core sentence is:

> Diptych pays a strong planner to decide what should happen, then feeds cheap workers small safe chunks and stops before overwriting the user.

## Sessions, not plan archives

Durable workflow sessions are core product surface. Users should be able to resume work, inspect session history, browse/filter/search previous sessions, and review the artifacts a run produced.

A session is an execution record for one workflow. It may contain `spec.md`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, drift reports, checkpoints, and runner transcripts. These artifacts support resume, review, audit, handoff, and final validation.

A session history is not a plan archive (see the non-goals list in [VISION.md](./VISION.md)). Plan Review is scoped to the current session's Task Briefs and execution readiness.

## Planner role

The planner is the expensive, high-quality model or tool. It should be used when quality materially changes the result:

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

The implementer is the cheaper execution role. It may be:

- one local API model, such as Ollama or LM Studio,
- one remote cheap model via OpenAI-compatible API,
- a CLI agent such as Codex, OpenCode, Kilo, Claude Code, or Copilot,
- a shell or agent subprocess,
- an optional configured pool of implementer profiles.

The important point is that this is still one role: implementer. A pool means diptych can choose the cheapest capable executor for each Task Brief — it is profile selection, not the swarm/multi-agent behavior ruled out in [VISION.md](./VISION.md).

The implementer should receive a fresh, bounded prompt per task. It should not receive the whole plan, whole transcript, or every previous task unless the current brief explicitly depends on that context.

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

If a task does not fit the selected worker's context window, diptych should not stuff more context into the prompt. It should either:

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
  model: qwen3.6-coder:32b

implementerProfiles:
  default: local-qwen
  profiles:
    local-qwen:
      kind: api
      provider: ollama
      model: qwen3.6-coder:32b
      contextLength: 32768
      costTier: local
      capabilities:
        writesFiles: extracted-code
    cheap-cloud:
      kind: api
      provider: openrouter
      model: ...
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

## Parallelism

Parallelism is not the first goal. The first goal is reliable cheap execution.

Allowed in this direction:

- sequential task execution with fresh context,
- optional fallback to stronger implementer profiles,
- future parallel execution only when ownership is isolated in worktrees or equivalent sandboxes.

Not allowed in the first implementation:

- multiple workers writing the same working tree at once,
- multiple workers writing the same checkout at once,
- hidden background task fan-out,
- best-of-N workers racing on the same files,
- automatic merge of overlapping changes.

If parallel execution is later considered, it should be a separate design using worktrees or equivalent isolated sandboxes, and only for tasks with non-overlapping file ownership. Do not frame parallel writes as near-term work.

## User edits

The user can edit files manually while diptych is planning or implementing. Those edits are not noise. They are source-of-truth changes made by the owner of the repository.

Diptych must distinguish:

- files already dirty before a task starts,
- files changed by diptych during a task,
- files changed by the user while diptych was waiting, prompting, validating, or applying,
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

The right UX is not "diptych detected external changes, continue yes/no" only. The TUI should show which files changed, which tasks are affected, and what the safe choices mean.

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

Tools belong to the underlying runner. Truth belongs to diptych.

That means:

- Claude Code, Codex, OpenCode, Kilo, Copilot, or Agent SDK may use their own tools and MCP clients when they are the planner or implementer.
- Diptych should not become another tool-calling agent that independently reads, writes, browses, and shells around the worker.
- Diptych should run deterministic orchestration operations: file snapshots, git status/diff, validation commands, budget checks, drift checks, evidence writes, approval gates.
- Diptych's MCP server should keep project resources read-only. The current mutation surface is limited to evidence-ledger tools that let external agents report progress, evidence, validation results, completion, or errors.

MCP is useful as a way for external tools to read diptych session artifacts. It should not become the main execution path.

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

- Update product docs that frame diptych as broad external-agent interop, kanban, archive, or plan-management product.
- Preserve session history/resume/browse/filter/search as core workflow surfaces, but distinguish them from a plan archive.
- Make the no-commit rule explicit for this repository, and separate it from optional product-level commit strategies.
- Update stale config examples that use old snake_case or old config keys.
- Reword Task Contract docs so external Kanban/Jira usage is not presented as the main purpose.
- Keep MCP described as read-only project resources plus constrained evidence-ledger tools, not general writable tool execution.
- Audit tests for behavior value, especially hook/wrapper tests and large UI tests that assert "no crash" rather than user-observable behavior.

Lower-confidence cleanup that should not happen blindly:

- Do not delete snapshots before deciding how checkpoint UX should work.
- Do not delete worktree support if future isolated execution may need it.
- Do not delete handoff packs until the product decides whether external runner handoff remains a useful escape hatch.
- Do not remove the plan editor just because it is complex; first simplify its purpose around "edit Task Briefs before cheap tokens are spent."

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

- a user can understand why the planner is expensive and the implementer is cheap,
- each implementer task is small enough to fit its selected context window,
- the user can edit the plan before implementation,
- manual user edits are never silently overwritten,
- TUI explains current state without acting like a project-management tool,
- final review can compare planned work against actual changes,
- future agents can implement features from Task Briefs without reading this entire conversation.
