# Execute Prompt: Plan Review Trust

Use this prompt after `2026-04-28-run-readiness-doctor` has been implemented and verified.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Worker subagents should also use `GPT-5.5`; use reasoning `medium` for narrow implementation slices and `xhigh` for final audits or ambiguous integration.

## Prompt To Paste

```text
You are implementing the second UX/trust spec pack for diptych:

docs/superpowers/specs/2026-04-28-plan-review-trust/

Goal:
Implement Plan Review Trust after Run Readiness / Doctor is already done. Treat this as SOTA production work: compact UX, correct state semantics, behavior-focused tests, and no product-scope drift.

Why second:
Run Readiness provides the readiness/routing/context posture. This pack makes Plan Review trustworthy before cheap/local implementation starts.

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
- Prefer existing external store/useSyncExternalStore patterns; do not bloat React Context.
- Tests must verify behavior, rendered output, artifacts, filesystem effects, or public state.
- Do not add trivial hook tests.

Main-context discipline:
- Do not bloat the coordinator context by implementing every slice locally.
- Coordinator reads the spec, dispatches bounded subagents, integrates results, and validates.
- Workers own their brief files. Coordinator reviews changed files and reports before moving on.

Required reading, in order:
1. CLAUDE.md
2. docs/COST-AWARE-IMPLEMENTER-DIRECTION.md
3. docs/FEATURES.md sections for Plan Review, workflow, cost/context metadata, sessions, evidence
4. docs/WORKFLOW.md sections for plan review and task execution
5. docs/superpowers/specs/2026-04-28-run-readiness-doctor/README.md
6. docs/superpowers/specs/2026-04-28-plan-review-trust/README.md
7. docs/superpowers/specs/2026-04-28-plan-review-trust/spec.md
8. docs/superpowers/specs/2026-04-28-plan-review-trust/decisions.md
9. docs/superpowers/specs/2026-04-28-plan-review-trust/implementation-plan.md
10. docs/superpowers/specs/2026-04-28-plan-review-trust/tasks.md
11. docs/superpowers/specs/2026-04-28-plan-review-trust/verification.md
12. docs/superpowers/specs/2026-04-28-plan-review-trust/agent-briefs/00-coordinator.md

Likely source files to inspect before editing:
- src/features/workflow/components/brief-review-view.tsx
- src/features/workflow/components/plan-editor.tsx
- src/stores/workflow/plan-editor.ts
- src/engine/orchestrator/context-routing.ts
- src/engine/spec/formatter.ts

Implementation order:
1. Implement agent-briefs/01-scorecard-model.md.
2. Validate scorecard semantics: ready, routing pending/unknown fit, split/overflow, risky/tight, stale/conflict, missing checks.
3. Implement agent-briefs/02-scorecard-ui.md.
4. Validate compact Ink/TUI rendering in safe fixture checks only.
5. Implement agent-briefs/03-worker-packet-preview-model.md.
6. Validate preview uses the same formatter/routing inputs that dispatch uses.
7. Implement agent-briefs/04-worker-packet-preview-ui.md.
8. Run final verification.

Important product decisions:
- Unknown, stale, or pending routing/context fit is not ready.
- Plan Review stays current-session execution readiness, not kanban, assignment, archive, or PM.
- Worker Packet Preview is read-only and previews what the implementer will receive.
- No MCP writes, no full multi-agent manager, no same-checkout parallel writes.

Safe validation rules:
- Manual TUI checks must use disposable fixtures, stubbed planner/implementer runners, no real credentials, no network, no real models, no token spend, and no writes to the user's checkout.
- Do not validate by running real model workflows.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation.
3. Run a read-only audit subagent for the slice.
4. Fix blocker/strong findings with a bounded worker or small coordinator patch.
5. Repeat until PASS before moving to the next brief.

Required validation before final handoff:
- npm run typecheck
- npm run lint
- targeted Vitest tests for changed model/UI files
- npm test once workflow UI/routing changes are stable

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
