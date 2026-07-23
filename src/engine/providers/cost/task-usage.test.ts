import { describe, expect, it } from 'vitest';
import { calculateTaskUsageCost, isTaskUsageCostKnown } from './task-usage.js';
import { taskId } from '../../../core/schemas/task.js';

describe('calculateTaskUsageCost', () => {
  it('returns 0 for local implementer with no escalation', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 1000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'claude-code',
    });
    expect(cost).toBe(0);
  });

  it('calculates cost using blended rate from global token ratio', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 300_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 200_000,
      implementerOutput: 100_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo((0.14 * 200_000) / 1_000_000 + (0.28 * 100_000) / 1_000_000, 6);
  });

  it('includes escalation cost when escalation tokens present', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 1000,
      escalationTokens: 150_000,
      retryCount: 2,
    };
    const globalUsage = {
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('includes escalation planner cache read/create in per-task cost', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 1_000_000,
      escalationCacheCreateTokens: 1_000_000,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = calculateTaskUsageCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });

    expect(cost).toBeCloseTo(5.1, 6);
  });

  it('does not allocate planner-phase cache to an escalated task with explicit-zero cache fields', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 0,
      escalationCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = calculateTaskUsageCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });

    // 100k input @ $3/MTok + 50k output @ $15/MTok = $0.30 + $0.75 = $1.05, with no cache dollars.
    expect(cost).toBeCloseTo(1.05, 6);
  });

  it('uses planner model pricing for per-task escalation attribution', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      retryCount: 1,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };

    const sonnetCost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });
    const opusCost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-opus-4-6',
    });

    expect(sonnetCost).toBeCloseTo(1.05, 6);
    expect(opusCost).toBeCloseTo(1.75, 6);
  });

  it('attributes uneven exact cache fields per task: exact-0 and exact-1M against a shared 1M global', () => {
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
      implementerCacheCreate: 0,
    };
    // Both tasks account for half the global implementer tokens, so proportional allocation would
    // charge each 500k cache read ($0.15). Exact fields split it unevenly: one carries none, the
    // other carries the full 1M.
    const noCacheTask = {
      taskId: taskId('T001'),
      taskTitle: 'exact-zero-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };
    const fullCacheTask = {
      taskId: taskId('T002'),
      taskTitle: 'exact-full-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };

    const args = {
      tokenUsage: globalUsage,
      implementerTool: 'anthropic',
      plannerTool: 'claude-code',
      implementerModel: 'claude-sonnet-4-6',
    };
    const noCacheCost = calculateTaskUsageCost({ ...args, task: noCacheTask });
    const fullCacheCost = calculateTaskUsageCost({ ...args, task: fullCacheTask });

    // Base each leg: 300k input @ $3/MTok ($0.90) + 200k output @ $15/MTok ($3.00) = $3.90.
    // Exact attribution: exact-zero leg = $3.90, exact-1M leg = $3.90 + 1M @ $0.30/MTok = $4.20.
    // Proportional allocation would have charged both legs the same $4.05 (500k cache each).
    expect(noCacheCost).toBeCloseTo(3.9, 6);
    expect(fullCacheCost).toBeCloseTo(4.2, 6);
    expect(fullCacheCost - noCacheCost).toBeCloseTo(0.3, 6);
  });

  it('returns cost 0 when all global token totals are zero', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 0,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'claude-code',
    });
    expect(cost).toBe(0);
  });

  it('allocates cost uniformly across tasks regardless of individual token usage', () => {
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const heavyTask = {
      taskId: taskId('T001'),
      taskTitle: 'heavy',
      method: 'local' as const,
      implementerTokens: 800_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const lightTask = {
      taskId: taskId('T002'),
      taskTitle: 'light',
      method: 'local' as const,
      implementerTokens: 200_000,
      escalationTokens: 0,
      retryCount: 0,
    };

    const heavyCost = calculateTaskUsageCost({
      task: heavyTask,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });
    const lightCost = calculateTaskUsageCost({
      task: lightTask,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });

    // Per-task cost uses blended rate × task tokens — tasks with more tokens cost proportionally more
    expect(heavyCost / lightCost).toBeCloseTo(800_000 / 200_000, 5);
    // Both use the same blended cost-per-token derived from global input/output ratio
    expect(heavyCost / 800_000).toBeCloseTo(lightCost / 200_000, 10);
  });
});

describe('isTaskUsageCostKnown — cache alignment with calculateTaskUsageCost', () => {
  it('reports unknown when a legacy implementer record allocates cache tokens a priced-but-cache-unpriced tool cannot price', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'legacy-no-cache-fields',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    const args = {
      task,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
      implementerModel: 'deepseek-chat',
    };

    // deepseek prices input/output but has no cache rate, so calculateTaskUsageCost silently drops
    // the allocated cache-read cost — a finite, partial number. isTaskUsageCostKnown must surface
    // that the figure is incomplete by pricing the SAME allocated cache tokens.
    expect(calculateTaskUsageCost(args)).toBeGreaterThan(0);
    expect(isTaskUsageCostKnown(args)).toBe(false);
  });

  it('reports known when an implementer record carries explicit-zero cache fields (no cache to price)', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'explicit-zero-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'deepseek',
        plannerTool: 'claude-code',
        implementerModel: 'deepseek-chat',
      }),
    ).toBe(true);
  });

  it('reports unknown when a legacy escalated record allocates planner cache a cache-unpriced planner cannot price', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'legacy-escalation',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'deepseek',
        plannerModel: 'deepseek-chat',
      }),
    ).toBe(false);
  });

  it('reports known when both legs are fully priced including cache rates', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'fully-priced',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 1_000_000,
      escalationCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-6',
      }),
    ).toBe(true);
  });
});
