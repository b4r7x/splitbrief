import type { Summary } from '../../../src/core/schemas/summary.js';

export function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    feature: 'test feature',
    totalTasks: 2,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10000,
    escalationRate: 0,
    ...overrides,
  };
}
