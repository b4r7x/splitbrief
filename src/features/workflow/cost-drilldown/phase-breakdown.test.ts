import { describe, it, expect } from 'vitest';
import {
  buildPhaseRows,
  formatCacheCreateTokens,
  formatInputOutputSplit,
  formatPhaseCost,
  formatSplitPhaseCost,
  calculatePhaseRowCost,
  roleHasTokens,
} from './phase-breakdown.js';
import { resolvePricing } from '../../../engine/providers/pricing-resolver.js';

describe('buildPhaseRows', () => {
  it('returns empty array for empty perPhase', () => {
    expect(buildPhaseRows({})).toEqual([]);
  });

  it('can sort by a derived display cost when store rows keep raw token data', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    const rows = buildPhaseRows(
      {
        planning: {
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        'reviewing-plan': {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      },
      (row) =>
        calculatePhaseRowCost({
          row,
          plannerPricing: pricing,
          implementerPricing: null,
          reviewerPricing: null,
          reviewerHasOwnSeat: false,
        }),
    );

    expect(rows.map((r) => r.phase)).toEqual(['reviewing-plan', 'planning']);
    expect(rows[0]?.cost).toBeGreaterThan(0);
  });
});

describe('formatInputOutputSplit', () => {
  it.each([
    [300, 200, 'in: 300 / out: 200'],
    [1500, 500, 'in: 1.5k / out: 0.5k'],
  ] as const)('formatInputOutputSplit(%i, %i) → %s', (input, output, expected) => {
    expect(formatInputOutputSplit({ inputTokens: input, outputTokens: output })).toBe(expected);
  });
});

describe('formatCacheCreateTokens', () => {
  it.each([
    [0, ''],
    [1500, 'create 1.5k'],
  ] as const)('formatCacheCreateTokens(%i) → %s', (tokens, expected) => {
    expect(formatCacheCreateTokens(tokens)).toBe(expected);
  });
});

describe('formatSplitPhaseCost', () => {
  it('shows partial label when only one split seat is priced', () => {
    expect(
      formatSplitPhaseCost({
        cost: 18,
        seats: [
          { priced: true, mode: 'priced' },
          { priced: false, mode: 'unpriced-local' },
        ],
      }),
    ).toBe('$18.00 + partial');
  });

  it('shows full cost when every split seat is priced', () => {
    expect(
      formatSplitPhaseCost({
        cost: 18,
        seats: [
          { priced: true, mode: 'priced' },
          { priced: true, mode: 'priced' },
        ],
      }),
    ).toBe('$18.00');
  });

  it('shows the cost of a phase billed only to the reviewer seat', () => {
    expect(
      formatSplitPhaseCost({
        cost: 18,
        seats: [
          { priced: false, mode: 'priced' },
          { priced: false, mode: 'priced' },
          { priced: true, mode: 'priced' },
        ],
      }),
    ).toBe('$18.00 + partial');
  });
});

describe('formatPhaseCost', () => {
  it.each([
    [0, false, 'unpriced-local' as const, 'local'],
    [0, false, 'unpriced-cli' as const, 'unpriced'],
    [0, false, 'unpriced-meta' as const, 'unpriced'],
    [0, false, 'unpriced-unknown' as const, 'n/a'],
    [0, false, null, 'n/a'],
  ] as const)('formatPhaseCost(%i, %s, %s) → %s', (cost, isPhasePriced, pricingMode, expected) => {
    expect(formatPhaseCost({ cost, isPhasePriced, pricingMode })).toBe(expected);
  });
});

describe('calculatePhaseRowCost — reviewer fold', () => {
  const plannerPricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
  const reviewerPricing = resolvePricing('deepseek', undefined, 'deepseek-v4-flash');
  const row = {
    phase: 'final-review',
    inputTokens: 20_000,
    outputTokens: 5_000,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheReadTokens: 0,
    plannerCacheCreateTokens: 0,
    reviewerInputTokens: 20_000,
    reviewerOutputTokens: 5_000,
    reviewerCacheReadTokens: 0,
    reviewerCacheCreateTokens: 0,
    implementerInputTokens: 0,
    implementerOutputTokens: 0,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
  } as const;

  it('prices review tokens at the planner rate when no reviewer is configured', () => {
    const folded = calculatePhaseRowCost({
      row,
      plannerPricing,
      implementerPricing: null,
      reviewerPricing: null,
      reviewerHasOwnSeat: false,
    });
    const plannerBilled = calculatePhaseRowCost({
      row: {
        ...row,
        plannerInputTokens: 20_000,
        plannerOutputTokens: 5_000,
        reviewerInputTokens: 0,
        reviewerOutputTokens: 0,
      },
      plannerPricing,
      implementerPricing: null,
      reviewerPricing: null,
      reviewerHasOwnSeat: false,
    });

    expect(folded).toBeGreaterThan(0);
    expect(folded).toBe(plannerBilled);
    expect(roleHasTokens({ row, role: 'reviewer', reviewerHasOwnSeat: false })).toBe(false);
  });

  it('prices review tokens at the reviewer rate as their own figure when one is configured', () => {
    const split = calculatePhaseRowCost({
      row,
      plannerPricing,
      implementerPricing: null,
      reviewerPricing,
      reviewerHasOwnSeat: true,
    });
    const folded = calculatePhaseRowCost({
      row,
      plannerPricing,
      implementerPricing: null,
      reviewerPricing: null,
      reviewerHasOwnSeat: false,
    });

    expect(split).toBeGreaterThan(0);
    expect(split).not.toBe(folded);
    expect(roleHasTokens({ row, role: 'reviewer', reviewerHasOwnSeat: true })).toBe(true);
    expect(roleHasTokens({ row, role: 'planner', reviewerHasOwnSeat: true })).toBe(false);
  });

  it('never folds review tokens into the implementer seat', () => {
    expect(roleHasTokens({ row, role: 'implementer', reviewerHasOwnSeat: false })).toBe(false);
    expect(roleHasTokens({ row, role: 'implementer', reviewerHasOwnSeat: true })).toBe(false);
  });
});
