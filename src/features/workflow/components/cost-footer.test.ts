import { describe, it, expect } from 'vitest';
import { computeEta, formatModeLabel, formatRiskLabel, formatExpectedCost } from './cost-footer.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

describe('computeEta', () => {
  it('returns empty when no tasks completed yet', () => {
    expect(computeEta([], 0, 5)).toBe('');
  });

  it('returns empty when all tasks done', () => {
    expect(computeEta([3000, 4000], 5, 5)).toBe('');
  });

  it('calculates ETA from average task time', () => {
    // avg = 5000ms, remaining = 2 tasks → ~10s remaining
    const result = computeEta([4000, 6000], 3, 5);
    expect(result).toBe('~10s remaining');
  });

  it('formats minutes for longer ETAs', () => {
    // avg = 120_000ms (2m), remaining = 3 → ~6m remaining
    const result = computeEta([120_000, 120_000], 2, 5);
    expect(result).toBe('~6m 0s remaining');
  });

  it('returns empty when currentTask exceeds totalTasks', () => {
    expect(computeEta([5000], 6, 5)).toBe('');
  });

  it('handles zero completion times', () => {
    const result = computeEta([0, 0], 1, 3);
    expect(result).toBe('');
  });

  it('uses the most recent completion time when an earlier entry is negative', () => {
    const result = computeEta([-1000, 2000], 1, 3);
    expect(result).toBe('~1s remaining');
  });
});

describe('formatModeLabel', () => {
  it('returns empty when mode is undefined', () => {
    expect(formatModeLabel(undefined)).toBe('');
  });

  it('renders the mode label when mode is provided', () => {
    expect(formatModeLabel('standard')).toBe('mode standard');
    expect(formatModeLabel('instant')).toBe('mode instant');
    expect(formatModeLabel('quick')).toBe('mode quick');
    expect(formatModeLabel('speckit')).toBe('mode speckit');
  });

  it('never renders the legacy "full" label for any supported mode', () => {
    for (const mode of ['instant', 'quick', 'standard', 'speckit'] as const) {
      expect(formatModeLabel(mode)).not.toContain('full');
    }
  });
});

describe('formatRiskLabel', () => {
  it('returns "risk normal" for undefined risk', () => {
    expect(formatRiskLabel(undefined)).toBe('risk normal');
  });

  it('returns "risk normal" for normal risk', () => {
    expect(formatRiskLabel('normal')).toBe('risk normal');
  });

  it('formats high risk correctly', () => {
    expect(formatRiskLabel('high')).toBe('risk high');
  });

  it('formats trivial risk correctly', () => {
    expect(formatRiskLabel('trivial')).toBe('risk trivial');
  });

  it('formats small risk correctly', () => {
    expect(formatRiskLabel('small')).toBe('risk small');
  });
});

describe('formatExpectedCost', () => {
  it('returns "local" when only unpriced usage and no priced usage', () => {
    const breakdown = { hasUnpricedUsage: true, hasPricedUsage: false } as CostBreakdown;
    expect(formatExpectedCost(breakdown, null)).toBe('local');
  });

  it('does NOT show "local" when priced usage is also present', () => {
    const breakdown = { hasUnpricedUsage: true, hasPricedUsage: true } as CostBreakdown;
    const prediction = { expectedCost: 0.5, estimatedTasks: 2, lowCost: 0.1, highCost: 1.0, plannerTool: 'x', implementerTool: 'y' };
    const result = formatExpectedCost(breakdown, prediction);
    expect(result).not.toBe('local');
    expect(result).toContain('$0.50');
  });

  it('returns expected cost from prediction when available and priced', () => {
    const prediction = { expectedCost: 0.14, estimatedTasks: 2, lowCost: 0.05, highCost: 0.30, plannerTool: 'x', implementerTool: 'y' };
    expect(formatExpectedCost(null, prediction)).toBe('$0.14 expected');
  });

  it('returns empty string when no prediction and no costBreakdown', () => {
    expect(formatExpectedCost(null, null)).toBe('');
  });

  it('does NOT show fake "$0.00 expected" for zero-cost prediction', () => {
    const prediction = { expectedCost: 0, estimatedTasks: 0, lowCost: 0, highCost: 0, plannerTool: 'x', implementerTool: 'y' };
    expect(formatExpectedCost(null, prediction)).toBe('');
  });

  it('unpriced usage never shows a dollar cost (no fake savings)', () => {
    const breakdown = { hasUnpricedUsage: true, hasPricedUsage: false } as CostBreakdown;
    const prediction = { expectedCost: 99.99, estimatedTasks: 5, lowCost: 50, highCost: 150, plannerTool: 'x', implementerTool: 'y' };
    const result = formatExpectedCost(breakdown, prediction);
    expect(result).toBe('local');
    expect(result).not.toContain('$');
  });
});

describe('footer line width', () => {
  it('typical line stays within 80 columns', () => {
    // Simulate: Task 2/5 · mode standard · risk normal · $0.14 expected
    const line = ['Task 2/5', 'mode standard', 'risk normal', '$0.14 expected'].join(' · ');
    expect(line.length).toBeLessThanOrEqual(80);
  });

  it('small terminal line stays within 60 columns', () => {
    // Simulate minimal footer: Task 1/1 · mode instant · local
    const line = ['Task 1/1', 'mode instant', 'local'].join(' · ');
    expect(line.length).toBeLessThanOrEqual(60);
  });
});
