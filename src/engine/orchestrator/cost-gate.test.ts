import { describe, it, expect } from 'vitest';
import { formatCostGateSummary } from '../../core/cost-gate-summary.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import { decideCostGate } from './cost-gate.js';

function makePrediction(overrides: Partial<CostPrediction> = {}): CostPrediction {
  return {
    estimatedTasks: 12,
    lowCost: 0.08,
    expectedCost: 0.14,
    highCost: 0.35,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      estimateScope: 'prompt-input-only',
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: {
        contextExplicit: 5,
        contextDetected: 0,
        contextKnownCatalog: 4,
        contextCachedProvider: 2,
        contextConservativeFallback: 1,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.14,
        hypotheticalAllPlanner: 1.2,
        estimatedSavings: 1.06,
        unknownCostReason: [],
      },
    },
    ...overrides,
  };
}

describe('decideCostGate', () => {
  it('returns gate for standard mode with valid prediction', () => {
    expect(
      decideCostGate({ mode: 'standard', prediction: makePrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns gate for speckit mode', () => {
    expect(
      decideCostGate({ mode: 'speckit', prediction: makePrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns skip for instant mode', () => {
    expect(
      decideCostGate({ mode: 'instant', prediction: makePrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip for quick mode', () => {
    expect(
      decideCostGate({ mode: 'quick', prediction: makePrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip when costGateEnabled is false', () => {
    expect(
      decideCostGate({ mode: 'standard', prediction: makePrediction(), costGateEnabled: false }),
    ).toBe('skip');
  });
  it('returns skip when prediction is null', () => {
    expect(decideCostGate({ mode: 'standard', prediction: null, costGateEnabled: true })).toBe(
      'skip',
    );
  });
  it('returns skip when deterministic is undefined', () => {
    expect(
      decideCostGate({
        mode: 'standard',
        prediction: makePrediction({ deterministic: undefined }),
        costGateEnabled: true,
      }),
    ).toBe('skip');
  });
  it('returns skip-unknown-cost when knownActualEstimate is null', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    expect(decideCostGate({ mode: 'standard', prediction, costGateEnabled: true })).toBe(
      'skip-unknown-cost',
    );
  });
});

describe('formatCostGateSummary', () => {
  it('formats a complete summary', () => {
    const summary = formatCostGateSummary(makePrediction());
    expect(summary).not.toBeNull();
    expect(summary!.taskCount).toBe(12);
    expect(summary!.estimateLabel).toBe('Prompt input');
    expect(summary!.estimatedCost).toBe('$0.14');
    expect(summary!.allPlannerLabel).toBe('All-planner prompt');
    expect(summary!.allPlannerCost).toBe('~$1.20');
    expect(summary!.savingsLabel).toBe('Prompt saving');
    expect(summary!.estimatedSavings).toBe('$1.06');
    expect(summary!.savingsPercentage).toBe(88);
    expect(summary!.scopeNote).toBe(
      'Output, retries, validation reruns, and escalation are tracked at runtime.',
    );
  });
  it('returns null when deterministic is undefined', () => {
    expect(formatCostGateSummary(makePrediction({ deterministic: undefined }))).toBeNull();
  });
  it('renders the all-planner baseline when knownActualEstimate is null', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    prediction.deterministic!.totals.estimatedSavings = null;
    const summary = formatCostGateSummary(prediction);
    expect(summary).not.toBeNull();
    expect(summary!.estimatedCost).toBe('n/a');
    expect(summary!.allPlannerCost).toBe('~$1.20');
    expect(summary!.estimatedSavings).toBe('n/a');
    expect(summary!.savingsPercentage).toBe(0);
  });
  it('returns null when both deterministic total costs are null', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    prediction.deterministic!.totals.hypotheticalAllPlanner = null;
    prediction.deterministic!.totals.estimatedSavings = null;
    expect(formatCostGateSummary(prediction)).toBeNull();
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
