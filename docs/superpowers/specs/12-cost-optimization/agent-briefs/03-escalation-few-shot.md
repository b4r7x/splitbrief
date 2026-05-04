# 03 — Escalation Few-Shot Examples

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Add worked examples to the hint and escalation prompts so the planner diagnoses errors more accurately on the first try. Higher first-pass success → fewer Opus calls → direct cost savings.

## Required Skills

- `/prompt-engineering`
- `/clean-code`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `src/engine/spec/prompts/escalation.ts` — current hint + escalation prompts (96 lines)
- `src/engine/spec/prompts/shared.ts` — `buildPrompt()`, `instructionsSection()`, `PromptSection` type
- `src/engine/spec/prompts/language-context.ts` — `LanguageContext`, `isJavaScriptLikeLanguage()`
- `src/engine/orchestrator/escalation/tier1-hint.ts` — how `buildHintPrompt` is called
- `src/engine/orchestrator/escalation/tier2-full.ts` — how `buildEscalationPrompt` is called

## Write Ownership

```
src/engine/spec/prompts/escalation-examples.ts        (create)
src/engine/spec/prompts/escalation-examples.test.ts   (create)
src/engine/spec/prompts/escalation.ts                 (modify)
```

## Required Behavior

### Part A: Create escalation-examples.ts

Create `src/engine/spec/prompts/escalation-examples.ts` with categorized worked examples and a pattern-matcher that selects relevant ones.

```typescript
import type { LanguageContext } from './language-context.js';
import { isJavaScriptLikeLanguage } from './language-context.js';

export interface EscalationExample {
  label: string;
  error: string;
  rootCause: string;
  fix: string;
}

const TS_EXAMPLES: EscalationExample[] = [
  {
    label: 'Missing .js extension (ESM)',
    error: "Cannot find module './utils' imported from src/engine/foo.ts",
    rootCause: 'ESM TypeScript requires explicit .js file extensions on relative imports.',
    fix: "Change `import { fn } from './utils'` to `import { fn } from './utils.js'`.",
  },
  {
    label: 'Non-nullable type mismatch',
    error: "Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    rootCause: 'Function parameter expects non-nullable string but received an optional value.',
    fix: 'Add a nullish check before passing: `if (val !== undefined) fn(val)` or use `fn(val ?? fallback)`.',
  },
  {
    label: 'Missing export',
    error: "Module '\"./config.js\"' has no exported member 'loadConfig'.",
    rootCause: 'The function exists but is not exported, or was renamed.',
    fix: 'Add `export` to the function declaration, or update the import to use the current name.',
  },
  {
    label: 'Test assertion mismatch',
    error: "expected 'idle' to equal 'implementing'",
    rootCause: 'State transition did not fire. The action was either not dispatched or the reducer does not handle it from the current phase.',
    fix: 'Check the transition table in machine.ts — verify the action is allowed from the current phase.',
  },
  {
    label: 'Async function not awaited',
    error: "Type 'Promise<void>' is not assignable to type 'void'.",
    rootCause: 'An async function is called without await, so the return type is Promise instead of the resolved value.',
    fix: 'Add `await` at the call site, or mark the calling function as `async`.',
  },
];

const PYTHON_EXAMPLES: EscalationExample[] = [
  {
    label: 'Import path error',
    error: "ModuleNotFoundError: No module named 'utils.helpers'",
    rootCause: 'Python cannot resolve the module path — missing __init__.py or wrong package structure.',
    fix: 'Add __init__.py to the package directory, or use relative import: `from .helpers import fn`.',
  },
  {
    label: 'Type annotation error',
    error: "TypeError: expected str, got Optional[str]",
    rootCause: 'Function receives Optional[str] but parameter type hint says str.',
    fix: 'Update type hint to `Optional[str]` and handle None case inside the function.',
  },
];

const GO_EXAMPLES: EscalationExample[] = [
  {
    label: 'Unused import',
    error: '"fmt" imported and not used',
    rootCause: 'Go does not allow unused imports — the import was added but not consumed.',
    fix: 'Remove the unused import, or use it. Go will not compile with dead imports.',
  },
];

const RUST_EXAMPLES: EscalationExample[] = [
  {
    label: 'Borrow checker violation',
    error: 'cannot borrow `x` as mutable because it is also borrowed as immutable',
    rootCause: 'An immutable borrow is still alive when a mutable borrow is attempted.',
    fix: 'Limit the scope of the immutable borrow, or clone the value before mutating.',
  },
];

const GENERIC_EXAMPLES: EscalationExample[] = [
  {
    label: 'Syntax error',
    error: 'SyntaxError: Unexpected token',
    rootCause: 'A structural syntax error — often a missing bracket, comma, or semicolon.',
    fix: 'Check the line referenced in the error and the line above it for unclosed brackets or missing punctuation.',
  },
];

function examplesForLanguage(ctx: LanguageContext): EscalationExample[] {
  if (isJavaScriptLikeLanguage(ctx)) return TS_EXAMPLES;
  switch (ctx.language) {
    case 'python': return PYTHON_EXAMPLES;
    case 'go': return GO_EXAMPLES;
    case 'rust': return RUST_EXAMPLES;
    default: return GENERIC_EXAMPLES;
  }
}

export function selectRelevantExamples(
  error: string,
  ctx: LanguageContext,
  maxExamples = 2,
): EscalationExample[] {
  const pool = examplesForLanguage(ctx);
  const lower = error.toLowerCase();

  const scored = pool.map(ex => {
    const keywords = ex.error.toLowerCase().split(/\s+/);
    const hits = keywords.filter(kw => kw.length > 4 && lower.includes(kw)).length;
    return { example: ex, score: hits };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, maxExamples).filter(s => s.score > 0);
  if (selected.length === 0) return scored.slice(0, 1).map(s => s.example);
  return selected.map(s => s.example);
}

export function formatExamplesSection(examples: EscalationExample[]): string {
  return examples
    .map((ex, i) => `**Example ${i + 1}: ${ex.label}**
Error: \`${ex.error}\`
Root cause: ${ex.rootCause}
Fix: ${ex.fix}`)
    .join('\n\n');
}
```

### Part B: Integrate into escalation.ts

In `buildHintPrompt()`, add a new section after 'Validation Error' and before `instructionsSection`:

```typescript
import { selectRelevantExamples, formatExamplesSection } from './escalation-examples.js';

// Inside buildHintPrompt, after the Validation Error section:
const examples = selectRelevantExamples(error, ctx);
// Add to sections array:
{ heading: 'Similar Issues', body: formatExamplesSection(examples) },
```

In `buildEscalationPrompt()`, add the same section after 'Validation Error' and before `instructionsSection`:

```typescript
const examples = selectRelevantExamples(error, ctx);
sections.push(
  { heading: 'Constraints', body: constraintsBlock(task) },
  { heading: 'Last Failed Attempt', body: '```\n' + lastAttempt + '\n```' },
  { heading: 'Validation Error', body: '```\n' + error + '\n```' },
  { heading: 'Similar Issues', body: formatExamplesSection(examples) },  // NEW
  instructionsSection(escalationInstructions(task, ctx)),
);
```

### Part C: Do NOT change existing tests or existing prompt structure

The existing `hintInstructions()` and `escalationInstructions()` remain unchanged. Only a new section is added to the sections array. Existing behavior is preserved — the examples are additive.

## Tests

Create `src/engine/spec/prompts/escalation-examples.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { selectRelevantExamples, formatExamplesSection } from './escalation-examples.js';
import { buildLanguageContext } from './language-context.js';

describe('selectRelevantExamples', () => {
  const tsCtx = buildLanguageContext(undefined); // defaults to TypeScript

  it('selects import-related example for module error', () => {
    const examples = selectRelevantExamples(
      "Cannot find module './utils.js' imported from src/foo.ts",
      tsCtx,
    );
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples[0].label).toContain('extension');
  });

  it('selects type-related example for type error', () => {
    const examples = selectRelevantExamples(
      "Type 'string | undefined' is not assignable to parameter of type 'string'",
      tsCtx,
    );
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples.some(e => e.label.includes('type'))).toBe(true);
  });

  it('returns at least one example even with no keyword match', () => {
    const examples = selectRelevantExamples(
      'completely novel error xyz123',
      tsCtx,
    );
    expect(examples.length).toBeGreaterThanOrEqual(1);
  });

  it('returns Python examples for Python context', () => {
    const pyCtx = buildLanguageContext('python');
    const examples = selectRelevantExamples(
      "ModuleNotFoundError: No module named 'foo'",
      pyCtx,
    );
    expect(examples[0].label).toContain('Import');
  });

  it('caps at maxExamples', () => {
    const examples = selectRelevantExamples('error', tsCtx, 1);
    expect(examples.length).toBeLessThanOrEqual(1);
  });
});

describe('formatExamplesSection', () => {
  it('formats examples with numbered labels', () => {
    const formatted = formatExamplesSection([
      { label: 'Test', error: 'err', rootCause: 'cause', fix: 'fix it' },
    ]);
    expect(formatted).toContain('**Example 1: Test**');
    expect(formatted).toContain('Root cause: cause');
  });
});
```

## Verification

- [ ] `buildHintPrompt` output contains a "Similar Issues" section
- [ ] `buildEscalationPrompt` output contains a "Similar Issues" section
- [ ] Examples are language-matched (TS context gets TS examples)
- [ ] Error keyword matching selects the most relevant example
- [ ] Unknown errors still return at least one generic example
- [ ] Existing prompt structure unchanged (title, intro, task meta, constraints, error all preserved)
- [ ] `npm run test-ci` passes
