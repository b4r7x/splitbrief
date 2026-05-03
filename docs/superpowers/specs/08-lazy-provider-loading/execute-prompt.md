# Execute Prompt: Lazy Provider Loading

## Prompt To Paste

```text
You are implementing lazy provider loading for diptych:

docs/superpowers/specs/08-lazy-provider-loading/

Goal:
Replace 11 eager static imports in factory.ts with memoized lazy dynamic imports. Only the configured runner kind's module loads at startup.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.

Required skills to load BEFORE writing any code:
1. /sota
2. /test-behavior-not-implementation
3. /clean-code

Required reading:
1. CLAUDE.md
2. src/engine/runners/factory.ts (63 lines — 11 static imports, 2 lookup tables)
3. src/engine/planners/claude-code.ts
4. src/engine/planners/api.ts
5. src/engine/implementers/api.ts
6. src/engine/planners/agent-sdk.ts (optional dep)

Then grep for all callers: createPlanner( and createImplementer(

Implementation: docs/superpowers/specs/08-lazy-provider-loading/agent-briefs/01-lazy-factory.md

After done: npm run test-ci + verify only configured runner's module loads.
```
