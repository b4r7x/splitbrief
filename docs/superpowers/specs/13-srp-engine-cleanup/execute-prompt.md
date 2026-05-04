# Execute Prompt: Engine SRP Cleanup

## Prompt To Paste

```text
You are refactoring 5 oversized engine files in diptych into colocated folder structures:

docs/superpowers/specs/13-srp-engine-cleanup/

Goal:
Split 5 engine files that violate the project's own >300 LOC + >1 concern rule (STRUCTURE.md) into focused modules using the folder-colocation pattern (STRUCTURE.md §Deep modules). No feature changes — pure structural refactor. All exports must remain accessible at the same import depth or shallower.

CRITICAL constraint — this is a ZERO-BARRELS project:
- Do NOT create index.ts re-export files. They are banned (docs/NO-BARRELS.md).
- Instead, update each import site to import from the specific sub-module.
- grep to find all import sites before moving: `grep -rn "from.*<old-path>" src/ --include='*.ts'`

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. No barrel files. kebab-case.
- Zod 4.x, Vitest 4.x, Biome 2.x.
- No decorative comments, no section banners.

Required skills to load BEFORE writing any code:
1. /sota
2. /code-audit — verify SRP compliance after each split
3. /clean-code — no overengineering the split
4. /test-behavior-not-implementation
5. /coding-standards

Required reading:
1. CLAUDE.md
2. docs/STRUCTURE.md (§Deep modules, §File length thresholds)
3. docs/LAYERS.md (§engine)
4. docs/NO-BARRELS.md
5. docs/PRINCIPLES.md (rules 2, 3, 5)
6. docs/TESTING.md (test colocation rules)

Implementation order (STRICT — dependency chain):
1. docs/superpowers/specs/13-srp-engine-cleanup/agent-briefs/01-evidence-split.md
2. docs/superpowers/specs/13-srp-engine-cleanup/agent-briefs/02-context-routing-split.md
3. docs/superpowers/specs/13-srp-engine-cleanup/agent-briefs/03-tiered-approval-split.md
4. docs/superpowers/specs/13-srp-engine-cleanup/agent-briefs/04-escalation-step-split.md (depends on 01 + 03)
5. docs/superpowers/specs/13-srp-engine-cleanup/agent-briefs/05-task-loop-split.md (depends on 02)

After EACH brief:
- Run: npm run test-ci
- Fix any broken imports before proceeding to next brief

After ALL briefs are done:
- Run: npm run test-ci
- Verify: No file exceeds 200 LOC (except entry files which may reach 200)
- Verify: grep -rn "from.*evidence/evidence'" src/ returns nothing
- Verify: grep -rn "from.*orchestrator/context-routing'" src/ returns nothing (old flat file path)
- Verify: find src -name 'index.ts' returns nothing (zero barrels preserved)
```
