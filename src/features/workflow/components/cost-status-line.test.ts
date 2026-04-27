import { describe, it, expect } from 'vitest';
import {
  formatProjected,
  formatBudget,
  formatCachePct,
  buildStatusLine,
} from './cost-status-line.js';

describe('formatProjected', () => {
  it('returns rolling average when tasks completed', () => {
    // 2 tasks completed, $2.00 spent, 4 total → projected $4.00
    expect(formatProjected(2, 2.0, null, 4)).toBe('proj $4.00');
  });

  it('falls back to prediction.expectedCost when no tasks completed', () => {
    const prediction = { estimatedTasks: 4, lowCost: 1, expectedCost: 3.5, highCost: 6, plannerTool: 'x', implementerTool: 'y' };
    expect(formatProjected(0, 0, prediction, 4)).toBe('proj $3.50');
  });

  it('returns proj n/a when neither completed tasks nor prediction available', () => {
    expect(formatProjected(0, 0, null, 4)).toBe('proj n/a');
  });

  it('uses rolling avg even when prediction is present', () => {
    const prediction = { estimatedTasks: 4, lowCost: 1, expectedCost: 3.5, highCost: 6, plannerTool: 'x', implementerTool: 'y' };
    expect(formatProjected(1, 1.0, prediction, 4)).toBe('proj $4.00');
  });
});

describe('formatBudget', () => {
  it('returns empty string when maxBudget is undefined', () => {
    expect(formatBudget(undefined)).toBe('');
  });

  it('returns formatted cost when maxBudget is defined', () => {
    expect(formatBudget(10)).toBe('$10.00');
    expect(formatBudget(0.5)).toBe('$0.50');
  });
});

describe('formatCachePct', () => {
  it('returns cache n/a when cacheRead is undefined', () => {
    expect(formatCachePct(undefined, 1000)).toBe('cache n/a');
  });

  it('returns cache n/a when both cacheRead and input are zero', () => {
    expect(formatCachePct(0, 0)).toBe('cache n/a');
  });

  it('returns cache n/a when cacheRead is zero', () => {
    expect(formatCachePct(0, 1000)).toBe('cache n/a');
  });

  it('returns cache percentage when data is present', () => {
    // 500 cache out of 500+500 total = 50%
    expect(formatCachePct(500, 500)).toBe('cache 50%');
  });

  it('rounds percentage correctly', () => {
    // 1 cache, 2 input → 1/(1+2) = 33%
    expect(formatCachePct(1, 2)).toBe('cache 33%');
  });
});

describe('buildStatusLine', () => {
  it('joins non-empty parts with separator', () => {
    expect(buildStatusLine(['a', 'b', 'c'])).toBe('a · b · c');
  });

  it('skips empty strings', () => {
    expect(buildStatusLine(['a', '', 'c'])).toBe('a · c');
  });

  it('returns empty string when all parts empty', () => {
    expect(buildStatusLine(['', '', ''])).toBe('');
  });

  it('returns single part without separator', () => {
    expect(buildStatusLine(['only'])).toBe('only');
  });
});
