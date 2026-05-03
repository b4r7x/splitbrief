# Execute Prompt: Polyglot Validation Pipeline

## Recommended Model

Use Opus-class model with extended thinking for the coordinator and worker briefs.

## Prompt To Paste

```text
You are implementing the polyglot validation pipeline for diptych:

docs/superpowers/specs/01-polyglot-validation/

Goal:
Replace the hardcoded TypeScript validation pipeline (tsc, biome/eslint, npm test) with a 4-layer system: user config > planner-discovered > heuristic fallback > graceful skip. Supports any programming language. No errors when commands are missing — always skip.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash. Ever.
- A PreToolUse hook blocks these commands with exit code 2.
- Leave ALL changes as unstaged modifications.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only.
- Every local TypeScript import uses a .js suffix.
- No classes — pure functions, module-scoped state only.
- No barrel files; do not create index.ts.
- Zod 4.x for all schema validation.
- Vitest 4.x for testing, colocated (foo.test.ts next to foo.ts).
- Biome 2.x for lint/format.
- kebab-case file and folder names.
- No decorative comments, no section banners.

Required skills to load BEFORE writing any code:
1. /sota — verify best practices for each area you touch
2. /code-audit — audit your implementation for DRY, SRP, error handling
3. /test-behavior-not-implementation — guide test design: test WHAT it does, not HOW
4. /clean-code — no overengineering, no premature abstractions
5. /coding-standards — universal quality standards

Required reading, in order:
1. CLAUDE.md (full project rules)
2. docs/PRINCIPLES.md
3. docs/ARCHITECTURE.md (validator pipeline section)
4. docs/CONFIGURATION.md
5. docs/TESTING.md
6. src/engine/orchestrator/validation.ts (current validator — 167 lines)
7. src/core/validation/test-discovery.ts (current test finder — 34 lines)
8. src/core/schemas/config.ts (config schema, validation block lines 85-90)
9. src/core/config/load/load.ts (createDefaultConfig, lines 17-51)
10. src/core/schemas/workflow.ts (WorkflowState schema)
11. src/engine/spec/prompts/research.ts (research phase prompt)
12. src/engine/planners/base.ts (planner base, plan() method)
13. src/engine/orchestrator/planning/full.ts (research output processing)
14. src/engine/orchestrator/planning/shared.ts (persistPhases)

Implementation order (sequential — each brief depends on the previous):
1. docs/superpowers/specs/01-polyglot-validation/agent-briefs/01-config-and-heuristic.md
2. docs/superpowers/specs/01-polyglot-validation/agent-briefs/02-planner-discovery.md
3. docs/superpowers/specs/01-polyglot-validation/agent-briefs/03-validation-rewrite.md

After ALL briefs are done:
- Run: npm run test-ci
- Verify: A default TS project produces identical behavior to before
- Verify: Missing commands produce no errors — stages silently skip
- Update docs: CONFIGURATION.md, ARCHITECTURE.md, FUTURE.md (mark validation part as done)

Do NOT edit CLAUDE.md. The "Known limitations" removal is a manual post-merge step.
```
