```markdown
---
id: T001
title: Add subtract function to hello.js
action: modify
file: hello.js
depends_on: []
---

### Description
`hello.js` currently exports a single named function `hello()`. Add a second named export, `subtract(a, b)`, that returns the arithmetic difference `a - b`. This is a plain ESM module (`package.json` has `"type": "module"`), with no build step, no framework, and no existing test runner. Keep the addition minimal: one exported function, no validation, no logging, no helper abstractions.

### Signature
```javascript
export function subtract(a, b) { /* returns a - b */ }
```

### Type Definitions
```javascript
// No typedefs exist in this project. Plain JS numbers:
// subtract(a: number, b: number) => number
```

### Current Code
```javascript
export function hello() { return "hi"; }
```

### Pattern
Follow the exact style of the existing export in `hello.js:1` — a single-line named function declaration with `export function`, a direct `return`, and no JSDoc:
```javascript
export function hello() { return "hi"; }
```

### Implementation Steps
1. Open `hello.js`.
2. Append a new line below the existing `hello` export.
3. Add exactly: `export function subtract(a, b) { return a - b; }`
4. Leave the `hello` function unchanged and keep the trailing newline at end of file.

### Tests
- `subtract(5, 3)` → `2`
- `subtract(3, 5)` → `-2`
- `subtract(0, 0)` → `0`
- `subtract(2.5, 0.5)` → `2`
- `hello()` still returns `"hi"` (unchanged behavior)

Run from the project root:
```bash
node --input-type=module -e "import { hello, subtract } from './hello.js'; console.assert(subtract(5,3)===2); console.assert(subtract(3,5)===-2); console.assert(subtract(0,0)===0); console.assert(subtract(2.5,0.5)===2); console.assert(hello()==='hi'); console.log('ok');"
```

### Scope
**In bounds:**
- Adding the `subtract` named export to `hello.js`.

**Out of bounds:**
- Modifying or renaming `hello()`.
- Adding `add`, `multiply`, `divide`, or any other operation not requested.
- Adding argument validation, `Number()` coercion, `NaN` checks, JSDoc, or comments.
- Creating new files, adding a test framework, or editing `package.json`.

**Approved out of bounds:**
- Creating `hello.test.js` (or equivalent) ONLY if the requester explicitly approves adding a test file; no test runner is currently configured.

### Escalation
- Stop and ask if `hello.js` does not match the "Current Code" block above (file has diverged).
- Stop and ask if a `subtract` export already exists with different semantics.
- Stop and ask if the requester wants operand order other than `a - b`, or wants non-numeric input handling.

### Evidence
- `git diff` shows exactly one added line in `hello.js`.
- The verification command above prints `ok` with no assertion warnings.

### Constraints
- ESM named exports with `.js` extensions in any import specifier.
- Match the existing single-line function style in `hello.js`.
- No new dependencies, no new files, no changes to `package.json`.
```

I returned the content above rather than writing it to disk; say the word and I'll write it to `tasks.md` at the project root.