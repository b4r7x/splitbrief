# Plan Review Trust: Scorecard + Worker Packet Preview - 2026-04-28

> **Status:** planned.
> **Scope:** improve pre-implementation trust in the current-session Plan Review surface by adding a compact readiness scorecard and an optional read-only Worker Packet Preview for the selected task.
> **Out of scope:** kanban, plan archive, MCP write tools, full multi-agent manager, same-checkout parallel writes, and runtime implementation during this documentation-authoring pass.

The `agent-briefs/` files are handoff material for a future source implementation pass. Do not execute them during docs-only pack maintenance.

## Product Boundary

Plan Review is an execution-readiness gate for the current workflow session. It should help the user answer:

- Which tasks are ready?
- Which tasks need splitting or overflow handling?
- Which tasks are risky, tight, stale, conflicted, or missing validation/evidence?
- What exactly will the cheap implementer receive if this selected task runs now?

This feature does not make Plan Review into project management. It does not add saved plan libraries, cross-plan dependencies, lanes, assignment, or archival workflows.
Durable sessions remain execution/session history, not project-management tooling.

## Reading Order

Paths without a leading directory in this table are relative to `docs/superpowers/specs/2026-04-28-plan-review-trust/`.

| Step | File | Purpose |
|---|---|---|
| 1 | `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` | Canonical product direction and non-goals. |
| 2 | `README.md` | Pack scope and execution order. |
| 3 | `spec.md` | User stories, requirements, entities, and success criteria. |
| 4 | `decisions.md` | ADRs for semantics and UI constraints. |
| 5 | `implementation-plan.md` | Likely source touch areas and phased approach. |
| 6 | `tasks.md` | Concrete future-worker tasks and dependencies. |
| 7 | `verification.md` | Targeted validation and manual TUI checks. |
| 8 | `agent-briefs/00-coordinator.md` | Coordinator instructions for implementation. |
| 9 | `agent-briefs/01-*.md` through `04-*.md` | Fresh-context worker briefs. |
| 10 | `execute-prompt.md` | Copy/paste prompt for handing this pack to a fresh implementation context. |

## Implementation Slices

1. Scorecard domain semantics: derive counts from `Task[]`, brief-quality issues, and `PlanTaskReviewMetadata`.
2. Scorecard UI: render compact readiness counts in simple review and rich editor without increasing row height unpredictably.
3. Worker Packet Preview domain: produce a read-only preview from the same formatter/routing inputs used by dispatch.
4. Worker Packet Preview UI and keys: show/hide a selected-task preview panel in rich Plan Review.
5. Behavior-focused tests and docs refresh.

## Done Criteria

- Plan Review shows compact counts for ready, routing pending/unknown fit, needs split/overflow, risky/tight, stale/conflict, and missing validation/evidence.
- The scorecard is derived from existing Task Brief, brief-quality, and fresh routing metadata; it does not create a new project-management state model.
- Tasks with missing, stale, pending, or unknown routing/context fit metadata are not counted as ready.
- The selected task can show a read-only Worker Packet Preview that matches the implementer prompt shape: system preamble, task prompt sections, context-fit estimate, worker profile, context length, and current-code reduction mode.
- Preview content is redacted/truncated for terminal readability and marked as preview-only when any truncation/redaction occurs.
- Existing approval/edit/comment/reject flow remains intact.
- No MCP writes, no same-checkout parallel execution, no runtime code changes during this documentation-authoring pass.
- Future implementation passes `npm run typecheck`, `npm run lint`, targeted Vitest tests, a final `npm test` once the workflow UI/routing changes are stable, and manual TUI checks listed in `verification.md`; if final `npm test` is skipped, the final report states the explicit reason.

## Global Invariants For Future Workers

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert user or other-agent edits.
- Node.js 22+, TypeScript ESM, and `.js` import suffixes are required.
- No classes, no barrels, no memoization (`useMemo`, `useCallback`, `React.memo`), no `forwardRef`.
- Engine code must not import React, Ink, features, components, or hooks.
- Tests should assert observable behavior, not internal call graphs.
