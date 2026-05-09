# Execute Prompt: React Architecture Naming Refactor

## Recommended Model

Use a strong implementation model with TypeScript/React refactor ability. Writer work must be sequential in one checkout.

## Prompt To Paste

```text
You are implementing this architecture refactor spec for diptych:

docs/superpowers/specs/2026-05-09-react-architecture-refactor/

Goal:
Refactor React/Ink source organization to a Bulletproof React-inspired architecture. Rename and relocate modules so source names describe domain responsibilities instead of trigger syntax or UI placement. Behavior must remain unchanged.

Hard repository rules:
- Do not run git add, git stage, git commit, git stash, or git mv.
- Use plain mv / editor moves only; the user commits manually.
- Do not revert user changes.
- Do not create index.ts barrels or compatibility re-export shims.
- Preserve ESM .js import suffixes.
- Writer subagents must not write in parallel in the same checkout.
- Historical docs under docs/superpowers/specs/** are archival; do not rewrite them except this current spec pack.

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Ink 6 + React 19 TUI.
- No classes.
- No useMemo, useCallback, React.memo, forwardRef, or imperative handles unless already present and unavoidable.
- Colocated tests.
- Tests should verify behavior, not implementation details.

Required reading, in order:
1. AGENTS.md
2. CLAUDE.md
3. docs/superpowers/specs/2026-05-09-react-architecture-refactor/README.md
4. docs/superpowers/specs/2026-05-09-react-architecture-refactor/decisions.md
5. docs/superpowers/specs/2026-05-09-react-architecture-refactor/spec.md
6. docs/superpowers/specs/2026-05-09-react-architecture-refactor/tasks.md
7. docs/superpowers/specs/2026-05-09-react-architecture-refactor/verification.md

Implementation order:
1. agent-briefs/00-coordinator.md
2. agent-briefs/01-composer.md
3. agent-briefs/02-runtime-commands.md
4. agent-briefs/03-palette-help.md
5. agent-briefs/04-app-runners-docs.md

After each phase:
- Run the phase validation commands from verification.md.
- Fix failures before continuing.

Required final validation:
- npm run test-ci
- rg --files src | rg '/index\\.(ts|tsx)$' should return no files
- old path search from verification.md should return no active source/doc matches
- git diff --check

Final report must include:
- Summary of architecture changes
- Files moved/renamed
- Any behavior intentionally left unchanged
- Tests run and exact results
- Any unrelated flakes, with isolated re-run result
- Confirmation that no staging/commit/stash command was run
```

