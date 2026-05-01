# Execute Prompt: SOTA Cleanup

## Recommended Model

- Use a capable model with reasoning for the coordinator.
- Dispatch sequential worker briefs (same checkout — no parallel writes).

## Prompt To Paste

```text
You are implementing the SOTA cleanup spec for diptych:

docs/superpowers/specs/2026-05-01-sota-cleanup/

Goal:
Fix all bugs, DRY violations, type safety issues, and testing gaps identified by the SOTA audit. Surgical edits only — no new features, no architecture changes.

Hard repository rules:
- Do not run git add, git stage, git commit, or git stash.
- Do not revert user changes.
- Writer subagents must not write in parallel in the same checkout.
- Read-only audit subagents may run in parallel.

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Every local TypeScript import uses a .js suffix.
- No classes.
- No barrel files; do not create index.ts.
- No useMemo, useCallback, React.memo, forwardRef, or imperative handles.
- Colocated tests (foo.test.ts next to foo.ts).
- Tests must verify behavior, not implementation.

Required reading, in order:
1. CLAUDE.md
2. docs/superpowers/specs/2026-05-01-sota-cleanup/README.md
3. docs/superpowers/specs/2026-05-01-sota-cleanup/decisions.md

Implementation order (sequential — each brief depends on prior):
1. agent-briefs/01-layer-fix.md
2. agent-briefs/02-bugs-and-dry.md
3. agent-briefs/03-type-safety.md
4. agent-briefs/04-test-infra.md

After EACH brief:
- Run `npm run typecheck && npm test`
- Fix any failures before moving to next brief.

Required validation before final handoff:
- npm run test-ci (typecheck + lint + test)
- Must pass with zero failures.

Final report must include:
- Files changed
- Tests run and results
- Confirmation that no git add/commit/stash was run
```
