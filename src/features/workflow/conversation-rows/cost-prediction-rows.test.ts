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
      estimateScope: 'prompt-input-only',
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
    expect(lines).toContain(
      'Deterministic estimate from task briefs and routing preview: prompt input only',
    );
    expect(lines.some((line) => line.startsWith('Prompt input:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Implementer: n/a'))).toBe(false);
    expect(lines).toContain('Risk: 1 price unknown (1 task)');
    expect(lines).toContain('Unknown: implementer-price-unknown, planner-price-unknown');
    expect(lines.some((line) => line.startsWith('   '))).toBe(false);
  });

  it('labels known deterministic totals as prompt-input-only', () => {
    const event = makeDeterministicEvent();
    if (!event.prediction.deterministic) throw new Error('expected deterministic prediction');
    event.prediction.deterministic.totals = {
      knownActualEstimate: 0.14,
      hypotheticalAllPlanner: 1.2,
      estimatedSavings: 1.06,
      unknownCostReason: [],
    };
    event.prediction.deterministic.priceConfidenceCounts = {
      priceKnown: 1,
      priceUnknown: 0,
      profileUnavailable: 0,
    };

    const rows = costPredictionRows('k', event, 120);
    const text = rows.map(rowText).join('\n');
    expect(text).toContain('Prompt input: $0.14');
    expect(text).toContain('All-planner prompt: $1.20');
    expect(text).toContain('Prompt saving: $1.06');
    expect(text).not.toContain('Risk:');
    expect(text).not.toContain('Unknown:');
    expect(text).not.toContain('0 tight');
    expect(text).not.toContain('0 overflow');
    expect(text).not.toContain('Implementer: $');
  });

  it('renders the all-planner deterministic baseline when actual estimate is unknown', () => {
    const event = makeDeterministicEvent();
    if (!event.prediction.deterministic) throw new Error('expected deterministic prediction');
    event.prediction.deterministic.totals = {
      knownActualEstimate: null,
      hypotheticalAllPlanner: 1.2,
      estimatedSavings: null,
      unknownCostReason: ['implementer-price-unknown'],
    };

    const text = costPredictionRows('k', event, 120).map(rowText).join('\n');

    expect(text).toContain('All-planner prompt: $1.20');
    expect(text).toContain('Unknown: implementer-price-unknown');
    expect(text).not.toContain('Prompt input: $');
    expect(text).not.toContain('Prompt saving: $');
  });

  it('returns no rows for non-displayable predictions', () => {
    const event: Extract<EngineEvent, { type: 'cost_prediction' }> = {
      type: 'cost_prediction',
      ts: 0,
      phase: 'implementing',
      prediction: {
        estimatedTasks: 0,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'codex',
        implementerTool: 'codex',
      },
    };

    expect(costPredictionRows('k', event, 120)).toEqual([]);
  });

  it('surfaces only nonzero deterministic risk buckets', () => {
    const event = makeDeterministicEvent();
    if (!event.prediction.deterministic) throw new Error('expected deterministic prediction');
    event.prediction.deterministic.taskCount = 5;
    event.prediction.deterministic.taskFitCounts = { fits: 2, tight: 1, overflow: 1, unknown: 1 };
    event.prediction.deterministic.contextConfidenceCounts = {
      contextExplicit: 2,
      contextDetected: 0,
      contextKnownCatalog: 0,
      contextCachedProvider: 0,
      contextConservativeFallback: 1,
      profileUnavailable: 0,
    };
    event.prediction.deterministic.priceConfidenceCounts = {
      priceKnown: 3,
      priceUnknown: 2,
      profileUnavailable: 0,
    };

    const text = costPredictionRows('k', event, 120).map(rowText).join('\n');

    expect(text).toContain(
      'Risk: 1 tight · 1 overflow · 1 context unknown · 1 context fallback · 2 price unknown (5 tasks)',
    );
    expect(text).not.toContain('2 fit');
    expect(text).not.toContain('0 profile');
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
