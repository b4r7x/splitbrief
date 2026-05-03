# Execute Prompt: Polyglot Prompts

## Prompt To Paste

```text
You are implementing polyglot prompt support for diptych:

docs/superpowers/specs/03-polyglot-prompts/

Goal:
Remove TypeScript-specific language from all planner and implementer prompts. Replace with language-aware context injected from research phase. Prompts must work for any language.

Dependency: Spec 01 (polyglot validation) must be completed first — this reads state.discoveredValidation.language.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.

Required skills to load BEFORE writing any code:
1. /sota
2. /code-audit
3. /test-behavior-not-implementation
4. /clean-code
5. /prompt-engineering — for prompt quality

Required reading:
1. CLAUDE.md
2. src/engine/spec/prompts/tasks.ts — task brief compilation (MOST TS-heavy)
3. src/engine/spec/prompts/system.ts — SYSTEM_PREAMBLE for implementer
4. src/engine/spec/prompts/shared.ts — ESM_CONVENTION, TASK_FORMAT_EXAMPLE
5. src/engine/spec/prompts/spec.ts — spec writing prompt
6. src/engine/spec/prompts/plan.ts — plan writing prompt
7. src/engine/spec/prompts/research.ts — research prompt (modified by Spec 01)
8. src/engine/spec/prompts/escalation.ts — hint/full escalation
9. src/engine/spec/prompts/quick-plan.ts — quick mode
10. src/engine/spec/prompts/instant.ts — instant mode
11. src/engine/planners/base.ts — where prompts are called
12. src/core/schemas/workflow.ts — discoveredValidation.language

Implementation: docs/superpowers/specs/03-polyglot-prompts/agent-briefs/01-language-context-and-prompts.md

After done: npm run test-ci + verify TS prompts unchanged + Python prompts have no "TypeScript".
Do NOT edit CLAUDE.md.
```
