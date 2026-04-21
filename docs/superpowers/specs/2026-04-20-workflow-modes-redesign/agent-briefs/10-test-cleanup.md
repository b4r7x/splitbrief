# Brief 10 — Remove trivial hook tests (test-behavior-not-implementation)

> **You are a fresh AI context.** Read the `test-behavior-not-implementation` skill before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Find and remove tests that exist solely for trivial hooks (1-5 line hooks that delegate to a store selector or call a single function). These tests re-test framework behaviour, add maintenance cost, and give zero confidence gain.

## Dependencies

- None. Can run in parallel with any brief.

## Philosophy (from the `test-behavior-not-implementation` skill)

Per `test-behavior-not-implementation`:

- **Don't test what the framework already tests** — `useSyncExternalStore` works; store selectors work; testing that `useXxx()` returns `store.use(s => s.foo)` is redundant.
- **Redundant tests are worse than no tests** — every test is code to maintain. A test that duplicates coverage of the store's own test adds cost with zero gain.
- **Test the contract, not the wiring** — if a hook's only job is `return someStore.use(selector)`, the store's test already covers the selector. The hook adds no logic to test.

## What to look for

**Remove test if ALL of these apply:**

1. The hook under test is ≤5 lines of body.
2. The hook delegates entirely to a single store selector or a single function call.
3. The hook adds no conditional logic, no transformation, no side effects, no error handling.
4. The behaviour tested is already covered by the store's own `*.test.ts` or by a higher-level integration test.

**Keep test if ANY of these apply:**

1. The hook combines multiple store slices or derives computed state.
2. The hook has conditional logic (`if`, `switch`, ternary on props).
3. The hook manages a side effect (subscription, timer, event listener).
4. The hook is used by 3+ components and its contract is non-obvious.
5. Removing the test would leave a behaviour gap — no other test covers the same observable outcome.

## Step-by-step

### 1. Inventory all hooks

```bash
find src/hooks src/features -name 'use-*.ts' -o -name 'use-*.tsx' | sort
```

### 2. For each hook, check if a colocated test exists

```bash
for f in $(find src/hooks src/features -name 'use-*.ts' -o -name 'use-*.tsx'); do
  test="${f%.*}.test.${f##*.}"
  [ -f "$test" ] && echo "HAS TEST: $f → $test"
done
```

### 3. Evaluate each test against the criteria above

Read the hook source. If it is a trivial delegate:

```ts
// Example of a trivial hook that should NOT have its own test:
export function useWorkflowPhase() {
  return workflowStore.use(s => s.phase);
}
```

The store test for `workflowStore` already covers `.use(s => s.phase)`. This hook's test adds nothing.

### 4. Delete the test files that fail the criteria

For each deleted test file:
- Verify no other file imports from it (`rg 'from.*<test-file>' src/`).
- Run `npm run test-ci` to confirm no reference breaks.

### 5. Document what was removed

Add a comment in this brief's file (not in code) listing each removed test and why:

```
Removed: src/hooks/use-workflow-phase.test.ts
  Hook: 1-line store selector delegation
  Coverage: workflowStore.test.ts already tests the selector
  Decision: redundant per test-behavior-not-implementation §Decision Tree
```

### 6. Verify the overall test count did not drop to an alarming degree

```bash
npm test -- --reporter=verbose 2>&1 | grep -c '✓'
```

Compare before/after. Expect a small decrease (5-15 tests). If you're removing 50+ tests, pause and reassess — you're likely being too aggressive.

## What NOT to do

- Do NOT rewrite or "improve" surviving tests. Only delete.
- Do NOT add new tests in this brief. That is the job of other briefs.
- Do NOT touch tests for hooks that have meaningful logic.
- Do NOT touch integration tests, orchestrator tests, or engine tests — those are behaviour tests by definition.
- Do NOT modify any non-test files.

## Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

All must pass. The only expected change is fewer test files and a slightly lower test count.

## Rollback

`git checkout HEAD -- <list of deleted test files>`.

## Checkpoint

- Trivial hook tests removed.
- Integration tests, engine tests, store tests untouched.
- `npm run test-ci` passes.
- Deleted file list documented inline in this brief (added during execution).
