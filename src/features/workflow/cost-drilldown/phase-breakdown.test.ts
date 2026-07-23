import { describe, it, expect } from 'vitest';
import {
  buildPhaseRows,
  formatCacheCreateTokens,
  formatInputOutputSplit,
  formatPhaseCost,
  formatSplitPhaseCost,
  calculatePhaseRowCost,
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
      (row) => calculatePhaseRowCost(row, pricing, null),
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
  it('shows partial label when only one split role is priced', () => {
    expect(
      formatSplitPhaseCost({
        cost: 18,
        plannerPriced: true,
        implementerPriced: false,
        plannerMode: 'priced',
        implementerMode: 'unpriced-local',
      }),
    ).toBe('$18.00 + partial');
  });

  it('shows full cost when both split roles are priced', () => {
    expect(
      formatSplitPhaseCost({
        cost: 18,
        plannerPriced: true,
        implementerPriced: true,
        plannerMode: 'priced',
        implementerMode: 'priced',
      }),
    ).toBe('$18.00');
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
