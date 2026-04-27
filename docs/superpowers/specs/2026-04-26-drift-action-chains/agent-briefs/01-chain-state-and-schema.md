# 01 — Chain State and Schema

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Define the Zod schema for drift chain data and create a pure chain state container module. This is the foundation that all other briefs depend on. No orchestrator changes, no event changes, no UI changes.

## Read First

- `CLAUDE.md`
- `src/core/paths.ts`
- `src/core/schemas/task.ts` — understand `Task` type and `scope.outOfBounds`
- `src/engine/orchestrator/drift.ts` — understand `DriftFinding`, `DriftReport`; do not modify
- `src/lib/fs.ts` — understand `SECURE_FILE_MODE` and `ensureSecureDir`

## Files To Create Or Modify

- `src/core/paths.ts` — add `DRIFT_CHAINS_FILE` constant
- `src/core/schemas/drift-chain.ts` — new file: Zod schema and derived types
- `src/engine/orchestrator/drift-chain-state.ts` — new file: pure state container functions

Do not modify any other file in this brief.

## Paths Constant

Add to `src/core/paths.ts` (one line, following the existing `DRIFT_REPORT_FILE` pattern):

```ts
export const DRIFT_CHAINS_FILE = 'drift-chains.json';
```

## Schema Contract

Create `src/core/schemas/drift-chain.ts` with the following exports. Use Zod 4.x. ESM `.js` extension in imports.

```ts
import { z } from 'zod';

/**
 * A single task's contribution to a drift chain.
 * Captures which out-of-bounds files were written during this task.
 */
export const DriftChainEntrySchema = z.object({
  taskId: z.string(),
  outOfBoundsFiles: z.array(z.string()),
});

/**
 * The active chain being tracked. Resets to length 0 when a task lands cleanly.
 */
export const ActiveDriftChainSchema = z.object({
  /** Consecutive tasks in the current chain, oldest first. */
  entries: z.array(DriftChainEntrySchema),
  /** Union of all out-of-bounds file paths seen anywhere in this chain. */
  uniqueFiles: z.array(z.string()),
  /** Most recently computed score. 0 when entries.length < 2. */
  score: z.number().min(0).max(1),
});

/**
 * A chain that crossed the emit threshold and was recorded.
 */
export const EmittedChainSchema = z.object({
  chainLength: z.number().int().positive(),
  score: z.number().min(0).max(1),
  uniqueOutOfBoundsFiles: z.array(z.string()),
  representativePath: z.string(),
  detectedAtTaskId: z.string(),
  ts: z.number(),
});

/**
 * Full persisted state. Written to drift-chains.json after every relevant task.
 */
export const DriftChainStateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  activeChain: ActiveDriftChainSchema,
  emittedChains: z.array(EmittedChainSchema),
});

export type DriftChainEntry = z.infer<typeof DriftChainEntrySchema>;
export type ActiveDriftChain = z.infer<typeof ActiveDriftChainSchema>;
export type EmittedChain = z.infer<typeof EmittedChainSchema>;
export type DriftChainState = z.infer<typeof DriftChainStateSchema>;
```

Do not add any logic to this file. Schema only.

## Chain State Container Contract

Create `src/engine/orchestrator/drift-chain-state.ts`. All functions are pure (no I/O). ESM `.js` imports.

Export exactly these functions:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveDriftChain, DriftChainState } from '../../core/schemas/drift-chain.js';
import { DRIFT_CHAINS_FILE, sessionDir } from '../../core/paths.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../lib/fs.js';

/**
 * Returns an empty initial chain state for a new session.
 */
export function initialDriftChainState(sessionId: string): DriftChainState;

/**
 * Returns the path to drift-chains.json for a given session.
 */
export function driftChainsPath(projectDir: string, sessionId: string): string;

/**
 * Reads drift-chains.json from disk. Returns null if absent or unparseable.
 * Never throws.
 */
export function readDriftChainState(
  projectDir: string,
  sessionId: string,
): DriftChainState | null;

/**
 * Writes drift-chains.json to disk with SECURE_FILE_MODE.
 * Creates the session directory if needed.
 */
export function writeDriftChainState(
  projectDir: string,
  sessionId: string,
  state: DriftChainState,
): void;

/**
 * Returns an empty active chain (zero entries, zero score).
 * Used for reset operations.
 */
export function emptyActiveChain(): ActiveDriftChain;
```

Implement all five functions. Keep each function under 20 lines. No class keyword.

`initialDriftChainState` returns:

```ts
{
  version: 1,
  sessionId,
  activeChain: emptyActiveChain(),
  emittedChains: [],
}
```

`driftChainsPath` uses `join(sessionDir(projectDir, sessionId), DRIFT_CHAINS_FILE)`.

`readDriftChainState` wraps `JSON.parse` in try/catch, returns null on any failure (file absent, malformed JSON, schema mismatch).

`writeDriftChainState` calls `ensureSecureDir(sessionDir(projectDir, sessionId))`, then `writeFileSync(..., JSON.stringify(state, null, 2) + '\n', { mode: SECURE_FILE_MODE })`.

`emptyActiveChain` returns `{ entries: [], uniqueFiles: [], score: 0 }`.

## Tests

Create `src/engine/orchestrator/drift-chain-state.test.ts` colocated with `drift-chain-state.ts`.

Cover:

- `initialDriftChainState` returns version 1 and empty active chain.
- `driftChainsPath` returns the expected path under `.diptych/sessions/<id>/drift-chains.json`.
- `readDriftChainState` returns null when file is absent.
- `readDriftChainState` returns null when file contains invalid JSON.
- `writeDriftChainState` creates the file with trailing newline and parseable JSON.
- `readDriftChainState` round-trips a written state.
- `emptyActiveChain` returns an object with zero entries, empty uniqueFiles, and score 0.

Use `mkdtempSync`/`rmSync` for temporary directories (match the pattern in `drift.test.ts`).

## Acceptance Criteria

- `src/core/schemas/drift-chain.ts` exists with all four Zod schemas and four derived types.
- `src/engine/orchestrator/drift-chain-state.ts` exists with the five exported functions.
- `DRIFT_CHAINS_FILE` is exported from `src/core/paths.ts`.
- `drift.ts` and `drift.test.ts` are unchanged.
- All tests pass.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/drift-chain-state.test.ts
npm run typecheck
npm run lint
```
