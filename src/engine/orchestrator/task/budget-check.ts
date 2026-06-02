import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import { enforceBudget } from '../budget/budget.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { getEscalatedTaskIds } from '../../../core/state/selectors.js';
import { transitionAndSave } from '../state-ops.js';
import { publishRecoveryPrompted } from '../events.js';
import {
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
} from '../recovery/builders/workflow.js';
import { nowIso } from '../../../utils/format-time.js';

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
  const { config, projectDir, sessionId, callbacks, bus } = wctx;

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

  const budgetResult = await enforceBudget({
    tokenUsage: state.tokenUsage,
    maxBudget: config.workflow.maxBudget,
    totalTasks,
    escalatedCount: getEscalatedTaskIds(state).length,
    plannerTool: state.plannerTool ?? ident.plannerTool,
    implementerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
    taskBreakdowns,
    pricingCache: wctx.modelCache,
    callbacks,
    bus,
    warningEmitted: budgetWarningEmitted,
    pauseEmitted: budgetPauseEmitted,
    pauseThreshold: config.workflow.budgetPauseThreshold,
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

  const newState = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'SET_PENDING_RECOVERY',
    issue,
  });
  publishRecoveryPrompted(wctx.bus, issue);

  return {
    state: newState,
    stop: true,
    warningEmitted: budgetResult.warningEmitted,
    pauseEmitted: budgetResult.pauseEmitted,
  };
}
