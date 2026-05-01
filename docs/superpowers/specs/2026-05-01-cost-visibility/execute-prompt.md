# Execute Prompt: Cost Visibility

Use this prompt to hand the cost visibility spec to a fresh implementation context.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs.

## Prompt To Paste

```text
You are implementing the cost visibility spec pack for diptych:

docs/superpowers/specs/2026-05-01-cost-visibility/

Goal:
Make diptych's cost-savings narrative loud and unmissable. Three capabilities: hero savings banner post-run, cumulative stats CLI command, and cost-gated plan approval before implementation. This is diptych's core value proposition made visible.

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
- Zero engine → React imports (src/engine/ must not import ink, react, features, components, hooks).
- Tests must verify behavior, artifacts, filesystem effects, rendered output, or public state.
- Do not add trivial hook tests.
- Do not run git add, git stage, git commit, or git stash.

Main-context discipline:
- Keep the coordinator context small.
- Dispatch bounded worker briefs sequentially for source writes.
- Use read-only subagents for audits.
- Coordinator integrates results and validates; it should not hand-roll every slice locally.

Required reading, in order:
1. CLAUDE.md
2. docs/superpowers/specs/2026-05-01-cost-visibility/README.md
3. docs/superpowers/specs/2026-05-01-cost-visibility/decisions.md
4. src/features/summary/screen.tsx
5. src/features/summary/components/cost-breakdown.tsx
6. src/core/schemas/summary.ts
7. src/engine/providers/pricing.ts
8. src/features/workflow/hooks/use-cost-stats.ts
9. src/stores/workflow/tokens.ts
10. src/core/sessions/analytics.ts
11. src/cli/commands/status.ts
12. src/core/state/machine.ts
13. src/features/workflow/components/event-cards/cost-prediction-card.tsx
14. src/core/formatting.ts

Likely source files to inspect before editing:
- src/features/summary/screen.tsx
- src/features/summary/components/*
- src/engine/orchestrator/run/phases.ts
- src/engine/orchestrator/events.ts
- src/engine/events/types.ts
- src/core/state/machine.ts
- src/cli/program.ts
- src/core/paths.ts

Implementation order:
1. Implement agent-briefs/01-hero-savings.md
2. Implement agent-briefs/02-stats-command.md
3. Implement agent-briefs/03-cost-gated-approval.md

Key design decisions:
- Hero savings is visual elevation of existing CostBreakdown data, not a new pipeline.
- Stats persistence uses .diptych/stats.json with read-modify-write and version counter.
- Cost gate hooks into existing awaitingContinue state machine mechanism.
- Cost gate no-ops in instant/quick modes and when pricing is unavailable.
- Hero banner degrades gracefully (renders nothing when hasSavingsEstimate is false).
- Stats file survives session garbage collection.

Safe validation rules:
- Use fixture/stubbed/no-real-model validation.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for component rendering, degradation paths, persistence shape, and test quality.
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
