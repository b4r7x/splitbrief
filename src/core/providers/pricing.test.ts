import { describe, it, expect } from 'vitest';
import { calculateCost, type PricingInfo } from './pricing.js';

describe('calculateCost', () => {
  it('returns 0 for local pricing', () => {
    const pricing: PricingInfo = { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Local' };
    expect(calculateCost(500_000, 500_000, pricing)).toBe(0);
  });

  it('handles zero tokens', () => {
    const pricing: PricingInfo = { inputPer1M: 10, outputPer1M: 20, isLocal: false, name: 'Test' };
    expect(calculateCost(0, 0, pricing)).toBe(0);
  });

  it.each([
    { model: 'basic', inputPer1M: 10, outputPer1M: 20, input: 1_000_000, output: 1_000_000, expected: 30 },
    { model: 'output-only', inputPer1M: 10, outputPer1M: 20, input: 0, output: 500_000, expected: 10 },
    { model: 'fractional', inputPer1M: 3, outputPer1M: 15, input: 1500, output: 800, expected: 0.0045 + 0.012 },
    { model: 'large', inputPer1M: 5, outputPer1M: 25, input: 10_000_000, output: 5_000_000, expected: 175 },
    { model: 'free', inputPer1M: 0, outputPer1M: 0, input: 1_000_000, output: 1_000_000, expected: 0 },
    { model: 'DeepSeek', inputPer1M: 0.28, outputPer1M: 0.42, input: 50_000, output: 10_000, expected: 0.014 + 0.0042 },
    { model: 'o4-mini', inputPer1M: 0.55, outputPer1M: 2.2, input: 200_000, output: 100_000, expected: 0.11 + 0.22 },
    { model: 'Claude Opus', inputPer1M: 5, outputPer1M: 25, input: 100_000, output: 50_000, expected: 0.5 + 1.25 },
  ])('calculates correctly for $model pricing', ({ inputPer1M, outputPer1M, input, output, expected }) => {
    const pricing: PricingInfo = { inputPer1M, outputPer1M, isLocal: false, name: 'Test' };
    expect(calculateCost(input, output, pricing)).toBeCloseTo(expected, 6);
  });
});
