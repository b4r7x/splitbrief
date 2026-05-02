import { describe, it, expect } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { HeroSavings } from './hero-savings.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    hypotheticalCost: 0.95,
    actualPlannerCost: 0.03,
    actualImplementerCost: 0.09,
    totalActualCost: 0.12,
    savingsAmount: 0.83,
    savingsPercentage: 87,
    localCompletionRate: 0.92,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    hasSavingsEstimate: true,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isTotalActualCostKnown: true,
    isAllPlannerBaselineKnown: true,
    ...overrides,
  };
}

describe('HeroSavings', () => {
  it('renders hero stat when savings are available', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown()} />);
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('$0.12 actual vs $0.95 all-planner');
    expect(output).toContain('87% saved');
    expect(output).toContain('Saved $0.83');
    ui.unmount();
  });

  it('renders nothing when costBreakdown is undefined', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={undefined} />);
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders nothing when hasSavingsEstimate is false', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown({ hasSavingsEstimate: false })} />);
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders dim message when savingsAmount is zero', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown({ savingsAmount: 0, savingsPercentage: 0 })} />);
    expect(ui.lastFrame() ?? '').toContain('No savings this run');
    ui.unmount();
  });

  it('renders dim message when savingsAmount is negative', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown({ savingsAmount: -0.05, savingsPercentage: -5 })} />);
    expect(ui.lastFrame() ?? '').toContain('No savings this run');
    ui.unmount();
  });
});
