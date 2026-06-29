import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { buildCostBreakdownRows } from './cost-breakdown.js';

function CostBreakdownRows({ costBreakdown }: { costBreakdown: CostBreakdown }) {
  const theme = useTheme();
  const rows = buildCostBreakdownRows({ costBreakdown, labelWidth: 28, theme });
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

describe('buildCostBreakdownRows', () => {
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

    const ui = renderFeature(<CostBreakdownRows costBreakdown={costBreakdown} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('◆ cost');
    expect(frame).toContain('actual cost');
    expect(frame).toContain('$1.50');
    expect(frame).toContain('planner cost');
    expect(frame).toContain('implementer cost');
    expect(frame).toContain('all-planner baseline');
    expect(frame).toContain('$5.00');
    expect(frame).toContain('saved');
    expect(frame).toContain('$4.50 (75%)');
    expect(frame).not.toContain('Local/cheap rate');
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

    const ui = renderFeature(<CostBreakdownRows costBreakdown={costBreakdown} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('actual cost');
    expect(frame).toContain('$1.00 + unknown');
    expect(frame).toContain('all-planner baseline');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('saved');
    expect(frame).toContain('unknown price');
    expect(frame).not.toContain('Local/cheap rate');
    expect(frame).not.toContain('$0.00');

    ui.unmount();
  });

  it('renders negative savings as extra cost without clamping to zero', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 0.1,
      actualPlannerCost: 0.05,
      actualImplementerCost: 0.1,
      totalActualCost: 0.15,
      savingsAmount: -0.05,
      savingsPercentage: -50,
      localCompletionRate: 0.5,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
    };

    const ui = renderFeature(<CostBreakdownRows costBreakdown={costBreakdown} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('extra cost');
    expect(frame).toContain('extra $0.05 (-50%)');
    expect(frame).not.toContain('saved $0.00');

    ui.unmount();
  });
});
