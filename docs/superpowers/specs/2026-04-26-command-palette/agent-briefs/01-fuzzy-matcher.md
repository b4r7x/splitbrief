# 01 — Fuzzy Matcher

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 01 of 5** — Command Palette spec, 2026-04-26.

## Intent

Create a pure, dependency-free subsequence fuzzy matcher in `src/utils/fuzzy-match.ts`. This is the scoring engine used by the palette result aggregator. It has no React or engine imports.

## Scope

**In bounds:**
- `src/utils/fuzzy-match.ts` (new file)
- `src/utils/fuzzy-match.test.ts` (new file)

**Out of bounds:**
- Do not modify any existing file.
- Do not touch `src/core/slash-commands/fuzzy.ts` (that file uses `fzf` for slash command name lookup — a different concern that stays untouched).
- Do not add any npm dependency.

## Code Context

Read these files before writing:

- `src/utils/type-guards.ts` — understand existing util conventions
- `src/core/slash-commands/fuzzy.ts` — existing fzf-based matcher (do NOT copy; stay separate)

The new file lives in `src/utils/` alongside other pure utility modules.

## Implementation Plan

### Exports

```ts
// src/utils/fuzzy-match.ts

export type FuzzyMatchResult = {
  score: number;       // 0..1, higher is better
  positions: number[]; // indices in target that matched query chars
};

/**
 * Returns null when query does not subsequence-match target.
 * Case-insensitive. Empty query always returns { score: 0, positions: [] }.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null;

/**
 * Scores a target against multiple space-separated terms.
 * All terms must match; returns null if any term fails.
 * Total score is the sum of per-term scores (not averaged).
 */
export function fuzzyMatchExtended(query: string, target: string): FuzzyMatchResult | null;
```

### Algorithm for `fuzzyMatch`

1. Normalise both strings to lowercase.
2. If `query` is empty, return `{ score: 0, positions: [] }`.
3. Walk `target` left to right. For each character in `query`, find the next matching character in `target` (greedy left-to-right). Track the index in `target`. If any query character is not found, return `null`.
4. Collected indices → `positions: number[]`.
5. Score:
   - `matchedCount = positions.length` (always equals `query.length` after step 3)
   - `targetLen = target.length`
   - `firstMatchIndex = positions[0]`
   - `baseScore = matchedCount / targetLen` — coverage of target
   - `positionBonus = 1 - (firstMatchIndex / targetLen)` — earlier first match is better
   - Consecutive run length: walk `positions`; count the longest run of consecutive integers. `consecutiveBonus = longestRun / matchedCount`
   - Word-boundary bonus: for each position `p` in `positions`, add `0.1` if `p === 0` OR `target[p-1]` is one of ` `, `-`, `_`, `/`. Sum these, cap at `1.0`. Call this `wbBonus`.
   - `finalScore = (baseScore * 0.4) + (positionBonus * 0.3) + (consecutiveBonus * 0.2) + (wbBonus * 0.1)`, clamped to `[0, 1]`.
6. Return `{ score: finalScore, positions }`.

### Algorithm for `fuzzyMatchExtended`

1. `const terms = query.trim().split(/\s+/).filter(Boolean)`
2. If `terms` is empty, return `{ score: 0, positions: [] }`.
3. For each term, call `fuzzyMatch(term, target)`. If any returns `null`, return `null`.
4. Sum all per-term scores. Merge all per-term `positions` arrays into one deduplicated sorted array.
5. Return `{ score: sumOfScores, positions: mergedPositions }`.
   - Note: `score` can exceed 1 when multiple terms match (e.g. two terms each scoring 0.8 → 1.6). The aggregator normalises across results by sort order; the score is used for ranking only, not displayed to the user.

### Worked Examples (use in tests)

```
fuzzyMatch('rv', 'revise-spec')
  // 'r' at 0, 'v' at 2
  // baseScore = 2/11 ≈ 0.18
  // positionBonus = 1 - 0/11 = 1.0
  // consecutiveBonus: no run of 2 consecutive → longestRun=1 → 1/2=0.5
  // wbBonus: position 0 is word boundary → 0.1
  // finalScore ≈ 0.18*0.4 + 1.0*0.3 + 0.5*0.2 + 0.1*0.1 = 0.072+0.3+0.1+0.01 = 0.482
  → not null, score ≈ 0.48

fuzzyMatch('xyz', 'revise-spec')
  // 'x' not found in target
  → null

fuzzyMatchExtended('rev sp', 'revise-spec')
  // term 'rev': r@0, e@1, v@2 (consecutive run 3) → high score
  // term 'sp': s@7, p@8 (consecutive) → decent score
  // both match → summed score
  → not null

fuzzyMatchExtended('rev xyz', 'revise-spec')
  // 'xyz' fails
  → null
```

## Validation

### Test cases (colocated in `src/utils/fuzzy-match.test.ts`)

- Empty query returns `{ score: 0, positions: [] }` (not null).
- Full exact match returns score of exactly 1.0 (all chars consecutive, first match at 0, word boundary at 0, full coverage).
- Non-matching query returns null.
- `'rs'` matches `'revise-spec'` (subsequence, not substring).
- `'rs'` does NOT match `'help'`.
- Score for `'re'` in `'revise'` > score for `'re'` in `'___re'` (position bonus).
- Score for `'abc'` in `'abcdef'` > score for `'abc'` in `'a_b_c_def'` (consecutive bonus).
- Word boundary bonus: `'r'` in `'revise-spec'` at position 0 scores higher than `'e'` in `'revise-spec'` at position 1 (only position 0 is a word boundary in this string).
- `fuzzyMatchExtended('rev sp', 'revise-spec')` returns non-null.
- `fuzzyMatchExtended('rev xyz', 'revise-spec')` returns null.
- `fuzzyMatchExtended('', 'anything')` returns `{ score: 0, positions: [] }`.
- Score is clamped to `[0, 1]` per `fuzzyMatch`; `fuzzyMatchExtended` can exceed 1 (multiple terms).
- Case-insensitive: `fuzzyMatch('REV', 'revise')` not null.

## Constraints

- Pure TypeScript. No imports except built-ins.
- File must pass `npm run typecheck` and `npm run lint` (Biome 2.x) without modification.
- No `class` keyword.
- No default export.

## Escalation

If the score formula produces NaN or Infinity for any valid input (empty target, single-char query), clamp all intermediate values to `[0, 1]` before the final formula. Add a test for single-char target with single-char matching query.

## Evidence Requirements

- `npm test -- src/utils/fuzzy-match.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- All test cases from the Validation section are present and passing.
