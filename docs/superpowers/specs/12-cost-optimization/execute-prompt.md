# Execute Prompt: Cost Optimization Triple

## Prompt To Paste

```text
You are implementing 3 cost-optimization improvements for diptych:

docs/superpowers/specs/12-cost-optimization/

Goal:
Three independent improvements that directly reduce planner token cost:
1. Anthropic prompt caching — send system prompt as block array with cache_control markers
2. Per-model token calibration — replace hardcoded 4-chars/token with model-family lookup table
3. Few-shot escalation examples — add worked error examples to hint/escalation prompts

Each brief is independent — implement in order but they don't depend on each other.

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
2. /claude-api — CRITICAL for brief 01, verify Anthropic prompt caching format
3. /prompt-engineering — for brief 03, escalation example design
4. /test-behavior-not-implementation
5. /clean-code
6. /code-audit

Required reading:
1. CLAUDE.md
2. docs/PRINCIPLES.md
3. src/engine/providers/anthropic/stream.ts (Anthropic API integration)
4. src/core/tokens/estimate.ts (token estimation — 6 lines)
5. src/engine/spec/token-budget.ts (budget calculation — 36 lines)
6. src/engine/spec/prompts/escalation.ts (hint + escalation prompts — 96 lines)
7. src/engine/spec/prompts/shared.ts (prompt builder utility)
8. src/engine/spec/prompts/language-context.ts (language detection)
9. src/engine/orchestrator/context-routing.ts (how token estimates drive routing)
10. src/engine/orchestrator/escalation/tier1-hint.ts (hint call site)
11. src/engine/orchestrator/escalation/tier2-full.ts (escalation call site)
12. src/core/providers/known-models.ts (model catalog)

Implementation order (independent — each brief is standalone):
1. docs/superpowers/specs/12-cost-optimization/agent-briefs/01-anthropic-prompt-caching.md
2. docs/superpowers/specs/12-cost-optimization/agent-briefs/02-token-calibration.md
3. docs/superpowers/specs/12-cost-optimization/agent-briefs/03-escalation-few-shot.md

After ALL briefs are done:
- Run: npm run test-ci
- Verify: Anthropic stream sends system as block array (not string)
- Verify: estimateTokens('text', 'claude-sonnet-4-6') uses 3.5 ratio
- Verify: buildHintPrompt output contains "Similar Issues" section
- Update docs: docs/ARCHITECTURE.md (add prompt caching note), docs/PLANNERS-AND-IMPLEMENTERS.md (note escalation examples)
```
