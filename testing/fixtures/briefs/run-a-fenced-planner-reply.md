The project is unchanged since my earlier review: `src/slug.ts` exports a single pure string utility and `src/slug.test.ts` tests it with vitest and an ESM `.js` import. The spec maps to two briefs — create `src/text.ts`, then create `src/text.test.ts` depending on it.

Here is the complete `tasks.md` content:

````markdown
# Tasks

---
id: T001
title: Add titleCase function to src/text.ts
action: create
file: src/text.ts
depends_on: []
---

### Description
Create a new module `src/text.ts` exporting a `titleCase` function that capitalises the first letter of each word in the input string. Words are separated by whitespace; characters after the first letter of each word are left unchanged. The project is a small ESM TypeScript library (`e2e-app`) where each module exports a single pure string utility (see Pattern).

### Signature
```typescript
export function titleCase(input: string): string
```

### Type Definitions
```typescript
// No custom types — only built-in string parameters and return values.
```

### Current Code
```typescript
// New file — no existing code. Sibling module for style reference:
// src/slug.ts
export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
```

### Pattern
Follow `src/slug.ts`: a single exported pure function, one-line regex-based implementation, no classes, no default export, no comments.

### Implementation Steps
1. Create `src/text.ts`.
2. Implement `titleCase` with a single regex replace that uppercases the first letter of each word, e.g. `input.replace(/\b\w/g, c => c.toUpperCase())` or `input.replace(/(^|\s)\S/g, c => c.toUpperCase())`.
3. Export the function as a named export, matching the `slugify` style.

### Tests
- `titleCase('hello world')` → `'Hello World'` (verified by T002; no tests in this brief)
- `titleCase('')` → `''`

### Scope
**In bounds:**
- Creating `src/text.ts` with the single `titleCase` export.
**Out of bounds:**
- Modifying `src/slug.ts`, `src/slug.test.ts`, `package.json`, or tsconfig.
- Writing tests (that is T002).
- Adding extra helpers, options parameters, or locale handling.
**Approved out of bounds:**
- None.

### Escalation
- Stop and ask if the intended handling of already-capitalised or mixed-case input (e.g. `'hELLO'`) turns out to matter for tests — the spec only requires capitalising the first letter of each word, leaving other characters unchanged.

### Evidence
- New file `src/text.ts` exists with the exact signature above.
- `npm run typecheck` (`tsc --noEmit`) passes.

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns

---
id: T002
title: Add vitest test for titleCase in src/text.test.ts
action: create
file: src/text.test.ts
depends_on: [T001]
---

### Description
Create `src/text.test.ts` with a vitest test for the `titleCase` function created in T001. Mirror the structure of the existing `src/slug.test.ts`: import from vitest, import the function with a `.js` extension, one `describe` block with focused `it` cases.

### Signature
```typescript
// Function under test (from src/text.ts):
export function titleCase(input: string): string
```

### Type Definitions
```typescript
// No custom types — vitest globals are imported explicitly.
```

### Current Code
```typescript
// New file — no existing code. Existing test for style reference:
// src/slug.test.ts
import { describe, it, expect } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
});
```

### Pattern
Copy the shape of `src/slug.test.ts` exactly: `import { describe, it, expect } from 'vitest';`, relative import with `.js` extension, one `describe` named after the function.

### Implementation Steps
1. Create `src/text.test.ts`.
2. Import `describe, it, expect` from `vitest` and `titleCase` from `./text.js`.
3. Add a `describe('titleCase', ...)` block with cases from the Tests section.
4. Run `npm test` and confirm all tests pass.

### Tests
- `expect(titleCase('hello world')).toBe('Hello World')`
- `expect(titleCase('foo')).toBe('Foo')`
- `expect(titleCase('')).toBe('')`

### Scope
**In bounds:**
- Creating `src/text.test.ts` with tests for `titleCase`.
**Out of bounds:**
- Modifying `src/text.ts` (report failures instead of changing the implementation).
- Touching `src/slug.ts`, `src/slug.test.ts`, or config files.
**Approved out of bounds:**
- None.

### Escalation
- Stop and ask if `src/text.ts` or its `titleCase` export does not exist (T001 not completed), or if a test failure suggests the implementation contradicts the spec.

### Evidence
- New file `src/text.test.ts` exists.
- `npm test` (`vitest run`) passes with the new titleCase cases included.
- `npm run typecheck` passes.

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns
````