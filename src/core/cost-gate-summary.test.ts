import { describe, it, expect } from 'vitest';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import { formatCostGateSummary } from './cost-gate-summary.js';

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
