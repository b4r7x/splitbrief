# 04 — Event and Summary

> Fresh AI context brief. Implement only this change. Never stage or commit.
> **Depends on:** brief 01 (`EmittedChain` type), brief 03 (chain analysis wired in, `publishDriftChainDetected` stub referenced).

## Goal

1. Add the `drift_chain_detected` event variant to `EngineEvent`.
2. Implement `publishDriftChainDetected` so brief 03's call site is complete.
3. Extend `buildSummary` to include `chainDriftSummary` when a high-score chain was detected.
4. Add `chainDriftSummary` to `Summary` schema and type.

No new UI components. The summary change is a new optional field in the existing `Summary` data type.

## Read First

- `CLAUDE.md`
- `src/engine/events/types.ts` — understand `EngineEvent` union; do not break existing variants
- `src/engine/orchestrator/summary.ts` — understand `buildSummary` and how it reads session artifacts
- `src/core/schemas/summary.ts` — understand `Summary` Zod schema; understand how `driftSummary` was added as a pattern to follow
- `src/core/schemas/drift-chain.ts` — `EmittedChain`, `DriftChainState` types from brief 01
- `src/engine/orchestrator/drift-chain-state.ts` — `readDriftChainState`, `driftChainsPath` from brief 01
- `src/core/paths.ts` — `DRIFT_CHAINS_FILE` from brief 01

Do not modify `drift.ts` or `drift.test.ts`.

## Files To Modify

- `src/engine/events/types.ts` — add `drift_chain_detected` event variant
- `src/engine/orchestrator/events.ts` — add `publishDriftChainDetected` helper
- `src/engine/orchestrator/summary.ts` — add chain summary reading to `buildSummary`
- `src/core/schemas/summary.ts` — add `ChainDriftSummarySchema` and `chainDriftSummary` field
- `src/features/summary/screen.tsx` — render chain drift summary line

## Event Variant

Add to the `EngineEvent` union in `src/engine/events/types.ts`, alongside the existing `drift_report` variant:

```ts
| {
    type: 'drift_chain_detected';
    ts: number;
    phase: Phase;
    chainLength: number;
    score: number;
    threshold: number;
    uniqueOutOfBoundsFiles: string[];
    representativePath: string;
  }
```

No other changes to `types.ts`.

## `publishDriftChainDetected`

This function is called from `task-step.ts` (brief 03). Add it to `src/engine/orchestrator/events.ts` (the existing orchestrator event helpers file — check the actual file name; it may be `src/engine/orchestrator/events.ts`):

```ts
import type { EmittedChain } from '../../core/schemas/drift-chain.js';

export function publishDriftChainDetected(
  bus: EventBus,
  phase: Phase,
  chain: EmittedChain,
  threshold: number,
): void {
  bus.publish({
    type: 'drift_chain_detected',
    ts: Date.now(),
    phase,
    chainLength: chain.chainLength,
    score: chain.score,
    threshold,
    uniqueOutOfBoundsFiles: chain.uniqueOutOfBoundsFiles,
    representativePath: chain.representativePath,
  });
}
```

If `src/engine/orchestrator/events.ts` already exists and exports similar publish helpers, add `publishDriftChainDetected` there. If it does not exist, add it to whichever file in `src/engine/orchestrator/` already exports `publishWarning` and `publishEvent`.

## Summary Schema

Add to `src/core/schemas/summary.ts`:

```ts
export const ChainDriftSummarySchema = z.object({
  /** Highest score chain detected in this session. */
  score: z.number().min(0).max(1),
  chainLength: z.number().int().nonnegative(),
  uniqueOutOfBoundsFiles: z.array(z.string()),
  representativePath: z.string(),
  /** Total number of emitted chains (score >= threshold) in the session. */
  emittedChainCount: z.number().int().nonnegative(),
});
```

Add it as an optional field to `SummarySchema`:

```ts
/**
 * Drift chain detection result. Present when at least one chain crossed
 * the emit threshold. Optional for backward compatibility.
 */
chainDriftSummary: ChainDriftSummarySchema.optional(),
```

Add the corresponding TypeScript type:

```ts
export type ChainDriftSummary = z.infer<typeof ChainDriftSummarySchema>;
```

Update `Summary` (inferred from `SummarySchema`, so the type update is automatic).

## `buildSummary` Extension

In `src/engine/orchestrator/summary.ts`, add chain state reading alongside the existing `readDriftReport` call:

```ts
import { readDriftChainState } from './drift-chain-state.js';
```

Inside `buildSummary`, in the `if (projectDir && sessionId)` block, after `driftSummary` is assigned:

```ts
let chainDriftSummary: Summary['chainDriftSummary'];
const chainState = readDriftChainState(projectDir, sessionId);
if (chainState && chainState.emittedChains.length > 0) {
  // Pick the highest-scoring emitted chain for the summary line.
  const best = chainState.emittedChains.reduce((a, b) => a.score >= b.score ? a : b);
  chainDriftSummary = {
    score: best.score,
    chainLength: best.chainLength,
    uniqueOutOfBoundsFiles: best.uniqueOutOfBoundsFiles,
    representativePath: best.representativePath,
    emittedChainCount: chainState.emittedChains.length,
  };
}
```

Include `chainDriftSummary` in the returned object:

```ts
...(chainDriftSummary && { chainDriftSummary }),
```

The summary line in the compiler-language that brief 04 targets for display:

```
Drift chain: 3 tasks writing to /unrelated/area, score 0.78
```

This rendering happens in the existing summary screen (`src/features/summary/screen.tsx`). Add a minimal display line — no new component, just a `<Text>` node within the existing drift summary section or as a new section after `driftSummary`. The exact location should follow the existing pattern for `driftSummary` rendering.

Find where `driftSummary` is rendered in `src/features/summary/screen.tsx` and add below it:

```tsx
{summary.chainDriftSummary && (
  <Box marginTop={1}>
    <Text color={theme.textDim}>
      Drift chain: {summary.chainDriftSummary.chainLength} tasks writing to{' '}
      {summary.chainDriftSummary.representativePath}, score{' '}
      {summary.chainDriftSummary.score.toFixed(2)}
      {summary.chainDriftSummary.emittedChainCount > 1
        ? ` (${summary.chainDriftSummary.emittedChainCount} chains total)`
        : ''}
    </Text>
  </Box>
)}
```

Import `useTheme` and `Box`, `Text` from `ink` if not already imported in that file.

## Tests

### Event variant test (unit)

In a new or existing event test file, verify:

- `publishDriftChainDetected` publishes an event with `type: 'drift_chain_detected'` and all required fields.
- The published event includes `chainLength`, `score`, `threshold`, `uniqueOutOfBoundsFiles`, `representativePath`.

### Summary reading test (unit)

Add tests to `src/engine/orchestrator/summary.test.ts` (the existing summary test file):

- `buildSummary` with no `drift-chains.json` on disk → `chainDriftSummary` is undefined.
- `buildSummary` with a `drift-chains.json` containing zero emitted chains → `chainDriftSummary` is undefined.
- `buildSummary` with a `drift-chains.json` containing one emitted chain → `chainDriftSummary` has the correct `score`, `chainLength`, `representativePath`, `emittedChainCount: 1`.
- `buildSummary` with two emitted chains → `chainDriftSummary` reflects the highest-scoring chain and `emittedChainCount: 2`.

Use `mkdtempSync`/`rmSync` for temporary session directories. Write the `drift-chains.json` fixture using `writeDriftChainState` from brief 01.

### Existing summary tests

Do not break any existing `summary.test.ts` tests. The new field is optional, so existing assertions that use `toMatchObject` or check specific fields will still pass.

## Acceptance Criteria

- `drift_chain_detected` is a valid variant of `EngineEvent`.
- `publishDriftChainDetected` is exported from the orchestrator events helpers.
- `Summary.chainDriftSummary` is an optional field in both schema and type.
- `buildSummary` populates `chainDriftSummary` when the session had emitted chains.
- The summary screen renders the chain drift line when `chainDriftSummary` is present.
- Existing `drift.ts`, `drift.test.ts`, and all existing summary tests are unmodified and still pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/summary.test.ts
npm run typecheck
npm run lint
npm test
```
