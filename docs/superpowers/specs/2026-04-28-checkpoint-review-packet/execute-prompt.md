# Execute Prompt: Checkpoint Review Packet

Use this prompt after `run-readiness-doctor`, `plan-review-trust`, and `recovery-flow` are implemented and verified.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs and final audits.

## Prompt To Paste

```text
You are implementing the fourth UX/trust spec pack for diptych:

docs/superpowers/specs/2026-04-28-checkpoint-review-packet/

Goal:
Implement Checkpoint / Restore UX + Post-run Review Packet after the first three UX/trust packs are done. Treat this as SOTA production work: trustworthy artifacts, clear session UX, behavior-focused tests, and no plan-archive drift.

Why fourth:
This pack packages the signals produced by readiness, plan review, recovery, checkpoints, evidence, drift, validation, and final review.

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
- Prefer existing stores/selectors over Context bloat.
- Tests must verify behavior, artifacts, filesystem effects, rendered output, or public state.
- Do not add trivial hook tests.

Main-context discipline:
- Keep the coordinator context small.
- Dispatch bounded worker briefs sequentially for source writes.
- Use read-only subagents for audits.
- Coordinator integrates results and validates; it should not hand-roll every slice locally.

Required reading, in order:
1. CLAUDE.md
2. docs/COST-AWARE-IMPLEMENTER-DIRECTION.md
3. docs/FEATURES.md
4. docs/WORKFLOW.md
5. docs/superpowers/specs/2026-04-26-snapshots-undo/README.md
6. docs/superpowers/specs/2026-04-28-run-readiness-doctor/README.md
7. docs/superpowers/specs/2026-04-28-plan-review-trust/README.md
8. docs/superpowers/specs/2026-04-28-recovery-flow/README.md
9. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/README.md
10. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md
11. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/decisions.md
12. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/implementation-plan.md
13. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/tasks.md
14. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/verification.md
15. docs/superpowers/specs/2026-04-28-checkpoint-review-packet/agent-briefs/00-coordinator.md

Likely source files to inspect before editing:
- src/engine/snapshots/*
- src/features/summary/screen.tsx
- src/features/summary/components/*
- src/engine/orchestrator/final-review.ts
- src/engine/orchestrator/evidence.ts
- src/engine/orchestrator/drift.ts

Implementation order:
1. Implement agent-briefs/01-checkpoint-ux.md.
2. Implement agent-briefs/02-review-packet-model.md.
3. Implement agent-briefs/03-summary-tui.md.
4. Implement agent-briefs/04-tests-and-validation.md.

Important product decisions:
- This is session UX, not a plan archive, saved-plan library, kanban, or PM system.
- isRunCheckpoint must come from run-ledger data, not name guessing.
- Name-derived labels may be inferredKind only.
- Review packet includes readiness, checkpoints, validation, evidence, drift, cost/routing, final review, skipped/escalated tasks, and Recovery Decisions.
- Recovery Decisions come from runtime state/session/evidence artifacts, not from docs paths.
- No MCP writes, no full multi-agent manager, no same-checkout parallel writes.

Safe validation rules:
- Use fixture/stubbed/no-real-model validation.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.
- Optional manual smoke must be disposable and cleanup-scoped.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for artifact shape, restore safety, summary UX, session-vs-archive boundary, and test quality.
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
