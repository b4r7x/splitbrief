import type { Summary } from '../src/core/schemas/summary.js';
import { taskId } from '../src/core/schemas/task.js';
import type { BriefExecution } from '../src/core/schemas/brief-execution.js';
import { collectRunMetrics, type RunMetrics } from './metrics.js';

export function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    feature: 'fake feature',
    totalTasks: 1,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 100,
    escalationRate: 0,
    ...overrides,
  };
}

export function breakdownEntry(
  taskNumber: string,
  method: BriefExecution['method'],
  retryCount: number,
): BriefExecution {
  return {
    taskId: taskId(taskNumber),
    taskTitle: 'fake task',
    method,
    retryCount,
  };
}

export function makeRunMetrics(input: {
  mode: 'baseline' | 'routed';
  sessionArtifactsDir?: string | null;
  summary?: Partial<Summary>;
}): RunMetrics {
  return collectRunMetrics({
    scenarioId: 'fake',
    mode: input.mode,
    summary: makeSummary(input.summary),
    events: [],
    qualityResults: [{ passed: true, detail: 'ok' }],
    durationMs: 100,
    sessionArtifactsDir: input.sessionArtifactsDir ?? null,
  });
}
