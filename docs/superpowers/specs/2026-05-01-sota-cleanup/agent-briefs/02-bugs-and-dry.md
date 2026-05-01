# 02 - Bugs & DRY Fixes

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.
> Prerequisite: brief 01 (layer fix) must be done first.

## Goal

Fix 2 real bugs and 4 DRY violations in a single pass.

## Standard Project Constraints

- Node.js 22+, TypeScript ESM only; imports include `.js` suffixes.
- No classes. No barrel files.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/stores/navigation/router.ts`
- `src/engine/orchestrator/task/step.ts`
- `src/utils/slugify.ts` and `src/utils/slug.ts`
- `src/core/paths-io.ts` and `src/lib/path-confinement.ts`
- `src/stores/project/config.ts` (lines 38-53)

## Write Ownership

```
src/stores/navigation/router.ts
src/engine/orchestrator/task/routing-fields.ts (new)
src/engine/orchestrator/task/step.ts
src/utils/slugify.ts
src/utils/slug.ts (delete)
src/utils/deep-equal.ts (new)
src/stores/project/config.ts
src/core/paths-io.ts
```

## Tasks

### 2A: Fix dead `worktreeName` field

In `src/stores/navigation/router.ts`:
1. Add `worktreeName?: string | undefined` to the `workflow` variant of `NavigateArgs`.
2. Add `worktreeName: args.worktreeName,` to the `store.set(...)` in `case 'workflow':` of `navigate()`.

### 2B: Extract `buildRoutingEventFields` helper

1. Create `src/engine/orchestrator/task/routing-fields.ts`:
```typescript
import type { TaskContextFit, CurrentCodeContextMode } from '../../events/workflow-events.js';

export interface RoutingDecision {
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength?: number | undefined;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  costPosture: string;
  reason: string;
}

export function buildRoutingEventFields(decision: RoutingDecision | undefined): Record<string, unknown> {
  if (decision === undefined) return {};
  return {
    contextFit: decision.fit,
    estimatedTokens: decision.estimatedTokens,
    untruncatedEstimatedTokens: decision.untruncatedEstimatedTokens,
    ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
    currentCodeTruncated: decision.currentCodeTruncated,
    currentCodeContextMode: decision.currentCodeContextMode,
    costPosture: decision.costPosture,
    routingReason: decision.reason,
  };
}
```

2. In `step.ts`, import `buildRoutingEventFields` and replace the TWO 8-field routing spreads (in `preTaskPayload` ~line 186 and `publishTaskStart` ~line 212) with `...buildRoutingEventFields(wctx.routingDecision),`.

### 2C: Merge slug into slugify

1. Replace `src/utils/slugify.ts`:
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
2. Find consumers of `slug.ts`, change to `slugify(x, 40)`.
3. Delete `src/utils/slug.ts` (and its test if exists).

### 2D: Consolidate path validation

In `src/core/paths-io.ts`:
1. Add: `import { assertPathConfined } from '../lib/path-confinement.js';`
2. Replace `validateTaskPath` body:
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
3. Remove unused `relative` import if applicable.

### 2E: Extract deepEqual to utils

1. Create `src/utils/deep-equal.ts`:
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
2. In `src/stores/project/config.ts`, remove local `deepEqual` definition and add import from `../../utils/deep-equal.js`.

## Verification

```bash
npm run typecheck && npm test
```

Both must pass with zero failures.
