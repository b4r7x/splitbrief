import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { OrchestratorCallbacks } from './types.js';
import type { EventBus } from '../events/types.js';
import { calculateCostBreakdown } from '../providers/pricing.js';
import { publishBudgetWarning, publishBudgetExceeded, publishWarning } from './events.js';
import { formatCost } from '../../core/formatting.js';

export type BudgetCheckResult =
  | { action: 'ok' }
  | { action: 'warning' }
  | { action: 'exceeded'; shouldStop: boolean };

export type BudgetCheckOptions = {
  tokenUsage: TokenUsage;
  maxBudget: number;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
};

const BUDGET_WARNING_THRESHOLD = 0.8;

export function getCurrentCost(opts: Omit<BudgetCheckOptions, 'maxBudget'>): number {
  const breakdown = calculateCostBreakdown({
    tokenUsage: opts.tokenUsage,
    totalTasks: opts.totalTasks,
    escalatedCount: opts.escalatedCount,
    plannerTool: opts.plannerTool,
    implementerTool: opts.implementerTool,
  });
  return breakdown.totalActualCost;
}

export function checkBudget(currentCost: number, maxBudget: number): BudgetCheckResult {
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (Number.isNaN(currentCost)) return { action: 'ok' };
  if (!Number.isFinite(currentCost)) return { action: 'exceeded', shouldStop: true };
  if (currentCost >= maxBudget) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (currentCost >= maxBudget * BUDGET_WARNING_THRESHOLD) {
    return { action: 'warning' };
  }
  return { action: 'ok' };
}

export type EnforceBudgetOptions = {
  tokenUsage: TokenUsage;
  maxBudget: number;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  warningEmitted: boolean;
};

function fmtBudgetRange(currentCost: number, maxBudget: number): string {
  return `${formatCost(currentCost)} of ${formatCost(maxBudget)}`;
}

export async function enforceBudget(opts: EnforceBudgetOptions): Promise<{ stop: boolean; warningEmitted: boolean }> {
  const { maxBudget, callbacks, bus, warningEmitted } = opts;
  const currentCost = getCurrentCost(opts);
  const result = checkBudget(currentCost, maxBudget);

  if (result.action === 'warning' && !warningEmitted) {
    publishBudgetWarning(bus, 'implementing', currentCost, maxBudget);
    publishWarning(bus, 'implementing', `Budget 80% reached: ${fmtBudgetRange(currentCost, maxBudget)} limit`);
    return { stop: false, warningEmitted: true };
  }

  if (result.action === 'exceeded') {
    publishBudgetExceeded(bus, 'implementing', currentCost, maxBudget);

    if (callbacks.onBudgetExceeded) {
      const shouldContinue = await callbacks.onBudgetExceeded(currentCost, maxBudget);
      return { stop: !shouldContinue, warningEmitted: true };
    }

    publishWarning(bus, 'implementing', `Budget exceeded: ${fmtBudgetRange(currentCost, maxBudget)} limit — stopping workflow`);
    return { stop: true, warningEmitted: true };
  }

  return { stop: false, warningEmitted };
}
