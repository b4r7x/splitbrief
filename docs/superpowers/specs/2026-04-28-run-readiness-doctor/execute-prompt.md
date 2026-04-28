# Execute Prompt: Run Readiness / Doctor

Use this prompt to hand the first implementation pack to a fresh AI coding context.

## Recommended Model

- Best quality: `GPT-5.5`, reasoning `xhigh`.
- Do not use a weak/small model for the coordinator. This pack touches CLI flow, config resolution, validation posture, Ink/TUI output, headless JSON, and session evidence.

## Prompt To Paste

```text
You are implementing the first UX/trust spec pack for diptych:

docs/superpowers/specs/2026-04-28-run-readiness-doctor/

Goal:
Implement Run Readiness / Doctor before any other UX/trust pack.

Why first:
This feature creates the readiness signals that later packs reuse:
- Plan Review Trust needs routing/context/readiness posture.
- Recovery Flow needs clear pre-run and blocked-run language.
- Checkpoint Review Packet needs readiness evidence in session artifacts.

Hard repository rules:
- Do not run git add, git stage, git commit, or git stash.
- Do not revert user changes.
- Same-checkout implementation work must be sequential.
- If using subagents, they must not write in parallel in the same checkout.
- Parallel implementation is allowed only in isolated worktrees/equivalent sandboxes.

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Every local TypeScript import uses a .js suffix.
- No classes.
- No barrel files; do not create index.ts.
- No useMemo, useCallback, React.memo, forwardRef, or imperative handles.
- Prefer existing external store/useSyncExternalStore patterns; do not bloat React Context.
- Tests must verify behavior, rendered output, artifacts, filesystem effects, or public state.
- Do not add trivial hook tests.

Required reading, in order:
1. CLAUDE.md
2. docs/COST-AWARE-IMPLEMENTER-DIRECTION.md
3. docs/CONFIGURATION.md sections for planner, implementer, implementer profiles, validation, workflow, config validation
4. docs/FEATURES.md sections for backend config, validation, cost status, init/status/resume
5. docs/WORKFLOW.md sections for start, persistence, resume, validation, cost display
6. docs/superpowers/specs/2026-04-28-run-readiness-doctor/README.md
7. docs/superpowers/specs/2026-04-28-run-readiness-doctor/spec.md
8. docs/superpowers/specs/2026-04-28-run-readiness-doctor/decisions.md
9. docs/superpowers/specs/2026-04-28-run-readiness-doctor/implementation-plan.md
10. docs/superpowers/specs/2026-04-28-run-readiness-doctor/tasks.md
11. docs/superpowers/specs/2026-04-28-run-readiness-doctor/verification.md
12. docs/superpowers/specs/2026-04-28-run-readiness-doctor/agent-briefs/00-coordinator.md

Likely source files to inspect before editing:
- src/cli.ts
- src/cli/commands/start.ts
- src/cli/setup.ts
- src/cli/headless.ts
- src/core/config/runtime/resolve.ts
- src/core/config/accessors/implementer-profiles.ts
- src/core/config/load/validate.ts
- src/core/validation/test-discovery.ts
- src/engine/orchestrator/validation.ts

Implementation order:
1. Implement agent-briefs/01-readiness-core.md.
2. Validate that core readiness behavior is covered by tests.
3. Implement agent-briefs/02-doctor-cli.md.
4. Validate doctor is strictly read-only:
   - no config writes,
   - no migrations,
   - no sessions,
   - no worktrees,
   - no snapshots,
   - no model calls,
   - no network requirement.
5. Implement agent-briefs/03-start-tui-headless.md.
6. Validate start readiness runs before planner/implementer calls and can persist compact readiness evidence only inside the active start session.
7. Implement agent-briefs/04-tests-docs.md.
8. Run final validation.

Important product decisions:
- diptych doctor is read-only and does not persist readiness history.
- diptych start may persist a compact readiness event/artifact in its active execution session before model calls.
- Readiness may inspect config, package scripts, validation settings, implementer profile posture, repo/worktree status, budget posture, and context-length posture.
- Readiness must not run validation commands itself.
- Readiness must not require network probes.
- No kanban, no plan archive, no MCP write tools, no full multi-agent manager, no same-checkout parallel writes.

Safe validation rules:
- Do not validate by running real model workflows.
- Start-ordering tests must use temporary fixtures and stubbed planner/implementer commands.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.

Required validation before final handoff:
- npm run typecheck
- npm run lint
- npm test

If npm test is skipped, state the exact reason and list the targeted tests that passed.

Final report must include:
- files changed,
- tests run and results,
- skipped validation and reason,
- risks or follow-up work,
- confirmation that no git add, git stage, git commit, or git stash was run,
- confirmation that no same-checkout parallel writes were used.
```
