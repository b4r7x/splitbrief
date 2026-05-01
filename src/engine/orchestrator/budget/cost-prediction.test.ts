import { describe, it, expect } from 'vitest';
import { predictCost, type PredictCostOptions } from './cost-prediction.js';

describe('predictCost', () => {
  it('returns zero costs for zero tasks', () => {
    const result = predictCost({ taskCount: 0, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.estimatedTasks).toBe(0);
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('produces correctly ordered low < expected < high for non-local implementer', () => {
    const result = predictCost({ taskCount: 10, plannerTool: 'claude-code', implementerTool: 'deepseek' });
    expect(result.lowCost).toBe(result.expectedCost);
    expect(result.expectedCost).toBe(result.highCost);
  });

  it('yields $0 predicted cost for CLI planner + local implementer', () => {
    const result = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('computes prediction with known tools (claude-code + deepseek)', () => {
    const result = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'deepseek' });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('deepseek');
    expect(result.lowCost).toBeGreaterThan(0);
    expect(result.expectedCost).toBeGreaterThan(0);
    expect(result.highCost).toBeGreaterThan(0);
  });

  it('returns zero prediction for known tools when both paths are unpriced', () => {
    const result = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('ollama');
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('uses actual planner token usage when provided', () => {
    const tokenUsage = {
      plannerInput: 10000, plannerOutput: 5000,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
    };
    const withUsage = predictCost({ taskCount: 5, plannerTool: 'anthropic', implementerTool: 'ollama', plannerModel: 'claude-sonnet-4-6', tokenUsage });
    const withoutUsage = predictCost({ taskCount: 5, plannerTool: 'anthropic', implementerTool: 'ollama', plannerModel: 'claude-sonnet-4-6' });

    expect(withUsage.lowCost).not.toBe(withoutUsage.lowCost);
  });

  it('falls back to local pricing for unknown tools', () => {
    const result = predictCost({ taskCount: 3, plannerTool: 'unknown-tool', implementerTool: 'another-unknown' });
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('includes correct tool names in result', () => {
    const opts: PredictCostOptions = { taskCount: 1, plannerTool: 'agent-sdk', implementerTool: 'deepseek' };
    const result = predictCost(opts);
    expect(result.plannerTool).toBe('agent-sdk');
    expect(result.implementerTool).toBe('deepseek');
  });

  it('clamps negative taskCount to zero', () => {
    const result = predictCost({ taskCount: -5, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.estimatedTasks).toBe(0);
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });
});
