import type { TokenUsage, OrchestratorCallbacks } from '../../types.js';
import { calculateCostBreakdown } from '../providers/pricing.js';
import { emitBudgetWarning, emitBudgetExceeded, emitWarning } from './events.js';
import { formatCost } from '../../utils/format.js';

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
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
};

const BUDGET_WARNING_THRESHOLD = 0.8;

export function getCurrentCost(opts: Omit<BudgetCheckOptions, 'maxBudget'>): number {
  const breakdown = calculateCostBreakdown({
    tokenUsage: opts.tokenUsage,
    totalTasks: opts.totalTasks,
    escalatedCount: opts.escalatedCount,
    plannerTool: opts.plannerTool,
    implementerTool: opts.implementerTool,
    plannerModel: opts.plannerModel,
    implementerModel: opts.implementerModel,
  });
  return breakdown.totalActualCost;
}

export function checkBudget(currentCost: number, maxBudget: number): BudgetCheckResult {
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (!Number.isFinite(currentCost)) {
    return Number.isNaN(currentCost) ? { action: 'ok' } : { action: 'exceeded', shouldStop: true };
  }
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
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  callbacks: OrchestratorCallbacks;
  warningEmitted: boolean;
};

export async function enforceBudget(opts: EnforceBudgetOptions): Promise<{ stop: boolean; warningEmitted: boolean }> {
  const { maxBudget, callbacks, warningEmitted } = opts;
  const currentCost = getCurrentCost(opts);
  const result = checkBudget(currentCost, maxBudget);

  if (result.action === 'warning' && !warningEmitted) {
    emitBudgetWarning(callbacks, currentCost, maxBudget);
    emitWarning(callbacks, `Budget 80% reached: ${formatCost(currentCost)} of ${formatCost(maxBudget)} limit`);
    return { stop: false, warningEmitted: true };
  }

  if (result.action === 'exceeded') {
    emitBudgetExceeded(callbacks, currentCost, maxBudget);

    if (callbacks.onBudgetExceeded) {
      const shouldContinue = await callbacks.onBudgetExceeded(currentCost, maxBudget);
      return { stop: !shouldContinue, warningEmitted: true };
    }

    emitWarning(callbacks, `Budget exceeded: ${formatCost(currentCost)} of ${formatCost(maxBudget)} limit — stopping workflow`);
    return { stop: true, warningEmitted: true };
  }

  return { stop: false, warningEmitted };
}
