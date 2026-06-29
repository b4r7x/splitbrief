import { describe, it, expect } from 'vitest';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import { formatCostGateSummary } from '../../core/cost-gate-summary.js';
import { decideCostGate } from './cost-gate.js';

describe('decideCostGate', () => {
  it('returns gate for standard mode with valid prediction', () => {
    expect(
      decideCostGate({ mode: 'standard', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns gate for speckit mode', () => {
    expect(
      decideCostGate({ mode: 'speckit', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns skip for instant mode', () => {
    expect(
      decideCostGate({ mode: 'instant', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip for quick mode', () => {
    expect(
      decideCostGate({ mode: 'quick', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip when costGateEnabled is false', () => {
    expect(
      decideCostGate({
        mode: 'standard',
        prediction: makeCostPrediction(),
        costGateEnabled: false,
      }),
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
        prediction: makeCostPrediction({ deterministic: undefined }),
        costGateEnabled: true,
      }),
    ).toBe('skip');
  });
  it('returns skip-unknown-cost when knownActualEstimate is null', () => {
    const prediction = makeCostPrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    expect(decideCostGate({ mode: 'standard', prediction, costGateEnabled: true })).toBe(
      'skip-unknown-cost',
    );
  });
});

describe('formatCostGateSummary', () => {
  it('formats a complete summary', () => {
    const summary = formatCostGateSummary(makeCostPrediction());
    expect(summary).not.toBeNull();
    expect(summary!.taskCount).toBe(12);
    expect(summary!.estimateLabel).toBe('prompt input');
    expect(summary!.estimatedCost).toBe('$0.14');
    expect(summary!.allPlannerLabel).toBe('all-planner prompt');
    expect(summary!.allPlannerCost).toBe('~$1.20');
    expect(summary!.savingsLabel).toBe('prompt saving');
    expect(summary!.estimatedSavings).toBe('$1.06');
    expect(summary!.savingsPercentage).toBe(88);
    expect(summary!.scopeNote).toBe(
      'output, retries, validation reruns, and escalation tracked at runtime',
    );
  });
  it('returns null when deterministic is undefined', () => {
    expect(formatCostGateSummary(makeCostPrediction({ deterministic: undefined }))).toBeNull();
  });
  it('renders the all-planner baseline when knownActualEstimate is null', () => {
    const prediction = makeCostPrediction();
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
    const prediction = makeCostPrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    prediction.deterministic!.totals.hypotheticalAllPlanner = null;
    prediction.deterministic!.totals.estimatedSavings = null;
    expect(formatCostGateSummary(prediction)).toBeNull();
  });
  it('handles null hypotheticalAllPlanner', () => {
    const prediction = makeCostPrediction();
    prediction.deterministic!.totals.hypotheticalAllPlanner = null;
    const summary = formatCostGateSummary(prediction);
    expect(summary).not.toBeNull();
    expect(summary!.allPlannerCost).toBe('n/a');
    expect(summary!.savingsPercentage).toBe(0);
  });
});
