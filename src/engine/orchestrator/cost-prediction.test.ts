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
    expect(result.lowCost).toBeLessThan(result.expectedCost);
    expect(result.expectedCost).toBeLessThan(result.highCost);
  });

  it('yields $0 implementer cost for local-only implementer', () => {
    const result = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama' });
    // With ollama (local), the only cost comes from the planner and escalation.
    // Low estimate has 0% escalation, so all implementation cost is $0.
    // lowCost = plannerCost + 0 (no escalation)
    // The difference between low and expected is purely escalation cost.
    const plannerOnlyCost = result.lowCost;
    expect(plannerOnlyCost).toBeGreaterThan(0);

    // expectedCost > lowCost because escalation uses the planner (claude-code) pricing
    expect(result.expectedCost).toBeGreaterThan(result.lowCost);
  });

  it('computes prediction with known tools (claude-code + ollama)', () => {
    const result = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('ollama');
    expect(result.lowCost).toBeGreaterThan(0);
    expect(result.expectedCost).toBeGreaterThan(0);
    expect(result.highCost).toBeGreaterThan(0);
  });

  it('uses actual planner token usage when provided', () => {
    const tokenUsage = {
      plannerInput: 10000, plannerOutput: 5000,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
    };
    const withUsage = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama', tokenUsage });
    const withoutUsage = predictCost({ taskCount: 5, plannerTool: 'claude-code', implementerTool: 'ollama' });

    // Results should differ because actual usage differs from estimated
    expect(withUsage.lowCost).not.toBe(withoutUsage.lowCost);
  });

  it('falls back to local pricing for unknown tools', () => {
    const result = predictCost({ taskCount: 3, plannerTool: 'unknown-tool', implementerTool: 'another-unknown' });
    // Unknown tools get local pricing ($0/token), so all costs are $0
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
