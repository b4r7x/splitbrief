import { describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../../testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { CostPredictionCard } from './cost-prediction-card.js';

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
