# Product Task Briefs: clamp(n, min, max) Feature

## Phase 1: Core Function Implementation
Add the `clamp()` function to the math utilities module.

---
id: T001
title: Add clamp function to src/math.js
action: modify
file: src/math.js
depends_on: []
---

### Description
Add a `clamp()` function that constrains a numeric value to a specified range [min, max]. This follows the existing pattern of simple, pure mathematical utilities in the module. The function implements standard clamping logic: return the minimum if n is below range, the maximum if n is above range, or n itself if within range.

### Signature
```javascript
export function clamp(n, min, max) {
  // implementation
}
```

### Type Definitions
```javascript
// @param {number} n - The value to constrain
// @param {number} min - The lower boundary (inclusive)
// @param {number} max - The upper boundary (inclusive)
// @returns {number} The clamped value within [min, max]
```

### Current Code
```javascript
export function double(n) {
  return n * 2;
}

export function sum(a, b) {
  return a + b;
}
```

### Pattern
Follow the exact style of existing functions:
- Simple, direct implementation with no comments
- Named export at module level
- Single responsibility: take three numbers, apply comparison logic, return a number
- Pure function with no side effects

### Implementation Steps
1. Position cursor after line 7 (after the closing brace of `sum()`)
2. Add a blank line, then insert the `clamp()` function export
3. Implement using straightforward if-else logic: if n < min return min; else if n > max return max; else return n
4. Ensure function takes exactly three parameters in order: n, min, max
5. Verify the function is a named export (not default export)

### Tests
These test cases will verify the implementation (test details in T002):
- `clamp(5, 1, 10)` → `5` (value within range)
- `clamp(-5, 0, 10)` → `0` (value below min)
- `clamp(15, 0, 10)` → `10` (value above max)
- `clamp(0, 0, 10)` → `0` (value at min boundary)
- `clamp(10, 0, 10)` → `10` (value at max boundary)
- `clamp(-5, -10, -1)` → `-5` (negative range)

### Scope
**In bounds:**
- Add the `clamp()` function after the `sum()` function
- Use direct conditional logic (if-else or nested ternary)
- Ensure it's exported as a named export

**Out of bounds:**
- Do not modify the `double()` or `sum()` functions
- Do not add comments or docstrings
- Do not add any imports or change existing imports
- Do not add error handling or validation

### Escalation
- If unclear whether to use if-else vs nested ternary vs Math.max/Math.min: Use straightforward if-else for clarity and consistency with codebase simplicity.
- If the function needs to handle edge cases like non-numeric inputs or invalid ranges (min > max): Stop—the brief assumes the caller provides valid inputs per codebase philosophy.

### Evidence
- `src/math.js` contains the `clamp()` function as a named export after the `sum()` function
- The function accepts three parameters: n, min, max
- Running `npm test` does not error on the new function (existing tests still pass; new tests added in T002)

### Constraints
- ESM named export syntax required
- No comments in the function body
- No new imports needed
- Function must be pure (no side effects)

---

## Phase 2: Test Coverage
Add comprehensive tests for the `clamp()` function.

---
id: T002
title: Add clamp test to src/math.test.js
action: modify
file: src/math.test.js
depends_on: [T001]
---

### Description
Add test case for the `clamp()` function to `src/math.test.js`. Update the import statement to include `clamp` from math.js, then add a test block with multiple assertions covering the primary scenarios (value within range, below minimum, above maximum) and edge cases (boundary values, negative numbers). Follow the existing test pattern used for the `sum()` function.

### Signature
```javascript
test('clamp', () => {
  // multiple assert.strictEqual() calls
});
```

### Type Definitions
None additional beyond function signature.

### Current Code
```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { double, sum } from './math.js';

test('double', () => {
  assert.equal(double(3), 6);
});

test('sum', () => {
  assert.strictEqual(sum(2, 3), 5);
  assert.strictEqual(sum(-1, 1), 0);
  assert.strictEqual(sum(0, 0), 0);
});
```

### Pattern
Follow the existing test structure from the `sum` test:
- Use `test('name', () => { ... })` from node:test
- Use `assert.strictEqual(actual, expected)` for each assertion
- Include multiple related assertions in a single test block
- Test both normal cases and edge cases
- No comments in test code

### Implementation Steps
1. Modify line 3: Update the import from `'./math.js'` to include `clamp` in the destructured import: `import { double, sum, clamp } from './math.js';`
2. Position cursor after line 13 (after the closing brace of the `sum` test)
3. Add a blank line
4. Add a new `test('clamp', () => { ... })` block
5. Inside the test block, add six `assert.strictEqual()` calls with the test cases listed in the Tests section below

### Tests
Add the following test cases inside the `test('clamp', ...)` block:
```javascript
test('clamp', () => {
  assert.strictEqual(clamp(5, 1, 10), 5);       // value within range
  assert.strictEqual(clamp(-5, 0, 10), 0);      // value below minimum
  assert.strictEqual(clamp(15, 0, 10), 10);     // value above maximum
  assert.strictEqual(clamp(0, 0, 10), 0);       // value at minimum boundary
  assert.strictEqual(clamp(10, 0, 10), 10);     // value at maximum boundary
  assert.strictEqual(clamp(-5, -10, -1), -5);   // negative range
});
```

### Scope
**In bounds:**
- Update the import statement on line 3 to add `clamp`
- Add a new `test('clamp', ...)` block after the `sum` test
- Add six `assert.strictEqual()` assertions as specified

**Out of bounds:**
- Do not modify the `double` or `sum` tests
- Do not change the test runner or assertion library imports
- Do not add comments in the test code
- Do not add new test files

### Escalation
- If the test file structure differs from what's shown in Current Code: Stop—read the actual file and report the discrepancy.
- If any assertion fails when running `npm test`: Stop and report which assertion failed and what value was returned.

### Evidence
- `src/math.test.js` imports `clamp` from `'./math.js'` on line 3
- A test block named `'clamp'` exists in the file with six `assert.strictEqual()` calls
- Running `npm test` produces output showing all tests pass (including the new clamp test and all existing tests)
- No new errors or warnings from the test runner

### Constraints
- ESM import with `.js` extension required
- Use `assert.strictEqual()` (not `.equal()`, not other assertion methods)
- Test block must use the `test()` function from `node:test`
- Test name must be exactly `'clamp'`
- All six test assertions must be present and use the concrete input/output values specified
