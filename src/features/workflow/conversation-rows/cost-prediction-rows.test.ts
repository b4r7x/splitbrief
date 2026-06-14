import { describe, expect, it } from 'vitest';
import type { CostPrediction, PlannerEstimateReview } from '../../../core/schemas/summary.js';
import type { EngineEvent } from '../../../engine/events/types.js';
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

describe('costPredictionRows', () => {
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
