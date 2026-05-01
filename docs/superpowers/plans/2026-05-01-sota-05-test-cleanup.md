# SOTA 05: Test Cleanup (Delete Unnecessary, Unify Fuzzy)

> **For agentic workers:** Execute task-by-task. After ALL tasks: run `npm run test-ci`.

**Goal:** Remove tests that test trivial implementations, and unify fuzzy matching on `fzf` library.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

---

### Task 1: Delete trivial tests

**Rationale:** These test one-line functions with zero logic complexity. They add maintenance cost without catching real bugs.

- [ ] **Step 1: Delete `estimate.test.ts`**

This tests `Math.ceil(str.length / 4)` — a one-line formula.

```bash
rm src/core/tokens/estimate.test.ts
```

- [ ] **Step 2: Delete `type-guards.test.ts`**

This tests `typeof x === 'object' && x !== null && !Array.isArray(x)` — trivially correct, TypeScript compiler enforces at usage sites.

```bash
rm src/utils/type-guards.test.ts
```

- [ ] **Step 3: Verify test suite still passes**

Run: `npm test`
Expected: PASS (fewer tests, same green)

---

### Task 2: Unify fuzzy matching on `fzf` library

**Problem:** `src/utils/fuzzy-match.ts` has a custom subsequence scorer. `src/core/slash-commands/fuzzy.ts` uses the `fzf` library. Two different ranking behaviors for the same UX concept.

**Files:**
- Modify: `src/utils/fuzzy-match.ts`
- Modify: `src/utils/fuzzy-match.test.ts` (if exists)

- [ ] **Step 0: Check consumers for score thresholds**

Run: `grep -r "\.score" src/ --include="*.ts" | grep -i fuzzy`

Check if ANY consumer uses a threshold like `score > 0.5` or `score > 0.3`. If yes, note those thresholds — you'll need to adjust them in Step 2.

The old custom scorer returned [0, 1]. The `fzf` library returns unbounded positive integers. We normalize by clamping to [0, 1] range using: `Math.min(1, score / 100)`. This preserves the contract that 0 = weak match, 1 = perfect match.

- [ ] **Step 1: Rewrite `src/utils/fuzzy-match.ts` to use `fzf`**

Replace the entire file with:

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
  return {
    score: Math.min(1, top.score / 100),
    positions: Array.from(top.positions),
  };
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

- [ ] **Step 2: Fix test expectations**

If `src/utils/fuzzy-match.test.ts` exists, update it. The `fzf` library uses different scoring than the old custom algorithm. Tests should assert:
- Matching inputs return non-null with `score > 0`
- Non-matching inputs return null
- Multi-term queries (`fuzzyMatchExtended`) require ALL terms to match
- `fuzzyRank` returns items sorted by relevance

Do NOT assert exact score values — just `> 0` for matches and null for non-matches.

Example fixes:
```typescript
// Old: expect(fuzzyMatch('abc', 'abcdef')?.score).toBeCloseTo(0.7)
// New:
expect(fuzzyMatch('abc', 'abcdef')).not.toBeNull();
expect(fuzzyMatch('abc', 'abcdef')!.score).toBeGreaterThan(0);

// Non-match stays the same:
expect(fuzzyMatch('xyz', 'abcdef')).toBeNull();
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 3: Delete `runner-config.test.ts` (fold if needed)

**Problem:** Tests a trivial switch-case mapping (`getPlannerToolId`).

- [ ] **Step 1: Read the file**

Read `src/core/config/accessors/runner-config.test.ts` to check what it tests.

- [ ] **Step 2: If all tests are trivial 1:1 mappings, just delete**

```bash
rm src/core/config/accessors/runner-config.test.ts
```

If any test covers non-trivial behavior (error cases, fallback logic), move those specific tests into `src/core/config/runtime/build-runner.test.ts` under a new describe block.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS
