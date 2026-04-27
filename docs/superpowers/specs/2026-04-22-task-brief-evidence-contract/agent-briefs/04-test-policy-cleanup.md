# 04 — Test Policy Cleanup

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Remove or rewrite low-value direct tests for trivial React hooks. Keep behavior-bearing tests.

## Read First

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/HOOKS.md`
- `docs/PRINCIPLES.md`
- `src/hooks/use-app-keys.test.tsx`
- `src/components/pickers/two-column-picker/use-two-column-state.test.tsx`
- `src/features/workflow/hooks/use-review-content.test.tsx`
- `src/features/workflow/hooks/use-workflow-runner.test.tsx`
- `src/features/workflow/hooks/use-mouse-scroll.test.ts`

## Files To Touch

Test and doc files only:

- `src/hooks/*.test.tsx`
- `src/components/**/*.test.tsx`
- `src/features/**/hooks/*.test.tsx`
- `src/features/**/hooks/*.test.ts`
- `docs/TESTING.md`
- `docs/HOOKS.md`

Do not touch production code unless a test reveals a real bug. If that happens, stop and report.
Treat the file globs above as an inventory aid, not a mandate to edit everything they match. Only remove, rewrite, or keep the tests you have explicitly classified; leave unrelated tests alone.

## Classification

Keep direct tests for:

- async cancellation,
- promise resolver lifecycle,
- keyboard behavior that is hard to verify through one consumer,
- state-machine transitions,
- terminal/mouse integration helpers.

Remove direct tests that only:

- prove `useState`/`useEffect` works,
- assert private setter wiring,
- wrap a store selector,
- map a tiny return object,
- duplicate a consumer integration test.

Rewrite tests when behavior is useful but the assertion is implementation-shaped.

## Procedure

1. Run:

```bash
rg -n "renderHook|toHaveBeenCalledTimes|vi\\.mock|fireEvent|useState|useEffect" src/**/*.test.ts src/**/*.test.tsx
```

2. Classify each relevant hook test as Keep/Remove/Rewrite.
3. Delete tests with no behavior value.
4. Rewrite only when preserving meaningful behavior.
5. Update docs with the practical rule.
6. Run focused tests, then full verification.

## Constraints

- No internal `vi.mock()` unless already sanctioned in `docs/TESTING.md`.
- Avoid `toHaveBeenCalledTimes` unless call count is public behavior.
- Do not chase coverage percentage.
- Do not add tests for trivial hooks.

## Acceptance Criteria

- Low-value hook tests are removed or rewritten.
- Behavior-bearing coverage remains.
- Docs explain the policy.
- No production behavior changes.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm run typecheck
npm run lint
npm test
npm run test-ci
```
