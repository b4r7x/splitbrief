import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import { enforceBudget } from '../budget/budget.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { getEscalatedTaskIds } from '../../../core/state/selectors.js';
import { transitionAndSave } from '../state-ops.js';
import { publishRecoveryPrompted } from '../events.js';
import { buildBudgetExceededRecoveryIssue, buildBudgetPausedRecoveryIssue } from '../recovery/builders/workflow.js';

export async function checkBudgetAfterTask(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  totalTasks: number;
  budgetWarningEmitted: boolean;
  budgetPauseEmitted: boolean;
}): Promise<{ state: WorkflowState; stop: boolean; warningEmitted: boolean; pauseEmitted: boolean }> {
  const { wctx, state, taskBreakdowns, totalTasks, budgetWarningEmitted, budgetPauseEmitted } = opts;
  const { config, projectDir, sessionId, callbacks, bus } = wctx;

  if (config.workflow.maxBudget === undefined) {
    return { state, stop: false, warningEmitted: budgetWarningEmitted, pauseEmitted: budgetPauseEmitted };
  }

  const plannerModel = state.plannerModel ?? getRunnerModelName(config.planner);
  const implementerTool = state.implementerTool ?? getRunnerDisplayName(config.implementer);
  const implementerModel = state.implementerModel ?? getRunnerModelName(config.implementer);

  const budgetResult = await enforceBudget({
    tokenUsage: state.tokenUsage,
    maxBudget: config.workflow.maxBudget,
    totalTasks,
    escalatedCount: getEscalatedTaskIds(state).length,
    plannerTool: state.plannerTool ?? getRunnerDisplayName(config.planner),
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
    return { state, stop: false, warningEmitted: budgetResult.warningEmitted, pauseEmitted: budgetResult.pauseEmitted };
  }

  const nextTask = state.tasks[state.currentTaskIndex];
  const blockedStep = nextTask ? `before ${nextTask.id}` : 'before final review';
  const issue = budgetResult.recovery.reason === 'budget-paused'
    ? buildBudgetPausedRecoveryIssue({
        currentCost: budgetResult.recovery.currentCost,
        maxBudget: budgetResult.recovery.maxBudget,
        phase: state.phase,
        threshold: budgetResult.recovery.threshold,
        blockedStep,
        nextTask,
        createdAt: new Date().toISOString(),
      })
    : buildBudgetExceededRecoveryIssue({
        currentCost: budgetResult.recovery.currentCost,
        maxBudget: budgetResult.recovery.maxBudget,
        phase: state.phase,
        blockedStep,
        nextTask,
        createdAt: new Date().toISOString(),
      });

  const newState = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(wctx.bus, issue);

  return { state: newState, stop: true, warningEmitted: budgetResult.warningEmitted, pauseEmitted: budgetResult.pauseEmitted };
}
