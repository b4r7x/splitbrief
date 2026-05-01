import { describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { SummaryCostBreakdown } from './cost-breakdown.js';
import { SummaryProgress } from './progress.js';

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
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
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
    expect(frame).toContain('Planner cost');
    expect(frame).toContain('Implementer cost');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$5.00');
    expect(frame).toContain('Saved');
    expect(frame).toContain('$4.50 (75%)');
    expect(frame).toContain('Local/cheap rate');
    expect(frame).toContain('75%');
    expect(frame).toContain('Anthropic');
    expect(frame).toContain('DeepSeek');

    ui.unmount();
  });

  it('renders unknown price instead of fake zero cost when implementer pricing is unavailable', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 18,
      actualPlannerCost: 1,
      actualImplementerCost: 0,
      totalActualCost: 1,
      savingsAmount: 0,
      savingsPercentage: 0,
      localCompletionRate: 1,
      hasPricedUsage: true,
      hasUnpricedUsage: true,
      hasSavingsEstimate: false,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: false,
      isTotalActualCostKnown: false,
      isAllPlannerBaselineKnown: true,
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
    expect(frame).toContain('$1.00 + unknown');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('Saved');
    expect(frame).toContain('Unknown price');
    expect(frame).toContain('Local/cheap rate');
    expect(frame).toContain('100%');
    expect(frame).not.toContain('$0.00');

    ui.unmount();
  });
});
