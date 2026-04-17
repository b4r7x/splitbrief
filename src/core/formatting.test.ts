import { describe, it, expect } from 'vitest';
import { formatCost, formatContextLength } from './formatting.js';

describe('formatCost', () => {
  it('formats dollars with two decimals and clamps invalid input', () => {
    expect(formatCost(42.5)).toBe('$42.50');
    expect(formatCost(0.001)).toBe('$0.00');
    expect(formatCost(-5.5)).toBe('$0.00');
    expect(formatCost(NaN)).toBe('$0.00');
    expect(formatCost(Infinity)).toBe('$0.00');
  });
});

describe('formatContextLength', () => {
  it('renders tokens as K or M with appropriate precision', () => {
    expect(formatContextLength(undefined)).toBe('');
    expect(formatContextLength(0)).toBe('');
    expect(formatContextLength(128_000)).toBe('128K');
    expect(formatContextLength(1_000_000)).toBe('1M');
    expect(formatContextLength(1_500_000)).toBe('1.5M');
  });
});
