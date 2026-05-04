# Execute Prompt: Structured Compaction

## Prompt To Paste

```text
You are implementing structured compaction for diptych:

docs/superpowers/specs/11-structured-compaction/

Goal:
Add a structured compaction mode alongside existing freeform. Structured mode: Zod-validated JSON summary with 6 fields (goal, stepsCompleted, currentStep, filesModified, constraintsDiscovered, remainingWork). Incremental merge on subsequent compactions. Auto-detection: API/agent-sdk planners get structured, CLI/shell get freeform. Fallback to freeform on validation failure. Selectable from /settings.

Critical constraint: compaction stays threshold-triggered, never main path. Summary augments recent messages, never replaces. This spec changes WHAT compaction produces, not WHEN it triggers.

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
3. src/core/sessions/compaction.ts (current compaction — 59 lines)
4. src/core/schemas/session-log.ts (SessionLogSummaryEntry — lines 32-39)
5. src/core/sessions/log-reader.ts (readCompactedMessages — lines 50-62)
6. src/engine/planners/base.ts (SUMMARY_PROMPT line 48, summarize() lines 272-280)
7. src/engine/planners/types.ts (PlannerCapabilities)
8. src/engine/orchestrator/resume-context.ts (auto-compaction — lines 27-46)
9. src/engine/orchestrator/transcript-rebuild.ts (buildResumeContext)
10. src/core/schemas/config.ts (compactionThreshold — line 110)
11. src/core/slash-commands/catalog.ts (/compact-transcript — lines 272-291)
12. src/core/settings/catalog.ts (settings registration pattern)

Implementation: docs/superpowers/specs/11-structured-compaction/agent-briefs/01-structured-compaction.md

After done: npm run test-ci + verify structured compaction produces valid JSON + freeform still works unchanged.
```
