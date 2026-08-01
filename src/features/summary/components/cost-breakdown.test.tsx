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

    expect(frame).toContain('◆ Cost');
    expect(frame).toContain('Actual cost');
    expect(frame).toContain('$1.50');
    expect(frame).toContain('Planner cost');
    expect(frame).toContain('Implementer cost');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$5.00');
    expect(frame).toContain('Saved');
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

    expect(frame).toContain('Actual cost');
    expect(frame).toContain('$1.00 + unknown');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('Saved');
    expect(frame).toContain('Unknown price');
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

    expect(frame).toContain('Extra cost');
    expect(frame).toContain('Extra $0.05 (-50%)');
    expect(frame).not.toContain('saved $0.00');

    ui.unmount();
  });

  it('labels each offering posture from the run metadata instead of a raw amount', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 4,
      actualPlannerCost: 0,
      actualImplementerCost: 0.25,
      totalActualCost: 0.25,
      savingsAmount: 3.75,
      savingsPercentage: 94,
      localCompletionRate: 0.5,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
      providerCosts: {
        'claude-code': { inputTokens: 100, outputTokens: 100, cost: 0 },
        openai: { inputTokens: 100, outputTokens: 100, cost: 0.25 },
        groq: { inputTokens: 100, outputTokens: 100, cost: 0 },
        ollama: { inputTokens: 100, outputTokens: 100, cost: 0 },
      },
      providerRunMetadata: {
        'claude-code': {
          service: 'claude-code',
          offering: 'coding-subscription',
          normalizedEndpoint: '',
          billing: 'subscription-included',
          asOf: '2026-07-31',
        },
        openai: {
          service: 'openai',
          offering: 'payg',
          normalizedEndpoint: 'https://api.openai.com/v1',
          billing: 'api-metered',
          asOf: '2026-07-31',
        },
        groq: {
          service: 'groq',
          offering: 'free-quota',
          normalizedEndpoint: 'https://api.groq.com/openai/v1',
          billing: 'api-metered',
          asOf: '2026-07-31',
        },
        ollama: {
          service: 'ollama',
          offering: 'local',
          normalizedEndpoint: 'http://localhost:11434/v1',
          billing: 'local',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        'claude-code': {
          costLabel: 'subscription-included',
          billingLabel: 'subscription-included',
        },
        openai: { costLabel: '$0.25', billingLabel: 'api-metered' },
        groq: { costLabel: 'variable quota', billingLabel: 'api-metered' },
        ollama: { costLabel: 'local', billingLabel: 'local' },
      },
    };

    const ui = renderFeature(<CostBreakdownRows costBreakdown={costBreakdown} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('subscription-included');
    expect(frame).toContain('variable quota');
    expect(frame).toContain('local');
    expect(frame).toContain('$0.25');

    ui.unmount();
  });

  it('never presents a subscription-only run as a metered charge', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 2,
      actualPlannerCost: 0,
      actualImplementerCost: 0,
      totalActualCost: 0,
      savingsAmount: -0.5,
      savingsPercentage: -25,
      localCompletionRate: 1,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
      providerRunMetadata: {
        'claude-code': {
          service: 'claude-code',
          offering: 'coding-subscription',
          normalizedEndpoint: '',
          billing: 'subscription-included',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        'claude-code': {
          costLabel: 'subscription-included',
          billingLabel: 'subscription-included',
        },
      },
    };

    const ui = renderFeature(<CostBreakdownRows costBreakdown={costBreakdown} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('subscription-included');
    expect(frame).not.toContain('Extra $');
    expect(frame).not.toContain('$0.00');
    expect(frame).not.toMatch(/\bfree\b/);

    ui.unmount();
  });
});
