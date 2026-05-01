import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { UserEditConflict } from '../../user-edit/conflicts.js';
import { uniqueIds } from '../../../../utils/collections.js';
import type { RecoveryBuilderBase } from './shared.js';
import {
  budgetPercentOf,
  chooseRecommended,
  chooseUserEditRecommendation,
  compactFacts,
  createRecoveryIssue,
  fileConflictDetails,
  formatCostFact,
  formatPercent,
  mapUserEditAction,
  orderedActions,
  taskFiles,
} from './shared.js';

export interface UserEditConflictRecoveryOptions extends RecoveryBuilderBase {
  conflict: UserEditConflict;
  currentTask?: Task | undefined;
  phase?: Phase | undefined;
}

export interface ApprovalPromotionConflictRecoveryOptions extends RecoveryBuilderBase {
  conflict: UserEditConflict;
  currentTask?: Task | undefined;
  phase?: Phase | undefined;
}

export interface BudgetRecoveryOptions extends RecoveryBuilderBase {
  currentCost: number;
  maxBudget: number;
  phase?: Phase | undefined;
  threshold?: number | undefined;
  projectedCost?: number | undefined;
  blockedStep?: string | undefined;
  nextTask?: Task | undefined;
  allowSkipNextTask?: boolean | undefined;
}

export function buildUserEditConflictRecoveryIssue(opts: UserEditConflictRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const hasCurrentTask = opts.currentTask !== undefined || opts.conflict.currentTaskId !== undefined;
  const actions = orderedActions(
    opts.conflict.availableActions
      .map(mapUserEditAction)
      .filter(action =>
        (hasCurrentTask || action !== 'skip-current-task')
        && (opts.conflict.safeToContinue || action !== 'continue')
      ),
  );
  const recommendedAction = chooseUserEditRecommendation(opts.conflict, actions);
  const affectedTaskIds = uniqueIds([
    ...opts.conflict.affectedTaskIds,
    ...(opts.conflict.currentTaskId ? [opts.conflict.currentTaskId] : []),
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'user-edit-conflict',
    phase,
    task: opts.currentTask,
    files: opts.conflict.files,
    affectedTaskIds,
    message: userEditMessage(opts.conflict, opts.currentTask),
    details: [
      `Conflict kind: ${opts.conflict.kind}`,
      `Safe to continue: ${opts.conflict.safeToContinue ? 'yes' : 'no'}`,
      ...fileConflictDetails(opts.conflict),
    ],
    facts: compactFacts({
      conflictKind: opts.conflict.kind,
      safeToContinue: opts.conflict.safeToContinue,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildApprovalPromotionConflictRecoveryIssue(opts: ApprovalPromotionConflictRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const hasCurrentTask = opts.currentTask !== undefined || opts.conflict.currentTaskId !== undefined;
  const actions = orderedActions(
    opts.conflict.availableActions
      .map(mapUserEditAction)
      .filter(action => action !== 'continue' && (hasCurrentTask || action !== 'skip-current-task')),
  );
  const affectedTaskIds = uniqueIds([
    ...opts.conflict.affectedTaskIds,
    ...(opts.conflict.currentTaskId ? [opts.conflict.currentTaskId] : []),
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'approval-promotion-conflict',
    phase,
    task: opts.currentTask,
    files: opts.conflict.files,
    affectedTaskIds,
    message: approvalPromotionMessage(opts.conflict, opts.currentTask),
    details: [
      'Approved output cannot be promoted because files changed during approval.',
      ...fileConflictDetails(opts.conflict),
    ],
    facts: compactFacts({
      conflictKind: opts.conflict.kind,
      safeToContinue: false,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['planner-split-rebase', 'pause-run']),
    createdAt: opts.createdAt,
  });
}

export function buildBudgetPausedRecoveryIssue(opts: BudgetRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const belowMaxBudget = opts.currentCost < opts.maxBudget;
  const actions = orderedActions([
    belowMaxBudget ? 'continue' : undefined,
    opts.allowSkipNextTask && opts.nextTask ? 'skip-current-task' : undefined,
    'pause-run',
    'abort-workflow',
  ]);
  const budgetPercent = budgetPercentOf(opts.currentCost, opts.maxBudget);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'budget-paused',
    phase,
    task: opts.nextTask,
    files: opts.nextTask ? taskFiles(opts.nextTask) : [],
    affectedTaskIds: opts.nextTask ? [opts.nextTask.id] : [],
    message: `Budget pause at ${formatPercent(budgetPercent)}`,
    details: [
      `Spent ${formatCostFact(opts.currentCost)} of ${formatCostFact(opts.maxBudget)}`,
      ...(opts.projectedCost !== undefined ? [`Projected cost: ${formatCostFact(opts.projectedCost)}`] : []),
      ...(opts.blockedStep !== undefined ? [`Blocked step: ${opts.blockedStep}`] : []),
      ...(opts.threshold !== undefined ? [`Pause threshold: ${formatPercent(opts.threshold * 100)}`] : []),
    ],
    facts: compactFacts({
      currentCost: opts.currentCost,
      maxBudget: opts.maxBudget,
      budgetPercent,
      projectedCost: opts.projectedCost,
      threshold: opts.threshold,
      blockedStep: opts.blockedStep,
      belowMaxBudget,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['pause-run', 'continue']),
    createdAt: opts.createdAt,
  });
}

export function buildBudgetExceededRecoveryIssue(opts: BudgetRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const budgetPercent = budgetPercentOf(opts.currentCost, opts.maxBudget);
  const actions = orderedActions(['pause-run', 'abort-workflow']);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'budget-exceeded',
    phase,
    task: opts.nextTask,
    files: opts.nextTask ? taskFiles(opts.nextTask) : [],
    affectedTaskIds: opts.nextTask ? [opts.nextTask.id] : [],
    message: `Budget exceeded at ${formatPercent(budgetPercent)}`,
    details: [
      `Spent ${formatCostFact(opts.currentCost)} of ${formatCostFact(opts.maxBudget)}`,
      ...(opts.projectedCost !== undefined ? [`Projected cost: ${formatCostFact(opts.projectedCost)}`] : []),
      ...(opts.blockedStep !== undefined ? [`Blocked step: ${opts.blockedStep}`] : []),
      'Continuing requires a separate raise-budget flow.',
    ],
    facts: compactFacts({
      currentCost: opts.currentCost,
      maxBudget: opts.maxBudget,
      budgetPercent,
      projectedCost: opts.projectedCost,
      blockedStep: opts.blockedStep,
    }),
    availableActions: actions,
    recommendedAction: 'pause-run',
    createdAt: opts.createdAt,
  });
}

function userEditMessage(conflict: UserEditConflict, currentTask: Task | undefined): string {
  if (currentTask) return `User edits conflict with ${currentTask.id}`;
  if (conflict.currentTaskId) return `User edits conflict with ${conflict.currentTaskId}`;
  return 'User edits require a recovery decision';
}

function approvalPromotionMessage(conflict: UserEditConflict, currentTask: Task | undefined): string {
  if (currentTask) return `Approval promotion blocked for ${currentTask.id}`;
  if (conflict.currentTaskId) return `Approval promotion blocked for ${conflict.currentTaskId}`;
  return 'Approval promotion blocked by changed files';
}
