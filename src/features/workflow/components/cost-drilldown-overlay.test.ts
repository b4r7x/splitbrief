import { describe, it, expect } from 'vitest';
import {
  buildPhaseRows,
  buildTaskRows,
  renderBar,
  formatCacheHitPct,
  formatInputOutputSplit,
  formatTotalTokens,
} from './cost-drilldown-overlay.js';

describe('buildPhaseRows', () => {
  it('returns empty array for empty perPhase', () => {
    expect(buildPhaseRows({})).toEqual([]);
  });

  it('sorts by cost descending', () => {
    const rows = buildPhaseRows({
      planning: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cost: 0.01 },
      implementing: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100, cost: 0.05 },
      validating: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cost: 0.003 },
    });
    expect(rows.map(r => r.phase)).toEqual(['implementing', 'planning', 'validating']);
  });
});

describe('buildTaskRows', () => {
  it('returns empty array for empty perTask', () => {
    expect(buildTaskRows({})).toEqual([]);
  });

  it('sorts by totalTokens descending', () => {
    const rows = buildTaskRows({
      task1: { totalTokens: 200, cost: 0.01, title: 'First task' },
      task2: { totalTokens: 800, cost: 0.04, title: 'Second task' },
      task3: { totalTokens: 50, cost: 0.002, title: 'Third task' },
    });
    expect(rows.map(r => r.taskId)).toEqual(['task2', 'task1', 'task3']);
  });
});

describe('renderBar', () => {
  it('returns empty string when max is 0', () => {
    expect(renderBar(0, 0, 10)).toBe('');
    expect(renderBar(5, 0, 10)).toBe('');
  });

  it('returns full bar when value equals max', () => {
    expect(renderBar(10, 10, 10)).toBe('█'.repeat(10));
  });

  it('returns correct proportional bar', () => {
    const bar = renderBar(5, 10, 10);
    expect(bar).toBe('█████░░░░░');
  });

  it('returns empty bar when value is 0', () => {
    const bar = renderBar(0, 10, 10);
    expect(bar).toBe('░'.repeat(10));
  });
});

describe('formatCacheHitPct', () => {
  it('returns cache n/a when cacheRead is 0', () => {
    expect(formatCacheHitPct(0, 500)).toBe('cache n/a');
  });

  it('returns cache n/a when input is 0', () => {
    expect(formatCacheHitPct(100, 0)).toBe('cache n/a');
  });

  it('returns correct percentage', () => {
    // cacheRead / (cacheRead + input) — 200 / (200 + 800) = 20%
    expect(formatCacheHitPct(200, 800)).toBe('20%');
  });

  it('returns 50% for equal cacheRead and input', () => {
    expect(formatCacheHitPct(500, 500)).toBe('50%');
  });
});

describe('formatInputOutputSplit', () => {
  it('shows raw numbers when total <= 1000', () => {
    expect(formatInputOutputSplit(300, 200)).toBe('in: 300 / out: 200');
  });

  it('scales to k when total > 1000', () => {
    expect(formatInputOutputSplit(1500, 500)).toBe('in: 1.5k / out: 0.5k');
  });
});

describe('formatTotalTokens', () => {
  it('includes (total) suffix', () => {
    expect(formatTotalTokens(500)).toContain('(total)');
  });

  it('shows raw count when <= 1000', () => {
    expect(formatTotalTokens(500)).toBe('500 tokens (total)');
  });

  it('scales to k when > 1000', () => {
    expect(formatTotalTokens(2500)).toBe('2.5k tokens (total)');
  });
});
