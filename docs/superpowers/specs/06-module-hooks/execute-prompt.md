# Execute Prompt: Module Hooks + Auto-Discovery

## Prompt To Paste

```text
You are implementing module hooks and auto-discovery for diptych:

docs/superpowers/specs/06-module-hooks/

Goal:
The module hook infrastructure (kind: 'module') already exists — dispatch.ts routes to runModuleHook, load-module.ts does the dynamic import. Wire up: auto-discovery from .diptych/hooks/, timeout parity with command hooks, tests, docs.

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
2. docs/HOOKS-CONFIG.md
3. src/engine/hooks/dispatch.ts (109 lines — line 15: module routing)
4. src/engine/hooks/load-module.ts (module loader)
5. src/engine/hooks/types.ts (HookOutcome, HookContext)
6. src/engine/hooks/sink.ts (event → hook mapping)
7. src/engine/hooks/run-pre-hook.ts (pre-hook gating)
8. src/core/schemas/hooks.ts (HookEventSchema, HookEntrySchema)

Implementation: docs/superpowers/specs/06-module-hooks/agent-briefs/01-discovery-and-polish.md

After done: npm run test-ci + verify .diptych/hooks/ files auto-register.
```
