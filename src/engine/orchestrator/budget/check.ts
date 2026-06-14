import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { EventBus } from '../../events/types.js';
import { calculateCostBreakdown } from '../../providers/cost.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import {
  publishBudgetWarning,
  publishBudgetExceeded,
  publishBudgetPaused,
  publishWarning,
} from '../events.js';
import { formatCost, formatPercent } from '../../../core/formatting.js';

export type BudgetCheckResult =
  | { action: 'ok' }
  | { action: 'warning' }
  | { action: 'paused' }
  | { action: 'exceeded'; shouldStop: boolean };

type BudgetRecoveryBoundary = {
  reason: 'budget-paused' | 'budget-exceeded';
  currentCost: number;
  maxBudget: number;
  threshold?: number | undefined;
};

export type BudgetCheckOptions = {
  tokenUsage: TokenUsage;
  maxBudget: number;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  pricingCache?: ModelCacheAccessor | undefined;
};

const BUDGET_WARNING_THRESHOLD = 0.8;
export const BUDGET_PAUSE_THRESHOLD = 0.85;

export function getCurrentCost(opts: Omit<BudgetCheckOptions, 'maxBudget'>): number {
  const breakdown = calculateCostBreakdown(
    {
      tokenUsage: opts.tokenUsage,
      totalTasks: opts.totalTasks,
      escalatedCount: opts.escalatedCount,
      plannerTool: opts.plannerTool,
      implementerTool: opts.implementerTool,
      ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
      ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
      ...(opts.taskBreakdowns !== undefined && { taskBreakdowns: opts.taskBreakdowns }),
    },
    opts.pricingCache,
  );
  return breakdown.totalActualCost;
}

export function checkBudget(
  currentCost: number,
  maxBudget: number,
  pauseThreshold = BUDGET_PAUSE_THRESHOLD,
): BudgetCheckResult {
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (Number.isNaN(currentCost)) return { action: 'ok' };
  if (!Number.isFinite(currentCost)) return { action: 'exceeded', shouldStop: true };
  if (currentCost >= maxBudget) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (currentCost >= maxBudget * pauseThreshold) {
    return { action: 'paused' };
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
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  pricingCache?: ModelCacheAccessor | undefined;
  bus: EventBus;
  warningEmitted: boolean;
  pauseEmitted: boolean;
  pauseThreshold?: number | undefined;
  acknowledgedAtCost?: number | undefined;
};

function fmtBudgetRange(currentCost: number, maxBudget: number): string {
  return `${formatCost(currentCost)} of ${formatCost(maxBudget)}`;
}

export async function enforceBudget(opts: EnforceBudgetOptions): Promise<{
  stop: boolean;
  warningEmitted: boolean;
  pauseEmitted: boolean;
  recovery?: BudgetRecoveryBoundary | undefined;
}> {
  const { maxBudget, bus, pauseEmitted, acknowledgedAtCost } = opts;
  let { warningEmitted } = opts;
  const effectivePauseThreshold = opts.pauseThreshold ?? BUDGET_PAUSE_THRESHOLD;
  const currentCost = getCurrentCost(opts);
  const result = checkBudget(currentCost, maxBudget, effectivePauseThreshold);

  // If we cross past 80% directly into the pause/exceeded zone without ever emitting a warning,
  // still publish budget_warning first so listeners observe the threshold transition in order.
  if (
    !warningEmitted &&
    (result.action === 'warning' || result.action === 'paused' || result.action === 'exceeded') &&
    currentCost >= maxBudget * BUDGET_WARNING_THRESHOLD
  ) {
    publishBudgetWarning({ bus: bus, phase: 'implementing', currentCost, maxBudget });
    publishWarning(
      { bus: bus, phase: 'implementing' },
      `Budget 80% reached: ${fmtBudgetRange(currentCost, maxBudget)} limit`,
    );
    warningEmitted = true;
    if (result.action === 'warning') {
      return { stop: false, warningEmitted: true, pauseEmitted };
    }
  }

  if (result.action === 'paused' && !pauseEmitted && acknowledgedAtCost === undefined) {
    publishBudgetPaused({
      bus: bus,
      phase: 'implementing',
      currentCost,
      maxBudget,
      threshold: effectivePauseThreshold,
    });
    publishWarning(
      { bus: bus, phase: 'implementing' },
      `Budget ${formatPercent(effectivePauseThreshold * 100)} reached: ${fmtBudgetRange(currentCost, maxBudget)} limit — recovery decision required`,
    );
    return {
      stop: true,
      warningEmitted: true,
      pauseEmitted: true,
      recovery: {
        reason: 'budget-paused',
        currentCost,
        maxBudget,
        threshold: effectivePauseThreshold,
      },
    };
  }

  if (result.action === 'exceeded') {
    publishBudgetExceeded({ bus: bus, phase: 'implementing', currentCost, maxBudget });
    publishWarning(
      { bus: bus, phase: 'implementing' },
      `Budget exceeded: ${fmtBudgetRange(currentCost, maxBudget)} limit — recovery decision required`,
    );
    return {
      stop: true,
      warningEmitted: true,
      pauseEmitted,
      recovery: {
        reason: 'budget-exceeded',
        currentCost,
        maxBudget,
      },
    };
  }

  return { stop: false, warningEmitted, pauseEmitted };
}
