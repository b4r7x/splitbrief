import { describe, expect, it } from 'vitest';
import {
  calculateTaskUsageCost,
  isTaskUsageCostKnown,
  type CalculateTaskUsageCostOptions,
} from './task-usage.js';
import { taskId } from '../../../core/schemas/task.js';
import { ZERO_TOKEN_USAGE } from '../../../core/schemas/tokens.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
// The worker endpoint's model prices input/output but carries no cache rate,
// which is the contrast several cases below depend on.
const cache = makePricedModelCache();

function taskCost(opts: CalculateTaskUsageCostOptions): number {
  return calculateTaskUsageCost({ ...opts, cache });
}

function taskCostKnown(opts: CalculateTaskUsageCostOptions): boolean {
  return isTaskUsageCostKnown({ ...opts, cache });
}

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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = taskCost({
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 200_000,
      implementerOutput: 100_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = taskCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      plannerTool: 'claude-code',
    });
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };
    const cost = taskCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = taskCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });

    expect(cost).toBeCloseTo(3.4, 6);
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = taskCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });

    // 100k input @ $2/MTok + 50k output @ $10/MTok = $0.20 + $0.50 = $0.70, with no cache dollars.
    expect(cost).toBeCloseTo(0.7, 6);
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };

    const sonnetCost = taskCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
    });
    const opusCost = taskCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-opus-5',
    });

    expect(sonnetCost).toBeCloseTo(0.7, 6);
    expect(opusCost).toBeCloseTo(1.75, 6);
  });

  it('attributes uneven exact cache fields per task: exact-0 and exact-1M against a shared 1M global', () => {
    const globalUsage = {
      ...ZERO_TOKEN_USAGE,
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
      implementerCacheCreate: 0,
    };
    // Both tasks account for half the global implementer tokens, so proportional allocation would
    // charge each 500k cache read ($0.10). Exact fields split it unevenly: one carries none, the
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
      implementerTool: 'custom-planner-api',
      plannerTool: 'claude-code',
      implementerModel: 'claude-sonnet-5',
    };
    const noCacheCost = taskCost({ ...args, task: noCacheTask });
    const fullCacheCost = taskCost({ ...args, task: fullCacheTask });

    // Base each leg: 300k input @ $2/MTok ($0.60) + 200k output @ $10/MTok ($2.00) = $2.60.
    // Exact attribution: exact-zero leg = $2.60, exact-1M leg = $2.60 + 1M @ $0.20/MTok = $2.80.
    // Proportional allocation would have charged both legs the same $2.70 (500k cache each).
    expect(noCacheCost).toBeCloseTo(2.6, 6);
    expect(fullCacheCost).toBeCloseTo(2.8, 6);
    expect(fullCacheCost - noCacheCost).toBeCloseTo(0.2, 6);
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = taskCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'claude-code',
    });
    expect(cost).toBe(0);
  });

  it('charges every task the same blended rate, so cost scales with its token share', () => {
    const globalUsage = {
      ...ZERO_TOKEN_USAGE,
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

    const heavyCost = taskCost({
      task: heavyTask,
      tokenUsage: globalUsage,
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      plannerTool: 'claude-code',
    });
    const lightCost = taskCost({
      task: lightTask,
      tokenUsage: globalUsage,
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    const args = {
      task,
      tokenUsage: globalUsage,
      implementerTool: 'custom-worker-api',
      plannerTool: 'claude-code',
      implementerModel: 'deepseek-v4-flash',
    };

    // The worker endpoint's model prices input/output but has no cache rate, so calculateTaskUsageCost silently drops
    // the allocated cache-read cost — a finite, partial number. isTaskUsageCostKnown must surface
    // that the figure is incomplete by pricing the SAME allocated cache tokens.
    expect(taskCost(args)).toBeGreaterThan(0);
    expect(taskCostKnown(args)).toBe(false);
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    expect(
      taskCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'custom-worker-api',
        plannerTool: 'claude-code',
        implementerModel: 'deepseek-v4-flash',
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      taskCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'custom-worker-api',
        plannerModel: 'deepseek-v4-flash',
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
      ...ZERO_TOKEN_USAGE,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      taskCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'custom-planner-api',
        plannerModel: 'claude-sonnet-5',
      }),
    ).toBe(true);
  });
});

describe('reviewer cache fold', () => {
  const escalatedTask = {
    taskId: taskId('T001'),
    taskTitle: 'escalated',
    method: 'escalated-full' as const,
    implementerTokens: 0,
    escalationTokens: 100_000,
    retryCount: 0,
  };
  const args = {
    task: escalatedTask,
    implementerTool: 'ollama',
    plannerTool: 'custom-planner-api',
    plannerModel: 'claude-sonnet-5',
  };
  const baseUsage = {
    ...ZERO_TOKEN_USAGE,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 60_000,
    escalationOutput: 40_000,
  };

  it('allocates escalation cache from the same pool as before the reviewer bucket existed', () => {
    const withReviewerBucket = taskCost({
      ...args,
      tokenUsage: {
        ...baseUsage,
        plannerCacheRead: 200_000,
        plannerCacheCreate: 50_000,
        reviewerCacheRead: 300_000,
        reviewerCacheCreate: 25_000,
      },
    });
    const preChange = taskCost({
      ...args,
      tokenUsage: {
        ...baseUsage,
        plannerCacheRead: 500_000,
        plannerCacheCreate: 75_000,
      },
    });

    expect(withReviewerBucket).toBe(preChange);
  });

  it('keeps a configured reviewer cache out of the escalation allocation', () => {
    const configuredReviewer = taskCost({
      ...args,
      tokenUsage: {
        ...baseUsage,
        plannerCacheRead: 200_000,
        plannerCacheCreate: 50_000,
        reviewerCacheRead: 300_000,
        reviewerCacheCreate: 25_000,
      },
      reviewerTool: 'custom-worker-api',
    });
    const plannerCacheOnly = taskCost({
      ...args,
      tokenUsage: { ...baseUsage, plannerCacheRead: 200_000, plannerCacheCreate: 50_000 },
    });

    expect(configuredReviewer).toBe(plannerCacheOnly);
  });
});
