import { ZERO_TOKEN_USAGE, type TokenUsage } from '../../../src/core/schemas/tokens.js';
import type { Summary } from '../../../src/core/schemas/summary.js';

export function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return { ...ZERO_TOKEN_USAGE, ...overrides };
}

export function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    feature: 'test feature',
    totalTasks: 2,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10000,
    tokenUsage: makeUsage(),
    estimatedCostSavings: '~$0.00',
    escalationRate: 0,
    ...overrides,
  };
}
