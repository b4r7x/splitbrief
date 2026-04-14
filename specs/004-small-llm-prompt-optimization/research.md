# Research: diptych v0.2 -- Small LLM Prompt Optimization

**Date**: 2026-03-25 | **Method**: Token budget analysis + brainstorming session

## 1. Token Budget Analysis (Empirical)

**Decision**: Enforce strict per-task token budgets with auto-degradation cascade.

**Findings** (measured against actual diptych source files):

| Scenario | Code tokens | Total (with additions) | 8K fit? | 16K fit? |
|----------|-------------|----------------------|---------|----------|
| CREATE task (100 LOC) | 0 | ~1550 | Yes (4600 remaining) | Yes |
| MODIFY small (50 LOC) | ~430 | ~1980 | Yes (4160 remaining) | Yes |
| MODIFY medium (150 LOC) | ~1430 | ~2980 | Yes (3160 remaining) | Yes |
| MODIFY large (300 LOC) | ~2860 | ~4410 | Yes (1730 remaining) | Yes |
| MODIFY XL (500+ LOC) | ~4860 | ~6410 | **NO (-270 overflow)** | Yes |

"Additions" = system preamble with few-shot (~500 tok) + type defs (~300 tok) + impl steps (~150 tok).

**Key insight**: XL files (500+ LOC) overflow 8K. This only affects MODIFY tasks. Solution: function-level context.

**With function-level context** (imports + target function + 5 lines): code context drops to ~500-1000 tok. All scenarios fit in 8K with ~3900 remaining.

## 2. Function Boundary Detection

**Decision**: Regex-based detection of TypeScript export boundaries.

**Rationale**: AST parsing (ts-morph) adds a ~15MB dependency and 200-500ms per file. Regex handles >90% of TS/JS patterns and is <1ms.

**Patterns to detect**:
```
export function name(
export const name =
export async function name(
export interface name {
export type name =
export class name {
export default function
export default class
export { name }  (re-export — skip, use whole-file)
```

**Algorithm**:
1. Split file into blocks at export boundaries
2. Find block containing the target function (by name from task.signature)
3. Include: import section (lines 0 to first non-import) + target block + 5 lines before/after
4. If function not found: fall back to whole-file with truncation

**Alternatives considered**:
- ts-morph AST: Rejected — heavy dependency, overkill for v0.2
- Tree-sitter: Rejected — native module, complicates installation
- Line-count heuristic: Rejected — doesn't identify function boundaries

## 3. Few-Shot Example Format

**Decision**: 10-15 line generic TypeScript example in system preamble.

**Rationale**: Research shows few-shot examples improve small model output format compliance by 15-30%. A single example is sufficient for format (no need for multiple).

**Example structure**:
```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export function loadConfig(dir: string): Config {
  const filePath = join(dir, 'config.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    version: parsed.version ?? '1.0.0',
  };
}
```

This demonstrates: ESM imports with .js extension, type import, function with type annotation, no fences, no explanation.

## 4. Inlined Type Definitions Strategy

**Decision**: Opus generates `typeDefs` per task during buildTasksPrompt. Max ~300 tokens per task.

**Rationale**: Small models (7B-9B) hallucinate type fields when types aren't provided. Self-contained task principle (Constitution II) requires all context inlined.

**Strategy**:
1. Opus reads all project types during planning phase (it already does this in research)
2. For each task, Opus identifies types referenced in signature/description/tests
3. Opus copies the relevant interface/type definitions into the task's `### Type Definitions` section
4. Only directly-used types — no transitive dependencies (token budget constraint)
5. Token cap: ~300 tokens for type defs section. If exceeded, Opus prioritizes types in the function signature.

**Alternatives considered**:
- Auto-extract from source files at runtime: Rejected — requires knowing which types are needed (same problem)
- Include all project types: Rejected — token budget overflow
- Use type stubs (just field names, no full interface): Rejected — less accurate for small models

## 5. Retry Strategy Redesign

**Decision**: All retry attempts keep full context. Vary framing + temperature only.

**Rationale** (from v0.1 analysis):
- Current retry 2 loses: signature, tests, constraints, type defs
- Current retry 3 loses: almost everything
- A 7B model CANNOT fix a type error without knowing the types
- Research (TACL 2024): LLMs self-correct with external feedback, NOT internal reasoning
- The error message IS the external feedback — but only useful with full context

**New retry strategy**:

| Attempt | Temperature | Framing | Context |
|---------|-------------|---------|---------|
| 1 (initial) | base (0.3) | N/A | Full task |
| 2 (retry 1) | base + 0.1 | "Fix the error:" + error | Full task + error + latest code |
| 3 (retry 2) | base + 0.2 | "Different approach:" + error | Full task (rephrased) + error + latest code |
| 4 (retry 3) | base + 0.3 | "Try completely different:" + error | Full task + error + latest code |

All attempts include: description, signature, type defs, impl steps, tests, constraints.

## 6. Token Estimation Accuracy

**Decision**: Change `estimateTokens` from `chars/3.5` to `chars/4`.

**Rationale**: Measured against `cl100k_base` tokenizer on TypeScript source files:
- Average: 1 token ≈ 3.8-4.2 characters for TypeScript
- Current `chars/3.5` overestimates by ~10-15%, causing unnecessary truncation
- `chars/4` is conservative enough to prevent overflow while maximizing context

**Note**: This is still a heuristic. Exact tokenization varies by model (Qwen uses its own tokenizer). The 25% output reserve provides safety margin.

## Sources

- Brainstorming session 2026-03-25 (token budget analysis with empirical measurements)
- Constitution principle II: "Total prompt size MUST stay under 8K tokens for 7B models"
- LLM Self-Correction (TACL 2024): external feedback essential for self-correction
- Aider benchmarks: few-shot examples improve format compliance
- diptych v0.1 retry analysis: attempts 2-3 lose critical context
