# 02 - Planner Validation Discovery

> Implement only this brief. Do not run git add/commit/stage/stash.
> Depends on: brief 01 (config schema + heuristic).

## Goal

Add a `discoveredValidation` field to WorkflowState. Modify the research phase prompt to ask the planner what validation tools the project uses. Parse the planner's answer and persist it to state.

## Required Skills

Load these before writing any code:
- `/test-behavior-not-implementation`
- `/clean-code`

## Required Reading

- `CLAUDE.md`
- `src/core/schemas/workflow.ts` — WorkflowState schema
- `src/engine/spec/prompts/research.ts` — research prompt builder
- `src/engine/spec/prompts/shared.ts` — shared prompt utilities
- `src/engine/planners/base.ts` — planner base, plan() method lines 139-143
- `src/engine/orchestrator/planning/full.ts` — research output processing
- `src/engine/orchestrator/planning/shared.ts` — persistPhases()
- `src/engine/orchestrator/validation-heuristic.ts` — DetectedValidation type (from brief 01)

## Write Ownership

```
src/core/schemas/workflow.ts                                (modify)
src/engine/spec/prompts/research.ts                         (modify)
src/engine/orchestrator/planning/parse-validation.ts         (create)
src/engine/orchestrator/planning/parse-validation.test.ts    (create)
src/engine/orchestrator/planning/full.ts                     (modify)
```

## Required Behavior

### Part A: Add discoveredValidation to WorkflowState

In `src/core/schemas/workflow.ts`, add:

```typescript
const DiscoveredValidationSchema = z.object({
  typecheckCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  testCommand: z.string().optional(),
  testPattern: z.string().optional(),
  language: z.string().optional(),
}).optional();
```

Add `discoveredValidation: DiscoveredValidationSchema` to `WorkflowStateSchema`.

### Part B: Modify research prompt

In `src/engine/spec/prompts/research.ts`, add a new section to the expected output format, after the existing sections:

```
## Validation Tools

Identify the project's validation toolchain by reading config files:
- **Language**: Primary programming language (e.g., typescript, python, rust, go)
- **Type checker**: Command to run type checking (e.g., `npx tsc --noEmit`, `cargo check`, `mypy src/`, `go vet ./...`), or "none"
- **Linter**: Command to run linting (e.g., `npx biome check`, `cargo clippy`, `ruff check`, `golangci-lint run`), or "none"
- **Test runner**: Command to run tests (e.g., `npm test`, `cargo test`, `pytest`, `go test ./...`)
- **Test file pattern**: How test files are named (e.g., `*.test.ts`, `*_test.go`, `test_*.py`)
```

### Part C: Parse validation from research output

Create `src/engine/orchestrator/planning/parse-validation.ts`:

```typescript
import type { DetectedValidation } from '../validation-heuristic.js';

export function parseDiscoveredValidation(researchMarkdown: string): DetectedValidation | null {
  const sectionMatch = researchMarkdown.match(/## Validation Tools\s*\n([\s\S]*?)(?=\n## |\n---|\Z)/);
  if (!sectionMatch) return null;

  const section = sectionMatch[1];
  const language = extractField(section, 'Language');
  const typecheck = extractField(section, 'Type checker');
  const linter = extractField(section, 'Linter');
  const testRunner = extractField(section, 'Test runner');
  const testPattern = extractField(section, 'Test file pattern');

  if (!language && !typecheck && !linter && !testRunner) return null;

  return {
    language: language || undefined,
    typecheckCommand: typecheck === 'none' ? undefined : typecheck || undefined,
    lintCommand: linter === 'none' ? undefined : linter || undefined,
    testCommand: testRunner || undefined,
    testPattern: testPattern || undefined,
  };
}

function extractField(section: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*(?:\`([^`]+)\`|(.+))`, 'i');
  const match = section.match(re);
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim() || null;
}
```

### Part D: Wire into research handling

In `src/engine/orchestrator/planning/full.ts`, after `persistPhases()` is called and the research phase output is available, call `parseDiscoveredValidation()` on the research text and save to state:

```typescript
const discovered = parseDiscoveredValidation(researchOutput);
if (discovered) {
  // Update state with discovered validation
  // Use existing state update mechanism (transitionAndSave or equivalent)
}
```

Find the exact integration point by reading `full.ts`. The research output is the first element of `PlanResult.phases`.

## TDD Steps

- [ ] **Write test: parse validation from well-formed markdown**

```typescript
// src/engine/orchestrator/planning/parse-validation.test.ts
import { describe, it, expect } from 'vitest';
import { parseDiscoveredValidation } from './parse-validation.js';

describe('parseDiscoveredValidation', () => {
  it('extracts validation tools from research markdown', () => {
    const markdown = `## Project Overview
Some overview.

## Validation Tools

- **Language**: rust
- **Type checker**: \`cargo check\`
- **Linter**: \`cargo clippy --no-deps\`
- **Test runner**: \`cargo test\`
- **Test file pattern**: \`*_test.rs\`

## Architecture
Some architecture.`;

    const result = parseDiscoveredValidation(markdown);
    expect(result).toEqual({
      language: 'rust',
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      testPattern: '*_test.rs',
    });
  });

  it('handles "none" values by returning undefined', () => {
    const markdown = `## Validation Tools

- **Language**: python
- **Type checker**: none
- **Linter**: \`ruff check\`
- **Test runner**: \`pytest\`
- **Test file pattern**: \`test_*.py\``;

    const result = parseDiscoveredValidation(markdown);
    expect(result?.typecheckCommand).toBeUndefined();
    expect(result?.lintCommand).toBe('ruff check');
  });

  it('returns null when section is absent', () => {
    const markdown = `## Project Overview\nSome overview.\n## Architecture\nSome arch.`;
    expect(parseDiscoveredValidation(markdown)).toBeNull();
  });

  it('returns null when section is empty', () => {
    const markdown = `## Validation Tools\n\n## Architecture`;
    expect(parseDiscoveredValidation(markdown)).toBeNull();
  });
});
```

- [ ] **Run test to verify it fails** — `npx vitest run src/engine/orchestrator/planning/parse-validation.test.ts`
- [ ] **Implement parse-validation.ts** — code above
- [ ] **Run test to verify it passes**
- [ ] **Implement state schema change + research prompt change + full.ts wiring**
- [ ] **Run full suite:** `npm run test-ci`

## Verification

- [ ] WorkflowState accepts `discoveredValidation` optional field
- [ ] Research prompt includes Validation Tools section
- [ ] Parser extracts commands from well-formed markdown
- [ ] Parser handles missing/none/empty sections gracefully
- [ ] Discovered validation is persisted to state after research phase
- [ ] `npm run test-ci` passes
