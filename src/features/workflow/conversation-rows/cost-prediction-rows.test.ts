import { describe, expect, it } from 'vitest';
import type { CostPrediction, PlannerEstimateReview } from '../../../core/schemas/summary.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { taskId } from '../../../core/schemas/task.js';
import { costPredictionRows } from './cost-prediction-rows.js';
import { rowText } from './row-format.js';

function makeEvent(
  review: PlannerEstimateReview | undefined,
): Extract<EngineEvent, { type: 'cost_prediction' }> {
  const prediction: CostPrediction = {
    estimatedTasks: 1,
    lowCost: 0.1,
    expectedCost: 0.2,
    highCost: 0.4,
    plannerTool: 'anthropic',
    implementerTool: 'deepseek',
    ...(review !== undefined && { plannerEstimateReview: review }),
  };
  return { type: 'cost_prediction', ts: 0, phase: 'implementing', prediction };
}

function makeDeterministicEvent(): Extract<EngineEvent, { type: 'cost_prediction' }> {
  const prediction: CostPrediction = {
    estimatedTasks: 1,
    lowCost: 0,
    expectedCost: 0,
    highCost: 0,
    plannerTool: 'codex',
    implementerTool: 'codex',
    deterministic: {
      taskCount: 1,
      taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
      contextConfidenceCounts: {
        contextExplicit: 1,
        contextDetected: 0,
        contextKnownCatalog: 0,
        contextCachedProvider: 0,
        contextConservativeFallback: 0,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: {
        priceKnown: 0,
        priceUnknown: 1,
        profileUnavailable: 0,
      },
      tasks: [
        {
          taskId: taskId('T001'),
          title: 'Validate current implementation without changes',
          estimatedPromptTokens: 1471,
          selectedProfileId: 'default',
          contextFit: 'fits',
          contextConfidence: 'context-explicit',
          priceConfidence: 'price-unknown',
          estimatedImplementerCost: null,
          hypotheticalPlannerCost: null,
        },
      ],
      totals: {
        knownActualEstimate: null,
        hypotheticalAllPlanner: null,
        estimatedSavings: null,
        unknownCostReason: ['implementer-price-unknown', 'planner-price-unknown'],
      },
    },
  };
  return { type: 'cost_prediction', ts: 0, phase: 'implementing', prediction };
}

describe('costPredictionRows', () => {
  it('renders deterministic details flush with the title instead of manual padding', () => {
    const rows = costPredictionRows('k', makeDeterministicEvent(), 120);
    const lines = rows.map(rowText);

    expect(lines).toContain('Cost prediction');
    expect(lines).toContain('Implementer: n/a All planner: n/a Savings: n/a');
    expect(lines).toContain('Unknown: implementer-price-unknown, planner-price-unknown');
    expect(lines.some((line) => line.startsWith('   '))).toBe(false);
  });

  it('renders the planner estimate review recommendation so it informs the cost decision', () => {
    const rows = costPredictionRows(
      'k',
      makeEvent({
        extraPlannerCall: true,
        status: 'completed',
        classification: 'needs-user-decision',
        affectedTaskIds: ['T001'],
        reason: 'Estimate uncertain for the selected worker.',
        recommendedUserDecision: 'Decline and pick a larger-context worker.',
      }),
      120,
    );
    const text = rows.map(rowText).join('\n');
    expect(text).toContain('Recommended: Decline and pick a larger-context worker.');
  });

  it('omits the recommendation row when the review has no recommended decision', () => {
    const rows = costPredictionRows(
      'k',
      makeEvent({
        extraPlannerCall: true,
        status: 'completed',
        classification: 'ok',
        affectedTaskIds: [],
        reason: 'Estimate looks fine.',
        recommendedUserDecision: null,
      }),
      120,
    );
    const text = rows.map(rowText).join('\n');
    expect(text).not.toContain('Recommended:');
  });
});
