import { describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../../testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { CostPredictionCard } from './cost-prediction-card.js';

describe('CostPredictionCard', () => {
  it('renders escalation scenarios without calling the high case an all-planner ceiling', () => {
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
