# 03 - Type Safety & Consistency

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Fix type safety issues, remove dead re-export, fix selector performance, and fix consistency issues.

## Standard Project Constraints

- Node.js 22+, TypeScript ESM only; imports include `.js` suffixes.
- No classes. No barrel files.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/engine/events/sinks/otel.ts`
- `src/features/workflow/hooks/use-cost-stats.ts`
- `src/features/workflow/components/input-footer.tsx`
- `src/features/workflow/hooks/use-advisory.ts`
- `src/stores/ui/controls.ts`
- `src/engine/codebase/budget.ts`
- `src/utils/fuzzy-match.ts`

## Write Ownership

```
src/engine/events/sinks/otel.ts
src/features/workflow/hooks/use-cost-stats.ts
src/features/workflow/components/input-footer.tsx
src/stores/ui/controls.ts
src/engine/codebase/budget.ts
src/engine/codebase/budget.test.ts
src/utils/fuzzy-match.ts
src/utils/fuzzy-match.test.ts (if exists)
```

## Tasks

### 3A: Fix OTel TaskId double-casts

In `src/engine/events/sinks/otel.ts`:
1. After `const taskSpans = new Map<string, Span>();` add:
   ```typescript
   const taskKey = (id: import('../../../core/schemas/task.js').TaskId): string => id as string;
   ```
2. Replace all 8 occurrences of `event.taskId as unknown as string` with `taskKey(event.taskId)`.

### 3B: Fix useCostStats full-state selector

In `src/features/workflow/hooks/use-cost-stats.ts`:
1. Line 79 — replace `modelCacheStore.use(state => state)` with:
   ```typescript
   modelCacheStore.use(s => ({ modelsDevCatalog: s.modelsDevCatalog, modelsDevFetchedAt: s.modelsDevFetchedAt, providers: s.providers }))
   ```
2. Line 32 — update function signature:
   ```typescript
   function asReactiveModelCache(snapshot: Pick<ReturnType<typeof modelCacheStore.get>, 'modelsDevCatalog' | 'modelsDevFetchedAt' | 'providers'>): ModelCacheAccessor {
   ```

### 3C: Fix advisory hook inconsistency

In `src/features/workflow/components/input-footer.tsx`:
1. Add import: `import { useAdvisory } from '../hooks/use-advisory.js';`
2. Replace `const advisory = useSyncExternalStore(subscribeAdvisory, getAdvisory, getAdvisory);` with `const advisory = useAdvisory();`
3. Remove unused imports (`subscribeAdvisory`, `getAdvisory`, and `useSyncExternalStore` if nothing else uses it).

### 3D: Add controlsStore __testReset

In `src/stores/ui/controls.ts`, add `__testReset: () => store.set(initial),` to the `controlsStore` object (after `...storeBase(store),`).

### 3E: Remove dead estimateTokens re-export

In `src/engine/codebase/budget.ts`, remove:
```typescript
import { estimateTokens } from '../../core/tokens/estimate.js';
export { estimateTokens };
```
Fix `budget.test.ts` if it imports from `./budget.js` — change to direct import from `../../core/tokens/estimate.js`.

### 3F: Unify fuzzy matching on fzf

Replace `src/utils/fuzzy-match.ts` entirely:
```typescript
import { Fzf, type FzfResultItem } from 'fzf';

export type FuzzyMatchResult = {
  score: number;
  positions: number[];
};

export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (query.length === 0) return { score: 0, positions: [] };
  const fzf = new Fzf([target]);
  const results = fzf.find(query);
  const top = results[0];
  if (top === undefined || top.score <= 0) return null;
  return { score: Math.min(1, top.score / 100), positions: Array.from(top.positions) };
}

export function fuzzyMatchExtended(query: string, target: string): FuzzyMatchResult | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, positions: [] };
  let totalScore = 0;
  const allPositions = new Set<number>();
  for (const term of terms) {
    const result = fuzzyMatch(term, target);
    if (result === null) return null;
    totalScore += result.score;
    for (const p of result.positions) allPositions.add(p);
  }
  return { score: totalScore, positions: Array.from(allPositions).sort((a, b) => a - b) };
}

export function fuzzyRank<T>(items: T[], query: string, selector: (item: T) => string): T[] {
  if (!query) return items;
  const fzf = new Fzf(items, { selector });
  return fzf.find(query).map((r: FzfResultItem<T>) => r.item);
}
```

If `fuzzy-match.test.ts` exists, update score assertions to check `> 0` (not exact values) for matches and `null` for non-matches.

## Verification

```bash
npm run typecheck && npm test
```

Both must pass.
