# Execute Prompt: Transcript Compaction

## Prompt To Paste

```text
You are implementing transcript compaction for diptych:

docs/superpowers/specs/05-transcript-compaction/

Goal:
Add /compact-transcript slash command and auto-compaction. Long sessions get summarized by the planner into a summary entry. On resume, only summary + recent entries rebuild context.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.

Required skills to load BEFORE writing any code:
1. /sota
2. /test-behavior-not-implementation
3. /clean-code
4. /code-audit

Required reading:
1. CLAUDE.md
2. docs/WORKFLOW.md
3. src/core/schemas/session-log.ts (entry schema — 31 lines)
4. src/core/sessions/log-reader.ts (async generators)
5. src/core/sessions/tree/schemas.ts (tree entry format)
6. src/core/sessions/tree/entry-types.ts (7 entry types incl. branch-summary)
7. src/engine/planners/base.ts (plan(), you'll add summarize())
8. src/engine/planners/types.ts (PlannerCapabilities)
9. src/core/slash-commands/catalog.ts (command registration)
10. src/core/slash-commands/types.ts (CommandDef, CommandContext)

Implementation: docs/superpowers/specs/05-transcript-compaction/agent-briefs/01-compaction.md

After done: npm run test-ci + verify compacted sessions resume correctly.
```
