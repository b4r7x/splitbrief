import { describe, it, expect } from 'vitest';
import { calculateCostBreakdown } from './index.js';
import { makeUsage } from '#testing/helpers/fixtures.js';

describe('calculateCostBreakdown', () => {
  it('all local (0 escalations) yields 100% localCompletionRate and positive savings', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 1_000_000,
      implementerOutput: 500_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 5, escalatedCount: 0, plannerTool: 'claude-code', implementerProvider: 'ollama' });
    expect(result.localCompletionRate).toBe(1);
    expect(result.savingsPercentage).toBeGreaterThan(0);
  });

  it('all escalated yields 0% localCompletionRate', () => {
    const usage = makeUsage({
      plannerInput: 500_000,
      plannerOutput: 200_000,
      escalationInput: 1_000_000,
      escalationOutput: 500_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 3, escalatedCount: 3, plannerTool: 'claude-code', implementerProvider: 'ollama' });
    expect(result.localCompletionRate).toBe(0);
  });

  it('mixed (5 local, 2 escalated out of 7) yields ~71.4% localCompletionRate', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 200_000,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 7, escalatedCount: 2, plannerTool: 'claude-code', implementerProvider: 'ollama' });
    expect(Math.abs(result.localCompletionRate - 0.7142857142857143)).toBeLessThan(0.001);
  });

  it('zero tasks yields 0% localCompletionRate without division by zero', () => {
    const usage = makeUsage();
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 0, escalatedCount: 0, plannerTool: 'claude-code', implementerProvider: 'ollama' });
    expect(result.localCompletionRate).toBe(0);
    expect(result.savingsAmount).toBe(0);
    expect(Number.isFinite(result.savingsPercentage)).toBe(true);
  });

  it('negative savings clamped to 0', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 1, escalatedCount: 0, plannerTool: 'claude-code', implementerProvider: 'ollama' });
    expect(result.savingsAmount).toBe(0);
    expect(result.savingsPercentage).toBe(0);
  });
});
