# Execute Prompt: Recovery Flow

Use this prompt after `run-readiness-doctor` and `plan-review-trust` are implemented and verified.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs and final audits.

## Prompt To Paste

```text
You are implementing the third UX/trust spec pack for diptych:

docs/superpowers/specs/2026-04-28-recovery-flow/

Goal:
Implement Recovery Flow after Run Readiness / Doctor and Plan Review Trust are done. Treat this as SOTA production work: durable state, explicit user decisions, safe resume behavior, and no hidden mutation.

Why third:
Recovery needs readiness, routing, validation, task metadata, and Plan Review semantics to already be clear.

Hard repository rules:
- Do not run git add, git stage, git commit, or git stash.
- Do not revert user changes.
- Same-checkout implementation work must be sequential.
- If using subagents, writer subagents must not write in parallel in the same checkout.
- Parallel implementation is allowed only in isolated worktrees/equivalent sandboxes.
- Read-only audit subagents may run in parallel.

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Every local TypeScript import uses a .js suffix.
- No classes.
- No barrel files; do not create index.ts.
- No useMemo, useCallback, React.memo, forwardRef, or imperative handles.
- Engine code must not import React/Ink/features/components/hooks.
- Tests must verify behavior, persisted artifacts, events, file protection, rendered output, or public state.
- Do not add trivial hook tests.

Main-context discipline:
- Keep the coordinator context small.
- Dispatch bounded worker briefs sequentially for source writes.
- Use read-only subagents for audits.
- Coordinator integrates results and validates; it should not hand-roll every slice locally.

Required reading, in order:
1. CLAUDE.md
2. docs/COST-AWARE-IMPLEMENTER-DIRECTION.md
3. docs/WORKFLOW.md
4. docs/FEATURES.md recovery, escalation, conflicts, budget, sessions, evidence sections
5. docs/superpowers/specs/2026-04-28-run-readiness-doctor/README.md
6. docs/superpowers/specs/2026-04-28-plan-review-trust/README.md
7. docs/superpowers/specs/2026-04-28-recovery-flow/README.md
8. docs/superpowers/specs/2026-04-28-recovery-flow/spec.md
9. docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md
10. docs/superpowers/specs/2026-04-28-recovery-flow/implementation-plan.md
11. docs/superpowers/specs/2026-04-28-recovery-flow/tasks.md
12. docs/superpowers/specs/2026-04-28-recovery-flow/verification.md
13. docs/superpowers/specs/2026-04-28-recovery-flow/agent-briefs/00-coordinator.md

Likely source files to inspect before editing:
- src/engine/orchestrator/task-loop.ts
- src/engine/orchestrator/task-step.ts
- src/engine/orchestrator/escalation/*
- src/engine/orchestrator/user-edit-conflicts.ts
- src/features/workflow/user-edit-conflict-prompt.ts
- src/features/workflow/hooks/use-workflow-runner.ts
- src/core/state/*
- src/core/schemas/*

Implementation order:
1. Implement agent-briefs/01-recovery-state.md.
2. Implement agent-briefs/02-issue-builders.md.
3. Implement agent-briefs/03-orchestrator-stop-points.md.
4. Implement agent-briefs/04-action-handlers.md.
5. Implement agent-briefs/05-tui-actions.md.
6. Implement agent-briefs/06-tests-and-validation.md.

Important product decisions:
- Recovery is a durable pending issue overlay, not a project-management state.
- Planner split/rebase must produce parseable revised Task Brief content. Free-form instructions are not enough.
- Interactive split/rebase requires approve/edit/reject before execution resumes.
- Headless split/rebase exits non-zero unless an explicit non-interactive policy exists.
- Budget pause below max may continue; budget exceeded does not get ordinary continue.
- User edits are source-of-truth and must not be overwritten.
- No kanban, no plan archive, no MCP write tools, no full multi-agent manager, no same-checkout parallel writes.

Safe validation rules:
- Behavior scenarios must be automated tests or disposable fixture runs.
- Use stubbed planner/implementer runners.
- No real credentials.
- No network.
- No token spend.
- Writes confined to temporary fixtures or isolated test checkouts.
- Do not run scenarios against the user's checkout.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for behavior, state persistence, resume semantics, file protection, and test quality.
4. Fix blocker/strong findings with bounded worker or small coordinator patch.
5. Repeat until PASS before moving to the next brief.

Required validation before final handoff:
- npm run typecheck
- npm run lint
- npm test

If npm test is skipped, state the exact reason and list targeted tests that passed.

Final report must include:
- files changed,
- tests run and results,
- skipped validation and reason,
- risks or follow-up work,
- final audit result,
- confirmation that no git add, git stage, git commit, or git stash was run,
- confirmation that no same-checkout parallel writes were used.
```
