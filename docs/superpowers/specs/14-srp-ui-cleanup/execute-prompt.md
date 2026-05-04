# Execute Prompt: UI SRP Cleanup

## Prompt To Paste

```text
You are refactoring 2 oversized UI components in diptych into colocated folder structures:

docs/superpowers/specs/14-srp-ui-cleanup/

Goal:
Split event-card.tsx (535 LOC, 132 switch cases) and plan-editor.tsx (514 LOC, 6 sub-components) into focused modules. Pure structural refactor — no feature changes. Visual output must be identical before and after.

CRITICAL constraint — this is a ZERO-BARRELS project:
- Do NOT create index.ts re-export files (docs/NO-BARRELS.md).
- Update import sites to point to specific sub-modules.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.
- React 19 + Ink 6. No useMemo, no useCallback, no React.memo.
- No decorative comments, no section banners.

Required skills to load BEFORE writing any code:
1. /sota
2. /clean-code
3. /test-behavior-not-implementation
4. /coding-standards
5. /code-audit

Required reading:
1. CLAUDE.md
2. docs/STRUCTURE.md (§Deep modules, §Feature anatomy)
3. docs/HOOKS.md
4. docs/NO-BARRELS.md
5. src/features/workflow/components/event-cards/ (all files in directory)
6. src/features/workflow/components/plan-editor.tsx
7. src/features/workflow/components/plan-editor/ (all files in directory)

Implementation order (independent — no dependencies between briefs):
1. docs/superpowers/specs/14-srp-ui-cleanup/agent-briefs/01-event-card-split.md
2. docs/superpowers/specs/14-srp-ui-cleanup/agent-briefs/02-plan-editor-split.md

After EACH brief:
- Run: npm run test-ci

After ALL briefs are done:
- Run: npm run test-ci
- Verify: event-card.tsx ≤ 120 LOC
- Verify: plan-editor.tsx ≤ 160 LOC
- Verify: find src -name 'index.ts' returns nothing
- Verify: All 132 event types still render (no cases lost)
```
