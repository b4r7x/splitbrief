# SOTA 04: DRY Cleanup (slug, deepEqual, path, selector)

> **For agentic workers:** Execute task-by-task. After ALL tasks: run `npm run test-ci`.

**Goal:** Merge slug files, extract deepEqual to utils, consolidate path validation, fix cost-stats selector.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

---

### Task 1: Merge `slug.ts` into `slugify.ts`

**Problem:** `slug.ts` is a one-liner calling `slugify()` + `.slice(0, 40)`.

**Files:**
- Modify: `src/utils/slugify.ts`
- Delete: `src/utils/slug.ts`
- Modify: consumers (find with grep)

- [ ] **Step 1: Add `maxLength` parameter to `slugify`**

Replace entire `src/utils/slugify.ts` with:

```typescript
export function slugify(s: string, maxLength?: number): string {
  const result = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return maxLength !== undefined ? result.slice(0, maxLength) : result;
}
```

- [ ] **Step 2: Find and update consumers of `slug.ts`**

Run: `grep -r "from.*['\"]\./slug\.js['\"]" src/ --include="*.ts" -l` and also check for `../slug.js`, `../../slug.js`, etc: `grep -r "slug\.js" src/ --include="*.ts" --include="*.tsx" -l`

For each file that imports `slug` from a path ending in `slug.js` (NOT `slugify.js`):
- Change the import path to point to `slugify.js` instead
- Change the imported function name from `slug` to `slugify`
- Change the call from `slug(x)` to `slugify(x, 40)`

- [ ] **Step 3: Delete `src/utils/slug.ts`**

```bash
rm src/utils/slug.ts
```

- [ ] **Step 4: Handle `slug.test.ts` if it exists**

If `src/utils/slug.test.ts` exists, move its test cases into `src/utils/slugify.test.ts` (add a test for `maxLength`):

```typescript
it('respects maxLength parameter', () => {
  expect(slugify('this-is-a-very-long-slug-that-exceeds-the-limit', 40)).toHaveLength(40);
});
```

Then delete `src/utils/slug.test.ts`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 2: Extract `deepEqual` to utils

**Files:**
- Create: `src/utils/deep-equal.ts`
- Modify: `src/stores/project/config.ts`

- [ ] **Step 1: Create `src/utils/deep-equal.ts`**

```typescript
import { isRecord } from './type-guards.js';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}
```

- [ ] **Step 2: Replace local definition in config store**

In `src/stores/project/config.ts`:

1. Add import at top: `import { deepEqual } from '../../utils/deep-equal.js';`
2. Delete the local `deepEqual` function (the one starting with `function deepEqual(a: unknown, b: unknown): boolean {` — approximately lines 38-53)
3. If the local `isRecord` import was ONLY used by the deleted `deepEqual`, check if other functions in the file still use `isRecord`. If they do (like `persistedValueForSave`), keep the import. If not, remove it.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 3: Fix `useCostStats` selecting entire state

**Problem:** `modelCacheStore.use(state => state)` defeats the selector optimization.

**Files:** `src/features/workflow/hooks/use-cost-stats.ts`

- [ ] **Step 1: Narrow the selector**

Find line 79:
```typescript
  const modelCache = asReactiveModelCache(modelCacheStore.use(state => state));
```

Replace with:
```typescript
  const modelCache = asReactiveModelCache(modelCacheStore.use(s => ({
    modelsDevCatalog: s.modelsDevCatalog,
    modelsDevFetchedAt: s.modelsDevFetchedAt,
    providers: s.providers,
  })));
```

- [ ] **Step 2: Update `asReactiveModelCache` parameter type**

Find line 32:
```typescript
function asReactiveModelCache(snapshot: ReturnType<typeof modelCacheStore.get>): ModelCacheAccessor {
```

Replace with:
```typescript
function asReactiveModelCache(snapshot: Pick<ReturnType<typeof modelCacheStore.get>, 'modelsDevCatalog' | 'modelsDevFetchedAt' | 'providers'>): ModelCacheAccessor {
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 4: Consolidate path-traversal validation

**Problem:** `validateTaskPath` and `assertPathConfined` both reject escaping paths but differently.

**Files:** `src/core/paths-io.ts`

- [ ] **Step 1: Add import of `assertPathConfined`**

In `src/core/paths-io.ts`, add:
```typescript
import { assertPathConfined } from '../lib/path-confinement.js';
```

- [ ] **Step 2: Simplify `validateTaskPath`**

Find:
```typescript
export function validateTaskPath(projectDir: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw pathError.escapesProject(filePath);
  }
  const root = resolve(projectDir);
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw pathError.escapesProject(filePath);
  }
  return resolved;
}
```

Replace with:
```typescript
export function validateTaskPath(projectDir: string, filePath: string): string {
  try {
    assertPathConfined(filePath, projectDir);
  } catch {
    throw pathError.escapesProject(filePath);
  }
  return resolve(projectDir, filePath);
}
```

- [ ] **Step 3: Remove unused `relative` import if applicable**

Check if `relative` is used elsewhere in the file. If not, remove it from the `import { ... } from 'node:path'` line.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS
