import { describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../../testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getCostPredictionCardRowCount } from '../../../../core/features/cost-chrome.js';
import { CostPredictionCard } from './cost-prediction-card.js';

function visibleRows(frame: string): number {
  return frame.split('\n').filter(line => line.trim().length > 0).length;
}

describe('CostPredictionCard', () => {
  it('renders heuristic-only escalation scenarios without calling the high case an all-planner ceiling', () => {
    const event: EngineEventOf<'cost_prediction'> = {
      type: 'cost_prediction',
      ts: Date.now(),
      phase: 'planning',
      prediction: {
        estimatedTasks: 4,
        lowCost: 0.1,
        expectedCost: 0.2,
        highCost: 0.4,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
      },
    };

    const ui = renderFeature(<CostPredictionCard event={event} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Expected: ~15% escalation');
    expect(frame).toContain('High: ~40% escalation');
    expect(frame).not.toContain('all-planner ceiling');
    expect(visibleRows(frame)).toBe(getCostPredictionCardRowCount(event.prediction));

    ui.unmount();
  });

  it('renders deterministic unknown costs as n/a without fake zero dollars', () => {
    const event: EngineEventOf<'cost_prediction'> = {
      type: 'cost_prediction',
      ts: Date.now(),
      phase: 'planning',
      prediction: {
        estimatedTasks: 2,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'anthropic',
        implementerTool: 'custom-cloud',
        deterministic: {
          taskCount: 2,
          taskFitCounts: { fits: 1, tight: 0, overflow: 1, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 1,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 0,
            priceUnknown: 1,
            profileUnavailable: 1,
          },
          tasks: [
            {
              taskId: 'T001',
              title: 'Known fit',
              estimatedPromptTokens: 1000,
              selectedProfileId: 'custom-worker',
              contextFit: 'fits',
              contextConfidence: 'context-explicit',
              priceConfidence: 'price-unknown',
              estimatedImplementerCost: null,
              hypotheticalPlannerCost: null,
            },
            {
              taskId: 'T002',
              title: 'Overflow',
              estimatedPromptTokens: 2000,
              selectedProfileId: null,
              contextFit: 'overflow',
              contextConfidence: 'context-conservative-fallback',
              priceConfidence: 'profile-unavailable',
              estimatedImplementerCost: null,
              hypotheticalPlannerCost: null,
            },
          ],
          totals: {
            knownActualEstimate: null,
            hypotheticalAllPlanner: null,
            estimatedSavings: null,
            unknownCostReason: ['implementer-price-unknown', 'planner-price-unknown', 'profile-unavailable'],
          },
        },
      },
    };

    const ui = renderFeature(<CostPredictionCard event={event} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Deterministic estimate');
    expect(frame).toContain('Implementer: n/a');
    expect(frame).toContain('All planner: n/a');
    expect(frame).toContain('Savings: n/a');
    expect(frame).toContain('1 fit');
    expect(frame).toContain('1 overflow');
    expect(frame).toContain('Price known 0');
    expect(frame).toContain('Unknown: implementer-price-unknown, planner-price-unknown, profile-unavailable');
    expect(frame).not.toContain('$0.00');
    expect(visibleRows(frame)).toBe(getCostPredictionCardRowCount(event.prediction));

    ui.unmount();
  });

  it('renders opt-in planner estimate review metadata as an extra planner call', () => {
    const event: EngineEventOf<'cost_prediction'> = {
      type: 'cost_prediction',
      ts: Date.now(),
      phase: 'planning',
      prediction: {
        estimatedTasks: 1,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 0, tight: 1, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 1,
            priceUnknown: 0,
            profileUnavailable: 0,
          },
          tasks: [
            {
              taskId: 'T001',
              title: 'Risky task',
              estimatedPromptTokens: 8000,
              selectedProfileId: 'cheap-worker',
              contextFit: 'tight',
              contextConfidence: 'context-explicit',
              priceConfidence: 'price-known',
              estimatedImplementerCost: 0.01,
              hypotheticalPlannerCost: 0.08,
            },
          ],
          totals: {
            knownActualEstimate: 0.01,
            hypotheticalAllPlanner: 0.08,
            estimatedSavings: 0.07,
            unknownCostReason: [],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'completed',
          classification: 'risk',
          affectedTaskIds: ['T001'],
          reason: 'Task is tight.',
          recommendedUserDecision: 'Confirm before spending.',
        },
      },
    };

    const ui = renderFeature(<CostPredictionCard event={event} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Planner estimate review');
    expect(frame).toContain('extra planner call completed');
    expect(frame).toContain('risk');

    ui.unmount();
  });

  it('renders planner estimate review failure without hiding the deterministic estimate', () => {
    const event: EngineEventOf<'cost_prediction'> = {
      type: 'cost_prediction',
      ts: Date.now(),
      phase: 'planning',
      prediction: {
        estimatedTasks: 1,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 1,
            priceUnknown: 0,
            profileUnavailable: 0,
          },
          tasks: [],
          totals: {
            knownActualEstimate: 0.01,
            hypotheticalAllPlanner: 0.08,
            estimatedSavings: 0.07,
            unknownCostReason: [],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'unavailable',
          classification: null,
          affectedTaskIds: [],
          reason: 'Planner estimate review unavailable; deterministic estimate remains usable.',
          recommendedUserDecision: 'Continue with the deterministic estimate or rerun after fixing the planner.',
          error: 'planner offline',
        },
      },
    };

    const ui = renderFeature(<CostPredictionCard event={event} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Deterministic estimate');
    expect(frame).toContain('Planner estimate review: unavailable');
    expect(frame).toContain('deterministic estimate remains usable');

    ui.unmount();
  });

  it('renders "prediction n/a" when estimatedTasks and expectedCost are zero', () => {
    const event: EngineEventOf<'cost_prediction'> = {
      type: 'cost_prediction',
      ts: Date.now(),
      phase: 'planning',
      prediction: {
        estimatedTasks: 0,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
      },
    };

    const ui = renderFeature(<CostPredictionCard event={event} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('prediction n/a');
    expect(frame).not.toContain('Cost prediction');

    ui.unmount();
  });
});
