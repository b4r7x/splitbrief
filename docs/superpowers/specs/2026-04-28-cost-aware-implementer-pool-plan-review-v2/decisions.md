# Decisions

## ADR-001 - Use a superpowers spec pack for this work

**Status:** accepted
**Date:** 2026-04-28

### Context

The user wants a detailed plan and dispatchable subagent briefs, not immediate implementation in this chat.

### Decision

Use the existing `docs/superpowers/specs/*` style and include Spec Kit equivalent artifacts (`spec.md`, `implementation-plan.md`, `tasks.md`, `analyze.md`) inside the pack.

### Consequences

- The plan is easy to hand to future agents.
- The current context stays focused.
- Implementation remains explicit and reviewable before code changes begin.

## ADR-002 - Implementer pool is still one implementer role

**Status:** accepted
**Date:** 2026-04-28

### Context

Users may have several cheap/local execution options. A single long implementer chat does not fit many-task plans, especially with 32k local models.

### Decision

Support a pool of implementer profiles over time, but keep the product model as two roles: planner and implementer. The pool selects which concrete worker executes each task.

### Consequences

- Diptych does not become a generic swarm manager.
- Routing decisions stay tied to cost, context length, capability, and safety.
- TUI can show worker selection without showing a multi-agent control center.

## ADR-003 - Fresh context per task

**Status:** accepted
**Date:** 2026-04-28

### Context

Cheap implementers are more reliable when they receive a narrow, self-contained prompt. Long chat memory consumes context and invites drift.

### Decision

Every Task Brief executes in a fresh worker call. Retry prompts may include prior failure output, but a task must not require the whole session transcript.

### Consequences

- Task Brief quality becomes more important.
- Context budgeting can be deterministic.
- Planner must split tasks that exceed worker context limits.

## ADR-004 - Sequential execution first, isolated parallelism later

**Status:** accepted
**Date:** 2026-04-28

### Context

Parallel same-directory writes create unclear ownership and conflict risk.

### Decision

The first implementation keeps task execution sequential inside one checkout. Parallel work is deferred to isolated worktrees or staging boundaries in a later spec.

### Consequences

- The implementation is smaller and safer.
- Implementer pool work focuses on selection/fallback, not fan-out.
- Worktree support remains a future enabler, not the center of the product.

## ADR-005 - User edits are first-class state

**Status:** accepted
**Date:** 2026-04-28

### Context

The user may edit files manually while diptych plans, waits for approval, validates, or runs a worker.

### Decision

Manual edits are never silently overwritten. Diptych must classify external changes by file and task impact, then pause only when the change conflicts with pending or current work.

### Consequences

- Conflict UX needs more information than yes/no.
- Snapshot and staging helpers should be reused where possible.
- TUI must explain safe choices: continue, pause, rebase, skip, abort.

## ADR-006 - Tools belong to runners; truth belongs to diptych

**Status:** accepted
**Date:** 2026-04-28

### Context

Claude Code, Codex, OpenCode, Kilo, Copilot, and Agent SDK have their own tool-call and MCP ecosystems. If diptych also becomes a tool-calling agent, ownership gets blurry.

### Decision

Diptych runs deterministic orchestration operations. Underlying planner/implementer runners may use their own tools. Diptych MCP remains read-only resources unless a future spec proves a mutation use case.

### Consequences

- File changes remain attributable.
- Permissions stay easier to reason about.
- MCP does not become a second execution framework.

## ADR-007 - Checkpoints over automatic commits

**Status:** accepted
**Date:** 2026-04-28

### Context

This repository explicitly forbids staging and commits by agents. Product docs also contain older per-task commit language.

### Decision

This roadmap should emphasize hash-guarded checkpoints and snapshots. Automatic commits are not part of this spec.

### Consequences

- Future docs need to separate product-level commit support from this repository's no-commit rule.
- Checkpoint UX remains important.
- Implementation agents must not stage or commit.

## ADR-008 - Plan Review v2 is not kanban

**Status:** accepted
**Date:** 2026-04-28

### Context

The user wants editable planning, not a project-management system.

### Decision

Plan Review v2 shows execution-relevant data: task scope, files, context fit, worker choice, risk, validation, and checkpoint state. It does not add plan archives, drag/drop kanban, or cross-plan orchestration.

### Consequences

- The TUI remains focused and dense.
- Existing plan editor work can be reused.
- Long-lived plan management remains out of scope.

## ADR-009 - Cleanup is scoped, not destructive

**Status:** accepted
**Date:** 2026-04-28

### Context

The repo contains advanced surfaces such as MCP, handoff packs, snapshots, worktrees, detached sessions, and plan editor UI.

### Decision

Do not delete these blindly. First update docs and product positioning, then demote or remove surfaces only when their behavior clearly conflicts with the core loop.

### Consequences

- Cleanup can be incremental.
- Useful safety primitives are preserved.
- Implementation agents get a concrete cleanup list without treating every advanced feature as dead code.
