# Execute Prompt: Session Continuity

Use this prompt to hand the session continuity spec pack to a fresh implementation context.

## Recommended Model

- Use `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use `GPT-5.5` subagents for worker briefs.

## Prompt To Paste

```text
You are implementing the session continuity spec pack for diptych:

docs/superpowers/specs/2026-05-01-session-continuity/

Goal:
Implement unified session reconnection UX: `diptych continue`, `diptych last`, and numeric session aliases in `ps` output. Treat this as SOTA production work: correct dispatch logic, behavior-focused tests, and no scope creep.

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
- kebab-case file and folder names.

Main-context discipline:
- Keep the coordinator context small.
- Dispatch bounded worker briefs sequentially for source writes.
- Use read-only subagents for audits.
- Coordinator integrates results and validates; it should not hand-roll every slice locally.

Required reading, in order:
1. CLAUDE.md
2. docs/superpowers/specs/2026-05-01-session-continuity/README.md
3. docs/superpowers/specs/2026-05-01-session-continuity/decisions.md
4. src/cli.ts (command registration pattern)
5. src/cli/commands/attach.ts
6. src/cli/commands/resume.ts
7. src/cli/commands/ps.ts
8. src/engine/ipc/lockfile.ts
9. src/core/sessions/lifecycle.ts
10. src/core/paths.ts
11. src/core/phases.ts (isResumable)

Implementation order:
1. Implement agent-briefs/01-continue-command.md.
2. Implement agent-briefs/03-numeric-aliases.md.
3. Implement agent-briefs/02-last-command.md.

Important product decisions:
- `continue` with no arg uses `readActive(projectDir)` — same pointer that `resume` uses.
- State dispatch: alive → attach, resumable → resume, else → error.
- Numeric aliases are derived from `lockfile.startTimeMs` desc sort (same as `ps`). Not persisted.
- `attach` and `resume` remain as low-level primitives. Not deprecated.
- `continue` is a JS reserved word. File is `continue.ts`, export is `continueCommand`.
- Numeric alias support applies to `continue` and `attach`, NOT to `detach` or `resume`.

Safe validation rules:
- Use fixture/stubbed/no-real-model validation.
- No real credentials.
- No network.
- No token spend.
- No writes to the user's checkout.

Required SOTA loop:
1. Implement one bounded brief with a subagent.
2. Run targeted validation for that slice.
3. Run read-only audit subagent for correctness, test quality, and scope boundaries.
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
