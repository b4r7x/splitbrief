# Task Briefs

---
id: T001
title: Create titleCase function
action: create
file: src/text.ts
depends_on: []
---

### Description
Create `src/text.ts` exporting a `titleCase` function that capitalises the first letter of each word in the input string. A word is a run of characters separated by whitespace. The rest of each word is left unchanged apart from lowercasing (lowercase the input first, then uppercase each word's first letter) so mixed-case input produces consistent output. This is a small pure string utility matching the style of the package's existing utilities.

### Signature
```typescript
export function titleCase(input: string): string
```

### Type Definitions
```typescript
// None beyond built-in string — the function takes and returns string.
```

### Current Code
```typescript
// New file. Existing sibling utility src/slug.ts for style reference:
export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
```

### Pattern
Follow `src/slug.ts`: a single exported pure function, one concise chained-string-methods implementation, no classes, no default export, no comments.

```typescript
export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
```

### Implementation Steps
1. Create the file with a single named export `titleCase(input: string): string`.
2. Lowercase the input, then uppercase the first letter of each word using a regex replace such as `input.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())` (or split on whitespace and map).
3. Return the transformed string; no trimming or other normalisation.

### Tests
- `titleCase('hello world')` → `'Hello World'`
- `titleCase('HELLO WORLD')` → `'Hello World'`
- `titleCase('')` → `''`
- (Tests themselves are written in T002; these are the behaviors this implementation must satisfy.)

### Scope
**In bounds:**
- Creating `src/text.ts` with the single `titleCase` export.
**Out of bounds:**
- Modifying `src/slug.ts`, `src/slug.test.ts`, `package.json`, or tsconfig.
- Adding extra exports, options parameters, or locale-aware casing.
**Approved out of bounds:**
- None.

### Escalation
- Stop and ask if the required word-splitting behavior seems ambiguous for an input you cannot map to the test cases above (e.g. hyphenated words), or if the file unexpectedly already exists with conflicting content.

### Evidence
- `src/text.ts` created; `npm run typecheck` passes; T002's tests pass once that brief lands.

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns

---
id: T002
title: Add vitest test for titleCase
action: create
file: src/text.test.ts
depends_on: [T001]
---

### Description
Create `src/text.test.ts` with a Vitest suite covering the `titleCase` function delivered by T001. The suite must verify that the first letter of each word is capitalised, that all-caps input is normalised (lowercased then title-cased), and that an empty string passes through unchanged.

### Signature
```typescript
// Function under test (from T001):
export function titleCase(input: string): string
```

### Type Definitions
```typescript
// None — string in, string out.
```

### Current Code
```typescript
// New file. Existing sibling test src/slug.test.ts for style reference:
import { describe, it, expect } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
});
```

### Pattern
Follow `src/slug.test.ts`: import `describe`, `it`, `expect` from `'vitest'`; import the function under test from the sibling module with a `.js` extension; one `describe` block with short `it` cases asserting via `toBe`.

### Implementation Steps
1. Create the file importing `describe`, `it`, `expect` from `'vitest'` and `titleCase` from `'./text.js'`.
2. Add a `describe('titleCase', ...)` block with `it` cases for the concrete inputs/outputs listed under Tests, each asserting with `expect(...).toBe(...)`.
3. Run `npm test` and confirm the suite passes.

### Tests
- `expect(titleCase('hello world')).toBe('Hello World')`
- `expect(titleCase('HELLO WORLD')).toBe('Hello World')`
- `expect(titleCase('')).toBe('')`

### Scope
**In bounds:**
- Creating `src/text.test.ts` with the Vitest suite described above.
**Out of bounds:**
- Modifying `src/text.ts`, `src/slug.ts`, `src/slug.test.ts`, or Vitest configuration.
- Adding snapshot tests or test utilities.
**Approved out of bounds:**
- None.

### Escalation
- Stop and ask if `titleCase` is missing or its behavior contradicts the expected outputs above (dependency T001 incomplete or divergent) instead of adjusting expectations to match the implementation.

### Evidence
- `src/text.test.ts` created; `npm test` (`vitest run`) passes including the new `titleCase` suite; `npm run typecheck` passes.

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns
