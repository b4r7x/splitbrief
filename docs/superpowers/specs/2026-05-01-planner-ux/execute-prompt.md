# Execute Prompt: Planner UX Improvements

Use this prompt to hand the pack to a fresh implementation context.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs.

## Prompt To Paste

```text
You are implementing the Planner UX Improvements spec pack for diptych:

docs/superpowers/specs/2026-05-01-planner-ux/

Goal:
Implement four connected UX improvements: planner heartbeat, streaming partial output, per-task reject + regenerate in plan editor, and contextual footer keybindings. Treat this as SOTA production work: zero-class TypeScript, Ink 6.x React 19 components, behavior-focused tests, and clean store patterns.

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
- Tests must verify behavior, artifacts, rendered output, or public state.
- Do not add trivial hook tests.
- Do not run git add, git stage, git commit, or git stash.
- Zero memoization (no useMemo, useCallback, React.memo).
- kebab-case file names.

Main-context discipline:
- Keep the coordinator context small.
- Dispatch bounded worker briefs sequentially for source writes.
- Use read-only subagents for audits.
- Coordinator integrates results and validates; it should not hand-roll every slice locally.

Required reading, in order:
1. CLAUDE.md
2. docs/STORES.md
3. docs/HOOKS.md
4. docs/TESTING.md
5. docs/STRUCTURE.md
6. docs/superpowers/specs/2026-05-01-planner-ux/README.md
7. docs/superpowers/specs/2026-05-01-planner-ux/decisions.md
8. src/stores/workflow/plan-editor.ts
9. src/features/workflow/hooks/use-plan-editor-keys.ts
10. src/features/workflow/components/plan-editor.tsx
11. src/features/workflow/components/event-cards/planner-status-card.tsx
12. src/components/spinner.tsx
13. src/engine/streaming/spawn-collect.ts
14. src/engine/events/types.ts
15. src/engine/orchestrator/planning/shared.ts
16. src/engine/orchestrator/planning/regen.ts

Implementation order:
1. Implement agent-briefs/01-planner-heartbeat.md.
2. Implement agent-briefs/02-streaming-partial-output.md.
3. Implement agent-briefs/03-per-task-reject-regenerate.md.
4. Implement agent-briefs/04-contextual-footer-keybindings.md.

Important product decisions:
- Heartbeat enriches the existing PlannerStatusCard spinner, does not replace it.
- Streaming uses a ring buffer (last 5 lines), not full scroll.
- Per-task reject uses a flagging model (x to flag, R to regenerate flagged).
- Contextual footer derives state from the planEditorStore directly.
- Streaming partial output only for api-kind implementers.
- No new loading component; heartbeat data is additive to existing spinner.

Safe validation rules:
- Use fixture/stubbed/no-real-model validation.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for store patterns, event shape, component quality, and test quality.
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
