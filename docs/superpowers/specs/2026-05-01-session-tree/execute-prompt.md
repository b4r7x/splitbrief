# Execute Prompt: Session Tree Model

Use this prompt to hand the session tree spec pack to a fresh implementation context.

## Recommended Model

- Use `claude-opus-4-6` or `GPT-5.5`, reasoning `xhigh`, for the coordinator.
- Use same-tier subagents for worker briefs.

## Prompt To Paste

```text
You are implementing the session tree model spec pack for diptych:

docs/superpowers/specs/2026-05-01-session-tree/

Goal:
Implement an append-only tree data model for session entries, branch summarization on recovery, custom heterogeneous entry types, and a tree navigation TUI. Treat this as SOTA production work: correct data structures, crash-safe persistence, behavior-focused tests, and no speculative features.

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
- Zod 4.x for all schema validation.
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
2. docs/ARCHITECTURE.md
3. docs/STRUCTURE.md
4. docs/LAYERS.md
5. docs/TYPES.md
6. docs/TESTING.md
7. src/core/schemas/session-log.ts
8. src/core/sessions/log-reader.ts
9. src/core/sessions/io.ts
10. src/core/sessions/lifecycle.ts
11. src/engine/events/types.ts
12. src/engine/orchestrator/recovery/actions.ts
13. docs/superpowers/specs/2026-05-01-session-tree/README.md
14. docs/superpowers/specs/2026-05-01-session-tree/decisions.md

Implementation order:
1. Implement agent-briefs/01-tree-data-model.md.
2. Implement agent-briefs/02-branch-summarization.md.
3. Implement agent-briefs/03-custom-entry-types.md.
4. Implement agent-briefs/04-tree-navigation-tui.md.

Important architecture decisions:
- JSONL persistence, not SQLite. One entry per line, append-only.
- Tree not graph. Single parentId per entry.
- leafId in sidecar tree-meta.json, not inline in JSONL.
- Entry type is a string discriminant with per-type payload validation via registry.
- Summarize failed branches (200-500 tokens), do not carry full context into retry.
- Unknown entry types are preserved as opaque, never rejected.

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
3. Run read-only audit subagent for data integrity, crash safety, schema correctness, and test quality.
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
