import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { formatCost, formatPercent } from '../../../core/formatting.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { getEscalatedTaskIds } from '../../../core/state/selectors.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  publishBudgetWarning,
  publishBudgetExceeded,
  publishBudgetPaused,
  publishWarning,
} from '../events.js';
import {
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
} from '../recovery/builders/workflow.js';
import { raisePendingRecovery } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';
import { BUDGET_PAUSE_THRESHOLD, BUDGET_WARNING_THRESHOLD, checkBudget } from './check.js';
import { getBudgetCostKnownness } from './knownness.js';

type BudgetRecoveryBoundary = {
  reason: 'budget-paused' | 'budget-exceeded';
  currentCost: number;
  maxBudget: number;
  threshold?: number | undefined;
};

export type EnforceBudgetOptions = {
  tokenUsage: TokenUsage;
  maxBudget: number;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
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
  const costKnownness = getBudgetCostKnownness(opts);
  const currentCost = costKnownness.currentKnownCost;
  if (costKnownness.hasUnknownPaidUsage && !pauseEmitted && acknowledgedAtCost === undefined) {
    publishBudgetPaused({
      bus: bus,
      phase: 'implementing',
      currentCost,
      maxBudget,
      threshold: effectivePauseThreshold,
    });
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: `Budget tracking paused: ${costKnownness.unknownReason ?? 'pricing unknown'}; configure pricing or continue acknowledging unknown spend.`,
      safety: { category: 'budget', code: 'tracking_paused', transcriptSafe: true },
    });
    return {
      stop: true,
      warningEmitted,
      pauseEmitted: true,
      recovery: {
        reason: 'budget-paused',
        currentCost,
        maxBudget,
        threshold: effectivePauseThreshold,
      },
    };
  }

  const result = checkBudget(currentCost, maxBudget, effectivePauseThreshold);

  if (
    !warningEmitted &&
    (result.action === 'warning' || result.action === 'paused' || result.action === 'exceeded') &&
    currentCost >= maxBudget * BUDGET_WARNING_THRESHOLD
  ) {
    publishBudgetWarning({ bus: bus, phase: 'implementing', currentCost, maxBudget });
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: `Budget 80% reached: ${fmtBudgetRange(currentCost, maxBudget)} limit`,
      safety: { category: 'budget', code: 'warning_threshold_reached', transcriptSafe: true },
    });
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
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: `Budget ${formatPercent(effectivePauseThreshold * 100)} reached: ${fmtBudgetRange(currentCost, maxBudget)} limit — recovery decision required`,
      safety: { category: 'budget', code: 'pause_threshold_reached', transcriptSafe: true },
    });
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
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: `Budget exceeded: ${fmtBudgetRange(currentCost, maxBudget)} limit — recovery decision required`,
      safety: { category: 'budget', code: 'budget_exceeded', transcriptSafe: true },
    });
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

export async function checkBudgetAfterTask(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  totalTasks: number;
  budgetWarningEmitted: boolean;
  budgetPauseEmitted: boolean;
}): Promise<{
  state: WorkflowState;
  stop: boolean;
  warningEmitted: boolean;
  pauseEmitted: boolean;
}> {
  const { wctx, state, taskBreakdowns, totalTasks, budgetWarningEmitted, budgetPauseEmitted } =
    opts;
  const { config, bus } = wctx;

  if (config.workflow.maxBudget === undefined) {
    return {
      state,
      stop: false,
      warningEmitted: budgetWarningEmitted,
      pauseEmitted: budgetPauseEmitted,
    };
  }

  const ident = runPricingIdentity(config);
  const plannerModel = state.plannerModel ?? ident.plannerModel;
  const implementerTool = state.implementerTool ?? ident.implementerTool;
  const implementerModel = state.implementerModel ?? ident.implementerModel;
  const reviewerTool = state.reviewerTool ?? ident.reviewerTool;
  const reviewerModel = state.reviewerModel ?? ident.reviewerModel;

  const budgetResult = await enforceBudget({
    tokenUsage: state.tokenUsage,
    maxBudget: config.workflow.maxBudget,
    totalTasks,
    escalatedCount: getEscalatedTaskIds(state).length,
    plannerTool: state.plannerTool ?? ident.plannerTool,
    implementerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    taskBreakdowns,
    pricingCache: wctx.modelCache,
    bus,
    warningEmitted: budgetWarningEmitted,
    pauseEmitted: budgetPauseEmitted,
    pauseThreshold: config.workflow.budgetPauseThreshold,
    ...(state.budgetPauseAcknowledgedAtCost !== undefined && {
      acknowledgedAtCost: state.budgetPauseAcknowledgedAtCost,
    }),
  });

  if (!budgetResult.stop || !budgetResult.recovery) {
    return {
      state,
      stop: false,
      warningEmitted: budgetResult.warningEmitted,
      pauseEmitted: budgetResult.pauseEmitted,
    };
  }

  const nextTask = state.tasks[state.currentTaskIndex];
  const blockedStep = nextTask ? `before ${nextTask.id}` : 'before final review';
  const issue =
    budgetResult.recovery.reason === 'budget-paused'
      ? buildBudgetPausedRecoveryIssue({
          currentCost: budgetResult.recovery.currentCost,
          maxBudget: budgetResult.recovery.maxBudget,
          phase: state.phase,
          threshold: budgetResult.recovery.threshold,
          blockedStep,
          nextTask,
          createdAt: nowIso(),
        })
      : buildBudgetExceededRecoveryIssue({
          currentCost: budgetResult.recovery.currentCost,
          maxBudget: budgetResult.recovery.maxBudget,
          phase: state.phase,
          blockedStep,
          nextTask,
          createdAt: nowIso(),
        });

  const newState = raisePendingRecovery(wctx, state, issue);

  return {
    state: newState,
    stop: true,
    warningEmitted: budgetResult.warningEmitted,
    pauseEmitted: budgetResult.pauseEmitted,
  };
}
