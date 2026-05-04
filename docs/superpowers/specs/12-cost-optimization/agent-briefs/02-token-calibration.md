# 02 — Per-Model Token Calibration

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Replace the hardcoded `CHARS_PER_TOKEN = 4` heuristic with a per-model-family lookup table. Better estimation → better routing decisions → fewer unnecessary escalations → lower cost.

## Required Skills

- `/clean-code`
- `/test-behavior-not-implementation`
- `/coding-standards`

## Required Reading

- `CLAUDE.md`
- `src/core/tokens/estimate.ts` — current estimator (6 lines)
- `src/engine/spec/token-budget.ts` — budget calculation using the estimator
- `src/engine/orchestrator/context-routing.ts` — `estimateFormattedTaskPromptTokens()` (lines 132-136) and `assessProfile()` (lines 209-248) — where estimates drive routing
- `src/core/providers/known-models.ts` — model catalog with context lengths and pricing

## Write Ownership

```
src/core/tokens/estimate.ts               (modify)
src/core/tokens/estimate.test.ts           (create)
src/engine/spec/token-budget.ts            (modify)
src/engine/orchestrator/context-routing.ts (modify — pass model family to estimator)
```

## Required Behavior

### Part A: Add model-family ratio lookup to estimate.ts

Current `estimate.ts` is ~6 lines with a flat `Math.ceil(text.length / 4)`. Replace with:

```typescript
const DEFAULT_CHARS_PER_TOKEN = 4;

const MODEL_FAMILY_RATIOS: Record<string, number> = {
  claude: 3.5,
  gpt: 4.0,
  o1: 4.0,
  o3: 4.0,
  o4: 4.0,
  deepseek: 3.8,
  qwen: 3.6,
  llama: 3.8,
  gemma: 3.8,
  mistral: 3.7,
  codestral: 3.7,
  phi: 3.9,
  gemini: 3.8,
};

export function resolveCharsPerToken(modelId?: string): number {
  if (!modelId) return DEFAULT_CHARS_PER_TOKEN;
  const lower = modelId.toLowerCase();
  for (const [family, ratio] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (lower.includes(family)) return ratio;
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

export function estimateTokens(text: string, modelId?: string): number {
  return Math.ceil(text.length / resolveCharsPerToken(modelId));
}
```

The second `modelId` parameter is optional — all existing callers continue to work unchanged (they get `DEFAULT_CHARS_PER_TOKEN = 4`).

### Part B: Pass modelId through token-budget.ts

In `token-budget.ts`, update `computeTokenBudget` signature:

```typescript
export function computeTokenBudget(
  system: string,
  taskBody: string,
  contextLength: number,
  modelId?: string,
): TokenBudget {
  const systemTokens = estimateTokens(system, modelId);
  const taskBodyTokens = estimateTokens(taskBody, modelId);
  const outputReserve = Math.floor(contextLength * OUTPUT_RESERVE_RATIO);
  const total = systemTokens + taskBodyTokens + outputReserve;
  const remaining = contextLength - total;

  return { system: systemTokens, taskBody: taskBodyTokens, outputReserve, total, remaining };
}
```

Also update `truncateMiddle` to accept optional `modelId`:

```typescript
export function truncateMiddle(text: string, maxTokens: number, modelId?: string): string {
  const charsPerToken = resolveCharsPerToken(modelId);
  const maxChars = Math.floor(maxTokens * charsPerToken);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - TRUNCATION_HEADER_WIDTH) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  return text.slice(0, half) + '\n// ... truncated to fit context window ...\n' + text.slice(-half);
}
```

Import `resolveCharsPerToken` from `estimate.js`.

### Part C: Thread modelId into context-routing.ts

In `estimateFormattedTaskPromptTokens()` (line 132), the function already has access to the profile's model ID. Pass it through to `estimateTokens`:

Find where `estimateTokens` is called in context-routing.ts and add the model ID from the profile being assessed. The profile's model is available via `profile.model` or `getEffectiveModelId(profile)`.

In `assessProfile()`, when calling `estimateFormattedTaskPromptTokens`, pass the profile's model. The change is a single parameter addition at each call site — do not restructure the function.

### Part D: Do NOT change callers that don't have model context

Many callers of `estimateTokens` (repomap budget, planner base) don't know the target model. They continue to pass no `modelId` and get the default 4.0 ratio. This is fine — the improvement targets the routing decision, which is where model identity is available.

## Tests

Create `src/core/tokens/estimate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { estimateTokens, resolveCharsPerToken } from './estimate.js';

describe('resolveCharsPerToken', () => {
  it('returns 3.5 for Claude models', () => {
    expect(resolveCharsPerToken('claude-sonnet-4-6')).toBe(3.5);
    expect(resolveCharsPerToken('claude-opus-4-6')).toBe(3.5);
  });

  it('returns 4.0 for GPT models', () => {
    expect(resolveCharsPerToken('gpt-4o')).toBe(4.0);
  });

  it('returns 3.6 for Qwen models', () => {
    expect(resolveCharsPerToken('qwen2.5-coder:32b')).toBe(3.6);
  });

  it('returns default for unknown model', () => {
    expect(resolveCharsPerToken('some-custom-model')).toBe(4);
  });

  it('returns default when no modelId provided', () => {
    expect(resolveCharsPerToken()).toBe(4);
    expect(resolveCharsPerToken(undefined)).toBe(4);
  });
});

describe('estimateTokens', () => {
  it('estimates without model (backward compatible)', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('estimates with Claude model (fewer tokens per char)', () => {
    const text = 'a'.repeat(350);
    expect(estimateTokens(text, 'claude-sonnet-4-6')).toBe(100);
    expect(estimateTokens(text)).toBe(88); // 350/4 = 87.5 → 88
  });
});
```

## Verification

- [ ] `estimateTokens('text')` still works (backward compatible, no model)
- [ ] `estimateTokens('text', 'claude-sonnet-4-6')` uses 3.5 ratio
- [ ] `computeTokenBudget` accepts optional `modelId`
- [ ] Context routing passes model ID to estimation
- [ ] No other callers break (optional param)
- [ ] `npm run test-ci` passes
