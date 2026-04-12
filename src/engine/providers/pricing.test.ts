import { describe, it, expect } from 'vitest';
import { calculateCost, calculateCostBreakdown, getModelPricing, getProviderPricing } from './pricing.js';
import { makeUsage } from '#testing/helpers/fixtures.js';

describe('calculateCost', () => {
  it('returns 0 for local pricing', () => {
    const pricing = { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Local' };
    expect(calculateCost(500_000, 500_000, pricing)).toBe(0);
  });

  it('handles zero tokens', () => {
    const pricing = { inputPer1M: 10, outputPer1M: 20, isLocal: false, name: 'Test' };
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
    const pricing = { inputPer1M, outputPer1M, isLocal: false, name: 'Test' };
    expect(calculateCost(input, output, pricing)).toBeCloseTo(expected, 6);
  });
});

describe('calculateCostBreakdown providerCosts', () => {
  it('returns providerCosts for planner and implementer', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 1_000_000,
      implementerOutput: 500_000,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 5,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(result.providerCosts).toBeDefined();
    const pc = result.providerCosts ?? {};
    const claudeCode = pc['claude-code'];
    expect(claudeCode).toBeDefined();
    expect(claudeCode?.cost).toBe(result.actualPlannerCost);
    expect(claudeCode?.inputTokens).toBe(100_000);
    expect(claudeCode?.outputTokens).toBe(50_000);
    const ollama = pc['ollama'];
    expect(ollama).toBeDefined();
    expect(ollama?.cost).toBe(0);
  });

  it('includes escalation tokens under planner provider', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      escalationInput: 200_000,
      escalationOutput: 100_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 1,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    const claudeCodeEntry = result.providerCosts?.['claude-code'];
    expect(claudeCodeEntry).toBeDefined();
    expect(claudeCodeEntry?.inputTokens).toBe(300_000);
    expect(claudeCodeEntry?.outputTokens).toBe(150_000);
  });

  it('merges when planner and implementer are the same provider', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'deepseek',
      implementerTool: 'deepseek',
    });

    const pc1 = result.providerCosts ?? {};
    expect(Object.keys(pc1)).toHaveLength(1);
    const deepseek1 = pc1['deepseek'];
    expect(deepseek1).toBeDefined();
    expect(deepseek1?.inputTokens).toBe(300_000);
    expect(deepseek1?.outputTokens).toBe(150_000);
    expect(deepseek1?.cost).toBeCloseTo(result.totalActualCost, 6);
  });

  it('merges when same provider and planner has zero tokens', () => {
    const usage = makeUsage({
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 0,
      plannerTool: 'deepseek',
      implementerTool: 'deepseek',
    });

    expect(result.providerCosts).toBeDefined();
    const pc2 = result.providerCosts ?? {};
    expect(Object.keys(pc2)).toHaveLength(1);
    const deepseek2 = pc2['deepseek'];
    expect(deepseek2).toBeDefined();
    expect(deepseek2?.inputTokens).toBe(500_000);
    expect(deepseek2?.outputTokens).toBe(200_000);
    expect(deepseek2?.cost).toBeCloseTo(result.totalActualCost, 6);
  });

  it('returns undefined providerCosts when no tokens used', () => {
    const usage = makeUsage();
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 0,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(result.providerCosts).toBeUndefined();
  });
});

describe('getModelPricing', () => {
  it.each([
    { model: 'claude-sonnet-4', inputPer1M: 3, outputPer1M: 15 },
    { model: 'claude-opus-4', inputPer1M: 15, outputPer1M: 75 },
    { model: 'claude-haiku-3-5', inputPer1M: 0.80, outputPer1M: 4 },
    { model: 'gpt-4o', inputPer1M: 2.50, outputPer1M: 10 },
    { model: 'gpt-4o-mini', inputPer1M: 0.15, outputPer1M: 0.60 },
    { model: 'gpt-4.1', inputPer1M: 2, outputPer1M: 8 },
    { model: 'gpt-4.1-mini', inputPer1M: 0.40, outputPer1M: 1.60 },
    { model: 'o3-mini', inputPer1M: 1.10, outputPer1M: 4.40 },
    { model: 'gemini-2.5-flash', inputPer1M: 0.15, outputPer1M: 0.60 },
    { model: 'gemini-2.5-pro', inputPer1M: 1.25, outputPer1M: 10 },
    { model: 'deepseek-chat', inputPer1M: 0.14, outputPer1M: 0.28 },
    { model: 'deepseek-reasoner', inputPer1M: 0.55, outputPer1M: 2.19 },
    { model: 'mistral-small-3.1', inputPer1M: 0.10, outputPer1M: 0.30 },
    { model: 'codestral', inputPer1M: 0.30, outputPer1M: 0.90 },
  ])('returns correct pricing for $model', ({ model, inputPer1M, outputPer1M }) => {
    const pricing = getModelPricing(model);
    expect(pricing).toMatchObject({ inputPer1M, outputPer1M });
  });

  it('resolves model with date suffix via normalization', () => {
    const pricing = getModelPricing('claude-sonnet-4-20250514');
    expect(pricing).toMatchObject({ inputPer1M: 3 });
  });

  it('resolves model with provider prefix via normalization', () => {
    const pricing = getModelPricing('anthropic/claude-opus-4');
    expect(pricing).toMatchObject({ inputPer1M: 15 });
  });

  it('resolves model with both prefix and date suffix', () => {
    const pricing = getModelPricing('anthropic/claude-haiku-3-5-20241022');
    expect(pricing).toMatchObject({ inputPer1M: 0.80 });
  });

  it('returns undefined for unknown models', () => {
    expect(getModelPricing('totally-unknown-model')).toBeUndefined();
  });
});

describe('getProviderPricing', () => {
  it('returns local pricing for agent tool', () => {
    const pricing = getProviderPricing('agent');
    expect(pricing).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      isLocal: true,
      name: 'Local model',
    });
  });

  it('returns local pricing for other local tools', () => {
    const ollamaPricing = getProviderPricing('ollama');
    const lmStudioPricing = getProviderPricing('lm-studio');
    const shellPricing = getProviderPricing('shell');

    [ollamaPricing, lmStudioPricing, shellPricing].forEach(pricing => {
      expect(pricing).toEqual({
        inputPer1M: 0,
        outputPer1M: 0,
        isLocal: true,
        name: 'Local model',
      });
    });
  });

  it('returns local pricing for unknown tools', () => {
    const pricing = getProviderPricing('unknown-tool');
    expect(pricing).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      isLocal: true,
      name: 'Local model',
    });
  });
});
