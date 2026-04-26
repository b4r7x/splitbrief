# 01 — Canonical JSON and Hash

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 01 of 3** in the Brief Hash Versioning spec (`2026-04-26-brief-hash-versioning`). This brief creates the two pure utility functions that all other briefs depend on. It has no dependencies on the other briefs in this spec.

## Intent

Create two small, pure modules:

1. `src/utils/canonical-json.ts` — a generic, domain-agnostic canonical JSON serializer (recursive key sort, no tiny-spec concepts).
2. `src/core/brief-hash.ts` — a domain-aware function that strips mutable `Task` fields and returns a sha256 hex digest.

These are the only new source files this brief creates.

## Scope

**In bounds:**
- Create `src/utils/canonical-json.ts`.
- Create `src/core/brief-hash.ts`.
- Create `src/utils/canonical-json.test.ts` (colocated).
- Create `src/core/brief-hash.test.ts` (colocated).

**Out of bounds:**
- Do not touch `src/core/schemas/evidence.ts`.
- Do not touch `src/engine/orchestrator/evidence.ts` or `drift.ts`.
- Do not touch `src/core/paths.ts`.
- Do not modify any existing file except to add imports needed by the new files.
- Do not add npm dependencies.

## Code Context

### Layer rules (from `docs/LAYERS.md`)

`src/utils/` acceptance criteria:
- Pure, stateless, zero domain — "could be published to npm under a different name without touching the code."
- No imports from `core/`, `engine/`, `stores/`, `features/`.
- No tiny-spec string literals (`.diptych`, `claude-code`, `Task`, etc.).

`src/core/` acceptance criteria:
- Knows tiny-spec concepts.
- No React, no Ink, no subprocess spawning.
- May import from `utils/` and `lib/`.

`src/core/schemas/` is for Zod runtime schemas + inferred types only. Do NOT place the hash function there.

### Existing files to read

- `src/core/schemas/task.ts` — the full `Task` schema. The only mutable field is `status` (transitions `pending → in_progress → done/failed/escalated/skipped`). No retry count or timestamp lives on `Task`; those are on `WorkflowState`.
- `src/utils/frontmatter.ts` — example of a well-formed `utils/` module: pure, generic, no domain strings.
- `testing/helpers/factories/task.ts` — `makeTask` factory used in tests. You may import it in `brief-hash.test.ts`.

### Node crypto

```ts
import { createHash } from 'node:crypto';
// createHash('sha256').update(str).digest('hex') → 64-char hex string
```

No npm packages needed.

## Implementation Plan

### `src/utils/canonical-json.ts`

Signature:

```ts
export function canonicalJSON(value: unknown): string
```

Rules:
1. If `value` is a primitive (`null`, `boolean`, `number`, `string`): delegate to `JSON.stringify(value)`.
2. If `value` is an Array: recursively serialize each element preserving order; return `[e0,e1,…]`.
3. If `value` is a plain object: collect own enumerable keys, sort lexicographically (ascending), omit keys whose value is `undefined`, recursively serialize remaining key-value pairs; return `{"k0":v0,"k1":v1,…}`.
4. If `value` is `undefined`: throw `TypeError('canonicalJSON: undefined is not a valid JSON value')`.
5. If `value` is `NaN` or `±Infinity` (i.e., `typeof value === 'number' && !isFinite(value)`): throw `TypeError('canonicalJSON: NaN and Infinity are not valid JSON values')`.
6. If `value` is any other type (function, symbol, BigInt, etc.): throw `TypeError(\`canonicalJSON: unsupported type \${typeof value}\`)`.

Do not add any whitespace to the output. The caller adds the trailing newline if it writes to disk.

### `src/core/brief-hash.ts`

Signature:

```ts
export function hashTaskBrief(tasks: Task[]): string
```

Steps:
1. Strip the `status` field from each task: `tasks.map(({ status: _s, ...rest }) => rest)`.
2. Pass the resulting array through `canonicalJSON`.
3. Return `createHash('sha256').update(json).digest('hex')`.

The file is at `src/core/brief-hash.ts`. Its imports:
- `Task` from `./schemas/task.js`
- `canonicalJSON` from `../utils/canonical-json.js`
- `createHash` from `node:crypto`

## Tests

### `src/utils/canonical-json.test.ts`

Required test cases:
- **Primitive passthrough:** `canonicalJSON(42)` → `'42'`; `canonicalJSON('hello')` → `'"hello"'`; `canonicalJSON(null)` → `'null'`; `canonicalJSON(true)` → `'true'`.
- **Object key sort:** `canonicalJSON({ b: 1, a: 2 })` equals `canonicalJSON({ a: 2, b: 1 })` and equals `'{"a":2,"b":1}'`.
- **Nested object key sort:** `{ z: { d: 1, c: 2 } }` → `'{"z":{"c":2,"d":1}}'`.
- **Array order preserved:** `canonicalJSON([3, 1, 2])` → `'[3,1,2]'`. Array elements are not sorted.
- **Array of objects:** `canonicalJSON([{ b: 1, a: 2 }])` → `'[{"a":2,"b":1}]'`.
- **Undefined omitted:** `canonicalJSON({ a: 1, b: undefined })` → `'{"a":1}'`.
- **NaN rejected:** `expect(() => canonicalJSON(NaN)).toThrow(TypeError)`.
- **Infinity rejected:** `expect(() => canonicalJSON(Infinity)).toThrow(TypeError)`.
- **Undefined top-level rejected:** `expect(() => canonicalJSON(undefined)).toThrow(TypeError)`.
- **Stability:** computing the output twice on the same value yields identical strings.

### `src/core/brief-hash.test.ts`

Required test cases:
- **Returns a 64-char hex string** for a non-empty `Task[]`.
- **Status field is excluded:** `hashTaskBrief([makeTask({ status: 'pending' })])` equals `hashTaskBrief([makeTask({ status: 'done' })])`.
- **Different title → different hash:** `hashTaskBrief([makeTask({ title: 'A' })])` does not equal `hashTaskBrief([makeTask({ title: 'B' })])`.
- **Order matters:** `hashTaskBrief([t1, t2])` does not equal `hashTaskBrief([t2, t1])` when `t1 !== t2`.
- **Stability:** calling twice with the same input returns the same string.
- **Empty array:** `hashTaskBrief([])` returns a valid 64-char hex string (sha256 of `'[]'`).
- **Key-insertion-order independence:** constructing two task objects with keys added in different orders produces the same hash.

Import `makeTask` from `../../testing/helpers/factories/task.js` (relative from `src/core/` — two levels up to the project root, then into `testing/`).

## Validation

```bash
npm test -- src/utils/canonical-json.test.ts src/core/brief-hash.test.ts
npm run typecheck
npm run lint
```

Full CI after this brief:

```bash
npm run test-ci
```

## Constraints

- No `class` keyword.
- No barrel (`index.ts`) files.
- ESM `.js` extensions on all imports.
- `canonicalJSON` must have zero domain knowledge — if the word "task", "diptych", "brief", or ".diptych" appears in `canonical-json.ts`, it is wrong.
- `hashTaskBrief` must not import from `engine/`, `stores/`, `features/`, or any React/Ink module.

## Escalation

Stop and report if:
- The `node:crypto` API `createHash` is not available in the target Node version (Node 22+ — it will be available; this is informational).
- A test reveals that V8's key insertion order affects `JSON.stringify` output and `canonicalJSON` does not fix it (the tests in `brief-hash.test.ts` cover this case explicitly).

## Evidence Requirements

After completion, the implementing agent must confirm:
- `src/utils/canonical-json.ts` exists and has no imports from `core/` or `engine/`.
- `src/core/brief-hash.ts` exists and imports only from `./schemas/task.js`, `../utils/canonical-json.js`, and `node:crypto`.
- All tests in both test files pass.
- `npm run typecheck` passes with no new errors.
- `npm run lint` passes with no new warnings.
