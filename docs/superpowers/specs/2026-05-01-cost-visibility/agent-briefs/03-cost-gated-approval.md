# 03 - Cost-Gated Plan Approval

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a cost-gated approval prompt that pauses before implementation begins in `standard` and `speckit` modes. The user sees estimated cost, task count, and all-planner comparison, then approves or rejects. This hooks into the existing `awaitingContinue` state-machine mechanism.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Engine code must not import React, Ink, features, components, or hooks.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/core/state/machine.ts` (awaitingContinue transitions)
- `src/core/schemas/summary.ts` (CostPrediction, CostPredictionSchema)
- `src/stores/workflow/tokens.ts` (prediction field)
- `src/features/workflow/components/event-cards/cost-prediction-card.tsx`
- `src/engine/orchestrator/run/phases.ts` or similar (where cost_prediction is emitted)
- `src/engine/events/types.ts` (event type definitions)
- `src/core/config/runtime/resolve.ts` (config shape)

## Write Ownership

Primary files:

```text
src/features/workflow/components/cost-approval-prompt.tsx       (new)
src/features/workflow/components/cost-approval-prompt.test.tsx  (new)
src/engine/orchestrator/cost-gate.ts                           (new)
src/engine/orchestrator/cost-gate.test.ts                      (new)
```

Edit files:

```text
src/engine/orchestrator/run/phases.ts   (edit - insert gate after cost_prediction)
src/core/state/machine.ts              (edit - add cost_rejected transition if needed)
src/engine/events/types.ts             (edit - add cost_rejected event if needed)
```

Do not edit pricing calculation logic. Do not edit the CostPrediction schema.

## Architecture

The cost gate operates at two layers:

1. **Engine layer** (`cost-gate.ts`): pure function that decides whether to gate based on mode, config, and prediction data. Returns `'gate' | 'skip'`.
2. **Presentation layer** (`cost-approval-prompt.tsx`): Ink component that renders the approval UI when the gate is active.

The orchestrator calls the engine function after `cost_prediction` is emitted. If it returns `'gate'`, the orchestrator sets `awaitingContinue = true`. The TUI renders the approval prompt. User input fires either continue (approve) or abort (reject).

## Engine: `src/engine/orchestrator/cost-gate.ts`

```typescript
import type { CostPrediction } from '../../core/schemas/summary.js';
import { formatCost } from '../../core/formatting.js';

type CostGateMode = 'instant' | 'quick' | 'standard' | 'speckit';

interface CostGateInput {
  mode: CostGateMode | undefined;
  prediction: CostPrediction | null;
  costGateEnabled: boolean;
}

export type CostGateDecision = 'gate' | 'skip';

export function decideCostGate(input: CostGateInput): CostGateDecision {
  if (!input.costGateEnabled) return 'skip';

  if (input.mode === 'instant' || input.mode === 'quick') return 'skip';

  if (!input.prediction) return 'skip';

  const deterministic = input.prediction.deterministic;
  if (!deterministic) return 'skip';

  if (deterministic.totals.knownActualEstimate === null) return 'skip';

  return 'gate';
}

export interface CostGateSummary {
  taskCount: number;
  estimatedCost: string;
  allPlannerCost: string;
  estimatedSavings: string;
  savingsPercentage: number;
}

export function formatCostGateSummary(prediction: CostPrediction): CostGateSummary | null {
  const deterministic = prediction.deterministic;
  if (!deterministic) return null;

  const estimated = deterministic.totals.knownActualEstimate;
  const hypothetical = deterministic.totals.hypotheticalAllPlanner;
  if (estimated === null) return null;

  const savings = hypothetical !== null ? hypothetical - estimated : 0;
  const pct = hypothetical !== null && hypothetical > 0 ? (savings / hypothetical) * 100 : 0;

  return {
    taskCount: deterministic.taskCount,
    estimatedCost: formatCost(estimated),
    allPlannerCost: hypothetical !== null ? `~${formatCost(hypothetical)}` : 'n/a',
    estimatedSavings: formatCost(Math.max(0, savings)),
    savingsPercentage: Math.max(0, Math.round(pct)),
  };
}
```

## Presentation: `src/features/workflow/components/cost-approval-prompt.tsx`

```typescript
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCostGateSummary } from '../../../engine/orchestrator/cost-gate.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

interface CostApprovalPromptProps {
  prediction: CostPrediction;
  onApprove: () => void;
  onReject: () => void;
}

export function CostApprovalPrompt({ prediction, onApprove, onReject }: CostApprovalPromptProps) {
  const t = useTheme();
  const summary = formatCostGateSummary(prediction);

  useInput((input, key) => {
    if (input === 'y' || input === 'Y' || key.return) {
      onApprove();
      return;
    }
    if (input === 'n' || input === 'N' || key.escape) {
      onReject();
      return;
    }
  });

  if (!summary) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={t.textDim}>Cost estimate unavailable. Proceeding automatically.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor={t.accent}>
      <Text bold color={t.accent}>Cost Approval Required</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>{summary.taskCount} tasks</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Est. </Text>
          <Text bold color={t.success}>{summary.estimatedCost}</Text>
          <Text color={t.textDim}> | </Text>
          <Text>All-planner: </Text>
          <Text color={t.warning}>{summary.allPlannerCost}</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Saving: </Text>
          <Text bold color={t.success}>{summary.estimatedSavings} ({summary.savingsPercentage}%)</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.textDim}>Approve? [Y/n] </Text>
      </Box>
    </Box>
  );
}
```

## Orchestrator Integration

After the `cost_prediction` event is emitted in the orchestrator phases (find where `type: 'cost_prediction'` is yielded/emitted), add the gate check:

```typescript
import { decideCostGate } from '../cost-gate.js';

// After cost_prediction is emitted and prediction is stored:
const gateDecision = decideCostGate({
  mode: config.workflow?.mode,
  prediction,
  costGateEnabled: config.workflow?.costGate !== false,
});

if (gateDecision === 'gate') {
  // Set awaitingContinue = true via the state machine
  // The TUI will detect this and render CostApprovalPrompt
  // On approve: fire 'continue' action
  // On reject: fire 'abort' action with reason 'cost_rejected'
}
```

The exact integration mechanism depends on how the orchestrator yields control. Follow the same pattern used by existing `awaitingContinue` triggers in the codebase (search for where `awaitingContinue` is set to `true` in `src/core/state/machine.ts`).

## Config

The cost gate is enabled by default. Users can disable via config:

```yaml
workflow:
  costGate: false
```

The config field should be read from the resolved runtime config. If `workflow.costGate` does not exist in the schema yet, add it as an optional boolean field defaulting to `true`.

## Tests: `src/engine/orchestrator/cost-gate.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { decideCostGate, formatCostGateSummary } from './cost-gate.js';
import type { CostPrediction } from '../../core/schemas/summary.js';

function makePrediction(overrides: Partial<CostPrediction> = {}): CostPrediction {
  return {
    estimatedTasks: 12,
    lowCost: 0.08,
    expectedCost: 0.14,
    highCost: 0.35,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: {
        contextExplicit: 5,
        contextKnownCatalog: 4,
        contextCachedProvider: 2,
        contextConservativeFallback: 1,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.14,
        hypotheticalAllPlanner: 1.20,
        estimatedSavings: 1.06,
        unknownCostReason: [],
      },
    },
    ...overrides,
  };
}

describe('decideCostGate', () => {
  it('returns gate for standard mode with valid prediction', () => {
    const result = decideCostGate({
      mode: 'standard',
      prediction: makePrediction(),
      costGateEnabled: true,
    });
    expect(result).toBe('gate');
  });

  it('returns gate for speckit mode', () => {
    const result = decideCostGate({
      mode: 'speckit',
      prediction: makePrediction(),
      costGateEnabled: true,
    });
    expect(result).toBe('gate');
  });

  it('returns skip for instant mode', () => {
    const result = decideCostGate({
      mode: 'instant',
      prediction: makePrediction(),
      costGateEnabled: true,
    });
    expect(result).toBe('skip');
  });

  it('returns skip for quick mode', () => {
    const result = decideCostGate({
      mode: 'quick',
      prediction: makePrediction(),
      costGateEnabled: true,
    });
    expect(result).toBe('skip');
  });

  it('returns skip when costGateEnabled is false', () => {
    const result = decideCostGate({
      mode: 'standard',
      prediction: makePrediction(),
      costGateEnabled: false,
    });
    expect(result).toBe('skip');
  });

  it('returns skip when prediction is null', () => {
    const result = decideCostGate({
      mode: 'standard',
      prediction: null,
      costGateEnabled: true,
    });
    expect(result).toBe('skip');
  });

  it('returns skip when deterministic is undefined', () => {
    const result = decideCostGate({
      mode: 'standard',
      prediction: makePrediction({ deterministic: undefined }),
      costGateEnabled: true,
    });
    expect(result).toBe('skip');
  });

  it('returns skip when knownActualEstimate is null', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    const result = decideCostGate({
      mode: 'standard',
      prediction,
      costGateEnabled: true,
    });
    expect(result).toBe('skip');
  });
});

describe('formatCostGateSummary', () => {
  it('formats a complete summary', () => {
    const summary = formatCostGateSummary(makePrediction());
    expect(summary).not.toBeNull();
    expect(summary!.taskCount).toBe(12);
    expect(summary!.estimatedCost).toBe('$0.14');
    expect(summary!.allPlannerCost).toBe('~$1.20');
    expect(summary!.estimatedSavings).toBe('$1.06');
    expect(summary!.savingsPercentage).toBe(88);
  });

  it('returns null when deterministic is undefined', () => {
    const summary = formatCostGateSummary(makePrediction({ deterministic: undefined }));
    expect(summary).toBeNull();
  });

  it('returns null when knownActualEstimate is null', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    const summary = formatCostGateSummary(prediction);
    expect(summary).toBeNull();
  });

  it('handles null hypotheticalAllPlanner', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.hypotheticalAllPlanner = null;
    const summary = formatCostGateSummary(prediction);
    expect(summary).not.toBeNull();
    expect(summary!.allPlannerCost).toBe('n/a');
    expect(summary!.savingsPercentage).toBe(0);
  });
});
```

## Tests: `src/features/workflow/components/cost-approval-prompt.test.tsx`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { CostApprovalPrompt } from './cost-approval-prompt.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

function makePrediction(): CostPrediction {
  return {
    estimatedTasks: 12,
    lowCost: 0.08,
    expectedCost: 0.14,
    highCost: 0.35,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: {
        contextExplicit: 5,
        contextKnownCatalog: 4,
        contextCachedProvider: 2,
        contextConservativeFallback: 1,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.14,
        hypotheticalAllPlanner: 1.20,
        estimatedSavings: 1.06,
        unknownCostReason: [],
      },
    },
  };
}

describe('CostApprovalPrompt', () => {
  it('renders task count and cost estimate', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { lastFrame } = render(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={onApprove} onReject={onReject} />,
    );
    const output = lastFrame();
    expect(output).toContain('12 tasks');
    expect(output).toContain('$0.14');
    expect(output).toContain('~$1.20');
    expect(output).toContain('Approve?');
  });

  it('calls onApprove when Y is pressed', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { stdin } = render(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={onApprove} onReject={onReject} />,
    );
    stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('calls onReject when N is pressed', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { stdin } = render(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={onApprove} onReject={onReject} />,
    );
    stdin.write('n');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
```

## Non-Goals

- No changes to pricing calculation logic.
- No new cost prediction pipeline.
- No budget enforcement or hard caps.
- No hero banner (that is brief 01).
- No stats persistence (that is brief 02).
- No automatic approval based on threshold (future work).

## Validation Commands

```bash
npm test -- src/engine/orchestrator/cost-gate.test.ts
npm test -- src/features/workflow/components/cost-approval-prompt.test.tsx
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files created and edited
- gate decision logic (which modes gate, which skip)
- orchestrator integration point (exact file, function, and mechanism)
- config field added to schema (if any)
- TUI rendering for approval prompt
- validation commands run and results
- any skipped validation and why
- confirmation that no git add, git stage, git commit, or git stash was run
