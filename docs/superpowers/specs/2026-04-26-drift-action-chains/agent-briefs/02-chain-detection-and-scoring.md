# 02 — Chain Detection and Scoring

> Fresh AI context brief. Implement only this change. Never stage or commit.
> **Depends on:** brief 01 (types from `src/core/schemas/drift-chain.ts` and `src/engine/orchestrator/drift-chain-state.ts`).

## Goal

Create the pure chain detection and scoring module. Two responsibilities:

1. `computePerTaskOutOfBounds` — slice a single task's changed files into the out-of-bounds set.
2. `analyzeDriftChain` — apply chain extend/reset logic and compute a deterministic score.

Neither function performs I/O. Neither function calls `analyzeBriefDrift`. Neither function modifies `drift.ts`.

## Read First

- `CLAUDE.md`
- `src/core/schemas/task.ts` — `Task` type; understand `task.file`, `task.scope.outOfBounds`; you will add `task.scope.approvedOutOfBounds` in this brief
- `src/core/schemas/drift-chain.ts` — types from brief 01
- `src/engine/orchestrator/drift.ts` — read to understand out-of-bounds matching logic; do not import from it in the new module

## Files To Create Or Modify

- `src/engine/orchestrator/drift-chain.ts` — new file: pure detection and scoring
- `src/engine/orchestrator/drift-chain.test.ts` — new colocated test file
- `src/core/schemas/task.ts` — add `approvedOutOfBounds` to the `scope` object

### Schema Patch

`task.scope.approvedOutOfBounds` does not exist yet. Add it to `src/core/schemas/task.ts`:

```ts
scope: z
  .object({
    inBounds: z.array(z.string()).optional(),
    outOfBounds: z.array(z.string()).optional(),
    approvedOutOfBounds: z.array(z.string()).optional(),
  })
  .optional(),
```

This is a backward-compatible addition (optional field; existing JSON without the field deserializes cleanly). Do not add a default value in the schema.

## Contract

Create `src/engine/orchestrator/drift-chain.ts` with exactly these exports.

### `computePerTaskOutOfBounds`

```ts
import type { Task } from '../../core/schemas/task.js';

/**
 * Given a single task and the set of files changed during that task's
 * implementation, returns the set of out-of-bounds file paths.
 *
 * A file is out-of-bounds if:
 *   (a) it matches any pattern in task.scope.outOfBounds (substring match), OR
 *   (b) it is not the task's own target file (task.file)
 *
 * Files that match any pattern in task.scope.approvedOutOfBounds (substring
 * match) are excluded from the result after the above check.
 *
 * If taskChangedFiles is empty the result is always an empty Set.
 */
export function computePerTaskOutOfBounds(
  task: Task,
  taskChangedFiles: string[],
): Set<string>;
```

Implementation notes:

- Use substring matching (`file.includes(pattern)`) identical to `analyzeBriefDrift`. Do not use regex.
- `task.scope.outOfBounds` and `task.scope.approvedOutOfBounds` may be undefined; treat as empty array.
- A file is out-of-bounds if it matches any `outOfBounds` pattern OR if it is not `task.file`. Both conditions independently qualify.
- Exclusion by `approvedOutOfBounds` is applied last (subtract from the out-of-bounds set).
- The function returns a `Set<string>`, never throws.

### `analyzeDriftChain`

```ts
import type { ActiveDriftChain, DriftChainState, EmittedChain } from '../../core/schemas/drift-chain.js';

export type DriftChainUpdate = {
  /** Updated full chain state (may be same reference if unchanged). */
  state: DriftChainState;
  /**
   * Set to the newly emitted chain record if score crossed the threshold
   * for the first time this update. Undefined otherwise.
   */
  emitted: EmittedChain | undefined;
};

/**
 * Applies one task's out-of-bounds result to the chain state.
 *
 * If outOfBoundsFiles is empty → reset the active chain.
 * If outOfBoundsFiles is non-empty:
 *   - If overlap with previous entry's outOfBoundsFiles >= 1 → extend chain.
 *   - Otherwise → start new chain (reset to length 1).
 *
 * After updating the active chain, recomputes the score (see ADR-003).
 * If score >= threshold and the current chain has not yet been emitted
 * (no entry in state.emittedChains with the same detectedAtTaskId),
 * produces an EmittedChain record and appends it to state.emittedChains.
 *
 * @param state - Current persisted chain state
 * @param taskId - ID of the task that just completed
 * @param outOfBoundsFiles - Out-of-bounds file set for this task (from computePerTaskOutOfBounds)
 * @param threshold - Emit threshold (default 0.6 if caller does not pass)
 */
export function analyzeDriftChain(
  state: DriftChainState,
  taskId: string,
  outOfBoundsFiles: Set<string>,
  threshold: number,
): DriftChainUpdate;
```

### Score Formula

Implement exactly as specified in ADR-003:

```
lengthTerm   = min(chain.entries.length, 5) / 5 * 0.3
overlapTerm  = overlapCount / unionSize * 0.5   (0 when chain.entries.length < 2)
newFilesTerm = min(uniqueFilesInChain, 10) / 10 * 0.2
score        = clamp(lengthTerm + overlapTerm + newFilesTerm, 0, 1)
```

Where:
- `overlapCount` is the number of files in the intersection of the current task's out-of-bounds set and the previous entry's out-of-bounds set.
- `unionSize` is the size of the union of those two sets (never 0 when at least one set is non-empty, so no division-by-zero risk when `entries.length >= 2`).
- `uniqueFilesInChain` is `activeChain.uniqueFiles.length` after appending the current task's files.

### `representativePath`

When constructing an `EmittedChain`, `representativePath` is the path that appears in the most entries of the chain. On a tie, use the first alphabetically. If `uniqueFiles` is empty (should never happen at emit time), use `''`.

### `emittedChains` deduplication

A chain is emitted at most once per continuous run of entries ending at the same `taskId`. If the same `taskId` already appears as `detectedAtTaskId` in `state.emittedChains`, do not emit again for that task. (This prevents re-emitting if `analyzeDriftChain` is called twice for the same task by accident.)

## Tests

Create `src/engine/orchestrator/drift-chain.test.ts`.

Cover:

### `computePerTaskOutOfBounds`

- task with `file: 'src/a.ts'`, changed files `['src/a.ts']` → empty set (own file only)
- task with `file: 'src/a.ts'`, changed files `['src/a.ts', 'src/b.ts']` → `{'src/b.ts'}`
- out-of-bounds pattern `'src/secrets'` matches `'src/secrets/leak.ts'` in changed files → included
- file matching `approvedOutOfBounds` substring is excluded from result
- empty `taskChangedFiles` → empty set
- undefined `scope` → no crash, empty set if only own file changed

### `analyzeDriftChain` — reset semantics

- empty `outOfBoundsFiles` → active chain entries become empty, score becomes 0, no emit
- chain of 2 entries, third task is clean → chain resets to empty

### `analyzeDriftChain` — extend semantics

- two consecutive tasks with overlapping out-of-bounds files → chain length 2, score computed
- three consecutive tasks with full overlap → chain length 3, score above 0.6 for default threshold
- three consecutive tasks that cross threshold → `emitted` is defined on the third call

### `analyzeDriftChain` — start new chain

- two tasks with non-overlapping out-of-bounds files → second task resets chain to length 1 (no overlap)
- new chain from scratch has score based only on length=1 and new-files term (overlap term = 0)

### `analyzeDriftChain` — score formula (deterministic)

- length 2, 100% overlap, 2 unique files: verify exact score value
- length 3, 80% overlap (4/5 files), 3 unique files: verify exact score value
- score is always in `[0, 1]`

### `analyzeDriftChain` — emit behavior

- calling twice with same taskId does not produce duplicate emitted entries
- `representativePath` is the most frequent path; alphabetical tiebreak is applied

### `analyzeDriftChain` — threshold

- score = 0.59 with threshold 0.6 → no emit
- score >= 0.6 with threshold 0.6 → emit

## Acceptance Criteria

- `src/engine/orchestrator/drift-chain.ts` exists with two exported functions (`computePerTaskOutOfBounds`, `analyzeDriftChain`) and one exported type (`DriftChainUpdate`).
- No I/O in `drift-chain.ts`. No imports from `node:fs`, `node:path`, or any orchestrator/feature module.
- `drift.ts` and `drift.test.ts` are unchanged.
- All new tests pass.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/drift-chain.test.ts
npm run typecheck
npm run lint
```
