import { describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { SummaryCostBreakdown } from './summary-cost-breakdown.js';
import { SummaryProgress } from './summary-progress.js';

describe('SummaryProgress', () => {
  it('renders local, escalated, and failed counts with the completion ratio', () => {
    const ui = renderFeature(
      <SummaryProgress
        completed={2}
        total={4}
        completedByLocal={1}
        escalatedToPlanner={1}
        failed={1}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2/4');
    expect(frame).toContain('1 local');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('1 failed');
    expect(frame).toContain('local = cheap implementer');

    ui.unmount();
  });
});

describe('SummaryCostBreakdown', () => {
  it('renders actual cost, savings, local rate, and provider costs', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 5,
      actualPlannerCost: 1,
      actualImplementerCost: 0.5,
      totalActualCost: 1.5,
      savingsAmount: 4.5,
      savingsPercentage: 75,
      localCompletionRate: 0.75,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      providerCosts: {
        anthropic: { inputTokens: 100_000, outputTokens: 50_000, cost: 1 },
        deepseek: { inputTokens: 200_000, outputTokens: 100_000, cost: 0.5 },
      },
    };

    const ui = renderFeature(
      <SummaryCostBreakdown
        costBreakdown={costBreakdown}
        labelWidth={28}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Actual cost');
    expect(frame).toContain('$1.50');
    expect(frame).toContain('Saved vs all-planner');
    expect(frame).toContain('baseline');
    expect(frame).toContain('$4.50 (75%)');
    expect(frame).toContain('Local rate');
    expect(frame).toContain('75%');
    expect(frame).toContain('Anthropic');
    expect(frame).toContain('DeepSeek');

    ui.unmount();
  });
});
