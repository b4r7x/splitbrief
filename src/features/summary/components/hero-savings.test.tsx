import { afterEach, describe, it, expect } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { HeroSavings } from './hero-savings.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { resetAllStores } from '#testing/helpers/stores.js';

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
  afterEach(() => {
    resetAllStores();
  });

  it('renders hero stat when savings are available', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown()} />);
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('$0.12 actual vs $0.95 baseline');
    expect(output).toContain('87% saved');
    expect(output).toContain('saved $0.83');
    expect(output).not.toContain(', 87%');
    ui.unmount();
  });

  it('uses compact savings copy on small terminals', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 20, isSmall: true });
    const ui = renderFeature(<HeroSavings costBreakdown={makeCostBreakdown()} />);
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('saved $0.83 (87%)');
    expect(output).not.toContain('actual vs');
    ui.unmount();
  });

  it('renders nothing when costBreakdown is undefined', () => {
    const ui = renderFeature(<HeroSavings costBreakdown={undefined} />);
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders nothing when hasSavingsEstimate is false', () => {
    const ui = renderFeature(
      <HeroSavings costBreakdown={makeCostBreakdown({ hasSavingsEstimate: false })} />,
    );
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders nothing when savingsAmount is zero', () => {
    const ui = renderFeature(
      <HeroSavings costBreakdown={makeCostBreakdown({ savingsAmount: 0, savingsPercentage: 0 })} />,
    );
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });

  it('renders nothing when savingsAmount is negative', () => {
    const ui = renderFeature(
      <HeroSavings
        costBreakdown={makeCostBreakdown({ savingsAmount: -0.05, savingsPercentage: -5 })}
      />,
    );
    expect(ui.lastFrame() ?? '').toBe('');
    ui.unmount();
  });
});
