# 01 - Language Context Builder + Prompt De-TS

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Create a LanguageContext builder and use it to de-TypeScript all prompts. TS projects keep their current quality. Non-TS projects get language-appropriate guidance.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/prompt-engineering`

## Required Reading

See execute-prompt.md required reading list.

## Write Ownership

```
src/engine/spec/prompts/language-context.ts       (create)
src/engine/spec/prompts/language-context.test.ts  (create)
src/engine/spec/prompts/tasks.ts                  (modify)
src/engine/spec/prompts/tasks.test.ts             (create or extend)
src/engine/spec/prompts/system.ts                 (modify)
src/engine/spec/prompts/system.test.ts            (create)
src/engine/spec/prompts/shared.ts                 (modify)
src/engine/spec/prompts/spec.ts                   (modify — scan for TS refs)
src/engine/spec/prompts/plan.ts                   (modify — scan for TS refs)
src/engine/spec/prompts/escalation.ts             (modify — scan for TS refs)
src/engine/spec/prompts/quick-plan.ts             (modify)
src/engine/spec/prompts/instant.ts                (modify)
src/engine/planners/base.ts                       (modify — thread language through)
```

## Required Behavior

### Part A: Language context type

```typescript
// src/engine/spec/prompts/language-context.ts
export interface LanguageContext {
  language: string;
  importConvention: string;
  typeAnnotationStyle: string;
  fileExtension: string;
  moduleSystem: string;
}

export function buildLanguageContext(language: string | undefined): LanguageContext {
  switch (language) {
    case 'typescript':
      return {
        language: 'TypeScript',
        importConvention: 'ESM with .js extension in import paths',
        typeAnnotationStyle: 'TypeScript type annotations',
        fileExtension: '.ts',
        moduleSystem: 'ESM',
      };
    case 'python':
      return {
        language: 'Python',
        importConvention: 'Python import statements (from/import)',
        typeAnnotationStyle: 'Python type hints (PEP 484)',
        fileExtension: '.py',
        moduleSystem: 'Python modules',
      };
    case 'go':
      return {
        language: 'Go',
        importConvention: 'Go import paths',
        typeAnnotationStyle: 'Go type declarations',
        fileExtension: '.go',
        moduleSystem: 'Go packages',
      };
    case 'rust':
      return {
        language: 'Rust',
        importConvention: 'Rust use/mod statements',
        typeAnnotationStyle: 'Rust type annotations',
        fileExtension: '.rs',
        moduleSystem: 'Rust crates/modules',
      };
    default:
      return {
        language: 'the project language',
        importConvention: 'standard import statements for the project language',
        typeAnnotationStyle: 'type annotations appropriate for the language',
        fileExtension: '',
        moduleSystem: 'the project module system',
      };
  }
}
```

### Part B: De-TypeScript the prompts

For each prompt file, search for and replace:
- `"TypeScript"` → `ctx.language` (conditional)
- `".js extensions for ESM"` → `ctx.importConvention`
- `"type annotations"` → `ctx.typeAnnotationStyle`
- `ESM_CONVENTION` constant → inject only when language is TS/JS

Make `buildTasksPrompt`, `buildSystemPreamble`, `buildSpecPrompt`, `buildPlanPrompt`, `buildQuickPlanPrompt`, `buildInstantPrompt`, `buildHintPrompt`, `buildEscalationPrompt` all accept optional `LanguageContext`.

**Keep prompts clean and readable.** Don't scatter ternaries. Build the language-specific sections as blocks and inject them.

### Part C: Thread language through planner

In `base.ts`'s `plan()` method, resolve language from:
1. `state.discoveredValidation.language` if available
2. `detectValidationHeuristic(projectDir)?.language` as fallback
3. `undefined` (generic) if neither

Pass the resolved `LanguageContext` to each prompt builder.

For quick/instant modes: same resolution, but language may not be available from state (no prior research phase). Use heuristic fallback.

## TDD Steps

- [ ] **Write test: language context builder**

```typescript
// src/engine/spec/prompts/language-context.test.ts
import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';

describe('buildLanguageContext', () => {
  it('typescript returns ESM conventions', () => {
    const ctx = buildLanguageContext('typescript');
    expect(ctx.importConvention).toContain('ESM');
    expect(ctx.typeAnnotationStyle).toContain('TypeScript');
  });

  it('python returns Python conventions', () => {
    const ctx = buildLanguageContext('python');
    expect(ctx.importConvention).toContain('Python');
    expect(ctx.typeAnnotationStyle).toContain('PEP 484');
  });

  it('unknown language returns generic context', () => {
    const ctx = buildLanguageContext(undefined);
    expect(ctx.language).toBe('the project language');
  });
});
```

- [ ] **Write test: task prompt is language-aware**

```typescript
// src/engine/spec/prompts/tasks.test.ts
import { describe, it, expect } from 'vitest';
import { buildTasksPrompt } from './tasks.js';
import { buildLanguageContext } from './language-context.js';

describe('buildTasksPrompt', () => {
  it('TS project prompt contains TypeScript references', () => {
    const ctx = buildLanguageContext('typescript');
    const prompt = buildTasksPrompt('spec', 'plan', ctx);
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('.js');
  });

  it('Python project prompt has no TypeScript references', () => {
    const ctx = buildLanguageContext('python');
    const prompt = buildTasksPrompt('spec', 'plan', ctx);
    expect(prompt).not.toContain('TypeScript');
    expect(prompt).toContain('Python');
  });

  it('generic prompt has no language-specific references', () => {
    const prompt = buildTasksPrompt('spec', 'plan');
    expect(prompt).not.toContain('TypeScript');
    expect(prompt).not.toContain('.js extension');
  });
});
```

- [ ] **Run tests, implement, verify pass**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] TS project prompt quality is identical to before
- [ ] Python project prompt mentions Python, PEP 484, not TypeScript
- [ ] No prompt contains "TypeScript" when language is not typescript
- [ ] Quick/instant modes work with language detection
- [ ] Docs updated: TASK-CONTRACT.md, ARCHITECTURE.md, FUTURE.md
- [ ] `npm run test-ci` passes
