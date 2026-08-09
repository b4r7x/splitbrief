---
id: T001
title: Add multiply(a, b) export to math.js
action: modify
file: src/math.js
depends_on: []
---

### Description
Add and export a `multiply(a, b)` function to `src/math.js` that returns `a * b`, mirroring the existing `add` function so callers (and tests) can import it.

### Signature
```javascript
export function multiply(a, b) { /* ... */ }
```

### Type Definitions
```javascript
// No custom types. Function params are numbers; returns a number.
```

### Current Code
```javascript
export function add(a, b) {
  return a + b;
}
```

### Pattern
```javascript
export function multiply(a, b) {
  return a * b;
}
```

### Implementation Steps
1. In `src/math.js`, append an exported `multiply(a, b)` function after `add`, matching the existing declaration style (`export function`).
2. Return `a * b`.
3. Do not modify `add` or rename existing exports.

### Tests
- Add to `src/math.test.js`: import `multiply` from `./math.js` and assert `multiply(4, 3) === 12`, `multiply(0, 5) === 0`, `multiply(-2, 3) === -6`.
- Run with `npm test` (or `node --test`).

### Scope
**In bounds:**
- Adding the `multiply` export to `src/math.js`.
- Adding a `multiply` test case to `src/math.test.js`.
- Updating the `add` import line to also import `multiply`.
**Out of bounds:**
- Changing the `add` function behavior, adding other math functions, or introducing new files/dependencies.
**Approved out of bounds:** none.

### Escalation
- Stop and ask if the expected semantics differ from `a * b` (e.g., BigInt, rounding), if `src/math.js`/`src/math.test.js` differ from the shown state, or if the test runner setup differs from `node --test`.

### Evidence
- `node --test` passes (add + multiply cases green).
- Diff on `src/math.js` shows the new export; `src/math.test.js` shows the new test.

### Constraints
- ESM imports with `.js` extensions
- Follow existing codebase patterns
- Keep files unchanged in style and formatting

---

Note: per the "Output" instruction `tasks.md` is the transport; I've emitted its content above. I'm in plan mode (read-only), so I did not write `tasks.md` to disk — say the word and I'll write it.