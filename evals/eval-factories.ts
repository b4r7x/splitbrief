import { makeUsage } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../src/core/schemas/summary.js';
import { taskId } from '../src/core/schemas/task.js';
import type { TaskTokenUsage } from '../src/core/schemas/tokens.js';
import { collectRunMetrics, type RunMetrics } from './metrics.js';

export function makeSummary(totalActualCost: number, overrides: Partial<Summary> = {}): Summary {
  return {
    feature: 'fake feature',
    totalTasks: 1,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 100,
    tokenUsage: makeUsage({
      plannerInput: 100,
      plannerOutput: 50,
      implementerInput: 80,
      implementerOutput: 40,
    }),
    estimatedCostSavings: '60%',
    escalationRate: 0,
    costBreakdown: {
      hypotheticalCost: totalActualCost * 2,
      actualPlannerCost: totalActualCost * 0.6,
      actualImplementerCost: totalActualCost * 0.4,
      totalActualCost,
      savingsAmount: totalActualCost,
      savingsPercentage: 50,
      localCompletionRate: 1,
      hasPricedUsage: totalActualCost > 0,
    },
    ...overrides,
  };
}

export function breakdownEntry(
  taskNumber: string,
  method: TaskTokenUsage['method'],
  retryCount: number,
): TaskTokenUsage {
  return {
    taskId: taskId(taskNumber),
    taskTitle: 'fake task',
    method,
    implementerTokens: 0,
    escalationTokens: 0,
    retryCount,
  };
}

export function makeRunMetrics(input: {
  mode: 'baseline' | 'routed';
  cost: number;
  sessionArtifactsDir?: string | null;
  priced?: boolean;
  summary?: Partial<Summary>;
}): RunMetrics {
  const priced = input.priced ?? true;
  return collectRunMetrics({
    scenarioId: 'fake',
    mode: input.mode,
    summary: makeSummary(input.cost, {
      ...(priced ? {} : { costBreakdown: undefined }),
      ...input.summary,
    }),
    events: [],
    qualityResults: [{ passed: true, detail: 'ok' }],
    durationMs: 100,
    sessionArtifactsDir: input.sessionArtifactsDir ?? null,
  });
}
