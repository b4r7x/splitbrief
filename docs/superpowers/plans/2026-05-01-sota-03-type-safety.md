# SOTA 03: Type Safety & Dead Code Cleanup

> **For agentic workers:** Execute task-by-task. After ALL tasks: run `npm run test-ci`.

**Goal:** Fix OTel double-casts, remove dead re-export, add missing test reset, fix advisory inconsistency.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

---

### Task 1: Fix OTel sink TaskId double-casts

**Problem:** 8x `event.taskId as unknown as string` in one file.

**Files:** `src/engine/events/sinks/otel.ts`

- [ ] **Step 1: Add a typed helper after line 27**

Find:
```typescript
  const taskSpans = new Map<string, Span>();
```

Add above it:
```typescript
  const taskKey = (id: import('../../../core/schemas/task.js').TaskId): string => id as string;
```

- [ ] **Step 2: Replace all 8 occurrences**

Use find-and-replace in the file:
- Find: `event.taskId as unknown as string`
- Replace with: `taskKey(event.taskId)`

There are exactly 8 occurrences (lines ~99, 107, 112, 119, 125, 129, 134, 138).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 2: Remove dead `estimateTokens` re-export

**Files:** `src/engine/codebase/budget.ts`, `src/engine/codebase/budget.test.ts`

- [ ] **Step 1: Remove re-export from budget.ts**

In `src/engine/codebase/budget.ts`, find these lines near the top:

```typescript
import { estimateTokens } from '../../core/tokens/estimate.js';

export { estimateTokens };
```

Remove both lines entirely.

- [ ] **Step 2: Fix test import if needed**

Check `src/engine/codebase/budget.test.ts` — if it imports `estimateTokens` from `./budget.js`, change that import to:

```typescript
import { estimateTokens } from '../../core/tokens/estimate.js';
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 3: Add `__testReset` to `controlsStore`

**Files:** `src/stores/ui/controls.ts`

- [ ] **Step 1: Add the method**

Find:
```typescript
export const controlsStore = {
  ...storeBase(store),
  toggleSidebar: () => {
```

Replace with:
```typescript
export const controlsStore = {
  ...storeBase(store),
  __testReset: () => store.set(initial),
  toggleSidebar: () => {
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 4: Fix advisory hook inconsistency in `input-footer.tsx`

**Files:** `src/features/workflow/components/input-footer.tsx`

- [ ] **Step 1: Add hook import**

Add to imports:
```typescript
import { useAdvisory } from '../hooks/use-advisory.js';
```

- [ ] **Step 2: Replace inline useSyncExternalStore call**

Find:
```typescript
  const advisory = useSyncExternalStore(subscribeAdvisory, getAdvisory, getAdvisory);
```

Replace with:
```typescript
  const advisory = useAdvisory();
```

- [ ] **Step 3: Remove unused imports**

Remove these imports if nothing else in the file uses them:
```typescript
import { subscribeAdvisory, getAdvisory } from '../../../engine/orchestrator/planning/mode-advisor.js';
```

Also remove `useSyncExternalStore` from the React import if nothing else uses it.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS
