# Analyze Pass

## Summary

The initial idea risked growing into a plan archive, kanban, or generic multi-agent manager. Analysis narrowed it back to the original product: expensive planner, cheap implementer workers, checkpoints, validation, and user-controlled plan edits.

## Findings

### Finding 1 - "First-class plans" is too broad

Named plans, plan archive, clone, search, kanban, and cross-plan dependencies would shift diptych toward project-management software.

**Fix applied:** This pack does not include plan archive/search/kanban/cross-plan orchestration. Plan Review v2 is session-scoped and execution-focused.

### Finding 2 - Implementer pool could look like a swarm

Multiple implementers can be interpreted as multi-agent orchestration.

**Fix applied:** The pool is defined as profile selection/fallback inside one implementer role. Same-directory parallel writes are explicitly out of scope.

### Finding 3 - Context overflow is the real problem

The user's concrete concern is that local 32k workers cannot consume all tasks in one context.

**Fix applied:** Fresh context per task is now an explicit product invariant. Routing starts with context-fit checks.

### Finding 4 - Tool calls and MCP can blur ownership

If diptych starts calling tools directly, it becomes a second agent layer.

**Fix applied:** Tools belong to underlying runners. Diptych owns deterministic guardrails. MCP remains read-only.

### Finding 5 - Manual user edits need more than yes/no

Current generic external-change prompts are not enough for safe execution.

**Fix applied:** User edit conflict handling is a first-class workstream with file/task classification and TUI choices.

### Finding 6 - Existing advanced surfaces are not all wrong

Snapshots, worktrees, handoff, MCP, detached sessions, and plan editor can look like scope creep, but some pieces are useful safety or interop primitives.

**Fix applied:** Cleanup is incremental. Demote/reword first; remove only after a separate decision.

### Finding 7 - Tests may become maintenance drag

The repo has many hook/UI/protocol tests. Some are valuable; some may assert no-crash behavior or implementation details.

**Fix applied:** Cleanup tasks require auditing touched tests and keeping behavior-oriented coverage.

## Plan Changes After Analyze

The plan was adjusted as follows:

- Removed long-lived plan system from scope.
- Removed visual kanban from scope.
- Removed cross-plan orchestration from scope.
- Removed same-directory parallel fan-out from scope.
- Kept implementer pool, but only as routing/fallback.
- Added user-edit conflict flow as P1.
- Added tool/MCP boundary as explicit requirement.
- Added docs cleanup as a first-class task.
- Added routing/context metadata to Plan Review v2.

## Remaining Risks

| Risk | Mitigation |
|---|---|
| Profile schema becomes over-designed | Keep it a small extension of existing runner config. |
| Token estimates are inaccurate | Use safety margins and visible fit classes, not exact promises. |
| TUI becomes too busy | Show execution-relevant data only; no kanban/archive language. |
| Cleanup deletes useful safety features | Treat cleanup as docs/product-positioning first, code removal only with separate justification. |
| Routing adds too much state | Keep routing decisions as compact events/artifacts rather than a new long-lived plan database. |

## Analyze Result

No blocker remained after planning. Implementation proceeded through the bounded briefs in this pack and is now recorded as implemented/verified in `README.md`, `spec.md`, `tasks.md`, and `verification.md`.
