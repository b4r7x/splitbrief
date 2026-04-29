import type { Phase, RecoveryAction, RecoveryReason } from '../../core/schemas/enums.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../core/schemas/recovery.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { ValidationResult } from '../../core/types/summary.js';
import type { EventBus } from '../events/types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { hashTaskBrief } from '../../core/brief-hash.js';
import type { RoutingDecision } from './context-routing.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import {
  publishRecoveryActionFailed,
  publishRecoveryActionSelected,
  publishRecoveryResolved,
  publishTaskSkipped,
} from './events.js';
import { transitionAndSave } from './state-ops.js';
import type { UserEditConflict, UserEditConflictAction } from './user-edit-conflicts.js';

const ACTION_ORDER: RecoveryAction[] = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
];

const MAX_SUMMARY_LENGTH = 320;

export interface RecoveryBuilderBase {
  createdAt: string;
  id?: string | undefined;
}

export interface TaskRecoveryContext {
  task: Task;
  phase?: Phase | undefined;
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}

export interface ImplementationErrorRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  error: unknown;
}

export interface ValidationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}

export interface RetryExhaustedRecoveryOptions extends ValidationRecoveryOptions {
  allowRetryOverride?: boolean | undefined;
}

export interface ContextOverflowRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  routingDecision?: RoutingDecision | undefined;
  phase?: Phase | undefined;
  selectedImplementerProfile?: string | undefined;
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}

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

export interface DependencyBlockedRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  blockedByTasks?: Task[] | undefined;
  blockedByTaskIds?: TaskId[] | undefined;
  phase?: Phase | undefined;
}

export function buildImplementationErrorRecoveryIssue(opts: ImplementationErrorRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const errorSummary = summarizeUnknownError(opts.error);
  const canRetry = hasRetryBudget(opts.attempts, opts.maxAttempts);
  const actions = orderedActions([
    canRetry ? 'retry-same-worker' : undefined,
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'retry-same-worker',
    'route-bigger-worker',
    'pause-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'implementation-error',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} implementation failed`,
    details: [
      `Error: ${errorSummary}`,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      errorSummary,
      canRetry,
      canRouteBigger: hasRouteBigger(opts),
      routeBiggerProfile: opts.routeBiggerProfile,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildValidationFailedRecoveryIssue(opts: ValidationRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'validating-task';
  const validation = summarizeValidation(opts);
  const canRetry = hasRetryBudget(opts.attempts, opts.maxAttempts);
  const actions = orderedActions([
    canRetry ? 'retry-same-worker' : undefined,
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    'planner-split-rebase',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'retry-same-worker',
    'route-bigger-worker',
    'planner-split-rebase',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'validation-failed',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} validation failed`,
    details: [
      validation.detail,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationStage: validation.stage,
      validationSummary: validation.summary,
      canRetry,
      canRouteBigger: hasRouteBigger(opts),
      routeBiggerProfile: opts.routeBiggerProfile,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildRetryExhaustedRecoveryIssue(opts: RetryExhaustedRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'escalating';
  const validation = summarizeValidation(opts);
  const actions = orderedActions([
    opts.allowRetryOverride ? 'retry-same-worker' : undefined,
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    'planner-split-rebase',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'planner-split-rebase',
    'skip-current-task',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'retry-exhausted',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} exhausted recovery retries`,
    details: [
      validation.detail,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationStage: validation.stage,
      validationSummary: validation.summary,
      allowRetryOverride: opts.allowRetryOverride,
      canRouteBigger: hasRouteBigger(opts),
      routeBiggerProfile: opts.routeBiggerProfile,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildContextOverflowRecoveryIssue(opts: ContextOverflowRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const routing = opts.routingDecision;
  const estimatedTokens = opts.estimatedTokens ?? routing?.estimatedTokens;
  const untruncatedEstimatedTokens = opts.untruncatedEstimatedTokens ?? routing?.untruncatedEstimatedTokens;
  const contextLength = opts.contextLength ?? routing?.contextLength;
  const routingReason = opts.routingReason ?? routing?.reason;
  const selectedImplementerProfile = opts.selectedImplementerProfile ?? routing?.selectedProfile;
  const routeBiggerProfile = opts.routeBiggerProfile;
  const canRouteBigger = hasRouteBigger({ routeBiggerProfile, canRouteBigger: opts.canRouteBigger });
  const actions = orderedActions([
    canRouteBigger ? 'route-bigger-worker' : undefined,
    'planner-split-rebase',
    'pause-run',
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'planner-split-rebase',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'context-overflow',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} does not fit a capable implementer context`,
    details: [
      ...contextDetails({ estimatedTokens, untruncatedEstimatedTokens, contextLength, routingReason }),
      ...rejectedProfileDetails(routing),
      ...routeBiggerDetails({ routeBiggerProfile, canRouteBigger }),
    ],
    selectedImplementerProfile,
    facts: compactFacts({
      estimatedTokens,
      untruncatedEstimatedTokens,
      contextLength,
      currentCodeTruncated: routing?.currentCodeTruncated,
      currentCodeContextMode: routing?.currentCodeContextMode,
      requiredWriteMode: routing?.requiredWriteMode,
      routingReason,
      routeBiggerProfile,
      canRouteBigger,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
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
  const affectedTaskIds = uniqueTaskIds([
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
  const affectedTaskIds = uniqueTaskIds([
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

export function buildDependencyBlockedRecoveryIssue(opts: DependencyBlockedRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const blockedByTaskIds = uniqueTaskIds([
    ...(opts.blockedByTaskIds ?? []),
    ...(opts.blockedByTasks ?? []).map(task => task.id),
  ]);
  const affectedTaskIds = uniqueTaskIds([opts.task.id, ...blockedByTaskIds]);
  const blockedFiles = (opts.blockedByTasks ?? []).map(task => task.file);
  const actions = orderedActions([
    'planner-split-rebase',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'dependency-blocked',
    phase,
    task: opts.task,
    files: uniqueFiles([opts.task.file, ...blockedFiles]),
    affectedTaskIds,
    message: `${opts.task.id} is blocked by dependency status`,
    details: [
      dependencyDetail(blockedByTaskIds, opts.blockedByTasks ?? []),
    ],
    facts: compactFacts({
      blockedByTaskIds: blockedByTaskIds.join(', '),
    }),
    availableActions: actions,
    recommendedAction: 'planner-split-rebase',
    createdAt: opts.createdAt,
  });
}

export type RecoveryActionBlockedCode =
  | 'no-pending-recovery'
  | 'action-not-available'
  | 'unsafe-continue'
  | 'missing-current-task'
  | 'route-bigger-not-ready'
  | 'planner-proposal-required';

export type RecoveryActionAppliedStatus =
  | 'continued'
  | 'paused'
  | 'aborted'
  | 'skipped-current-task'
  | 'retry-current-task';

export type ApplyRecoveryActionResult =
  | {
    ok: true;
    action: RecoveryAction;
    issue: RecoveryIssue;
    state: WorkflowState;
    status: RecoveryActionAppliedStatus;
    implementerProfile?: string | undefined;
  }
  | {
    ok: false;
    action: RecoveryAction;
    state: WorkflowState;
    status: 'blocked';
    code: RecoveryActionBlockedCode;
    message: string;
    issue?: RecoveryIssue | undefined;
    implementerProfile?: string | undefined;
  };

export interface ApplyRecoveryActionOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  selectedAt?: string | undefined;
  mode?: WorkflowMode | undefined;
}

export function applyRecoveryAction(opts: ApplyRecoveryActionOptions): ApplyRecoveryActionResult {
  const issue = opts.state.pendingRecovery;
  if (!issue) {
    return {
      ok: false,
      action: opts.action,
      state: opts.state,
      status: 'blocked',
      code: 'no-pending-recovery',
      message: 'No pending recovery issue is available.',
    };
  }

  if (!issue.availableActions.includes(opts.action)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'action-not-available',
      message: `Recovery action "${opts.action}" is not available for ${issue.reason}.`,
    });
  }

  if (opts.action === 'continue') {
    return applyContinueRecoveryAction(opts, issue);
  }
  if (opts.action === 'pause-run') {
    return applyPauseRecoveryAction(opts, issue);
  }
  if (opts.action === 'abort-workflow') {
    return applyAbortRecoveryAction(opts, issue);
  }
  if (opts.action === 'skip-current-task') {
    return applySkipCurrentTaskRecoveryAction(opts, issue);
  }
  if (opts.action === 'retry-same-worker') {
    return applyRetrySameWorkerRecoveryAction(opts, issue);
  }
  if (opts.action === 'route-bigger-worker') {
    const profile = issueFactString(issue, 'routeBiggerProfile');
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'route-bigger-not-ready',
      message: profile
        ? `Routing to ${profile} requires one-shot profile override plumbing before execution can resume.`
        : 'Routing to a bigger worker requires a selected larger profile before execution can resume.',
      implementerProfile: profile,
      publishSelected: true,
    });
  }

  const profile = issue.selectedImplementerProfile;
  return blockRecoveryAction({
    ...opts,
    issue,
    code: 'planner-proposal-required',
    message: 'Planner split/rebase requires a parseable proposed Task Brief and explicit approve/edit/reject before execution can resume.',
    implementerProfile: profile,
    publishSelected: true,
  });
}

export function buildRecoveryIssueId(opts: {
  reason: RecoveryReason;
  phase: Phase;
  taskId?: TaskId | undefined;
  createdAt: string;
}): string {
  const stamp = opts.createdAt.replace(/\D/g, '').slice(0, 14) || 'unknown';
  const reason = opts.reason.replaceAll('-', '_');
  const phase = opts.phase.replaceAll('-', '_');
  const task = opts.taskId ? `_${opts.taskId}` : '';
  return `rec_${stamp}_${reason}_${phase}${task}`;
}

type ApplyRecoveryActionOptionsWithIssue = ApplyRecoveryActionOptions & {
  issue: RecoveryIssue;
};

function applyContinueRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (!isSafeContinue(issue)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'unsafe-continue',
      message: `Recovery issue ${issue.reason} cannot be continued safely.`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'continued');

  return { ok: true, action: opts.action, issue, state, status: 'continued' };
}

function applyPauseRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, { type: 'PAUSE_PENDING_RECOVERY' });
  return { ok: true, action: opts.action, issue, state, status: 'paused' };
}

function applyAbortRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, { type: 'CANCEL' });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'aborted');
  return { ok: true, action: opts.action, issue, state, status: 'aborted' };
}

function applySkipCurrentTaskRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: 'Skip current task requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

  const reason = `recovery ${issue.reason}: ${issue.message}`;
  try {
    recordRecoverySkipEvidence({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      state: opts.state,
      task: target.task,
      mode: opts.mode,
      reason,
    });
  } catch (err) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: `Failed to record skip evidence: ${err instanceof Error ? err.message : String(err)}`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'SKIP_TASK',
    taskId: target.task.id,
  });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishTaskSkipped(opts.bus, issue.phase, {
    taskId: target.task.id,
    title: target.task.title,
    reason,
  });
  publishRecoveryResolved(opts.bus, issue, opts.action, 'skipped-current-task');

  return { ok: true, action: opts.action, issue, state, status: 'skipped-current-task' };
}

function applyRetrySameWorkerRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  const target = currentRecoveryTask(opts.state, issue);
  if (!target) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'missing-current-task',
      message: 'Retry same worker requires the pending recovery task to match the current task index.',
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESET_TASK',
    taskId: target.task.id,
  });
  state = transitionAndSave(opts.projectDir, opts.sessionId, state, {
    type: 'RESOLVE_PENDING_RECOVERY',
    action: opts.action,
  });
  publishRecoveryResolved(
    opts.bus,
    issue,
    opts.action,
    'retry-current-task',
    issue.selectedImplementerProfile,
  );

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'retry-current-task',
    implementerProfile: issue.selectedImplementerProfile,
  };
}

function markRecoveryApplying(opts: ApplyRecoveryActionOptions, issue: RecoveryIssue): WorkflowState {
  publishRecoveryActionSelected(opts.bus, issue, opts.action);
  return transitionAndSave(opts.projectDir, opts.sessionId, opts.state, {
    type: 'MARK_RECOVERY_APPLYING',
    action: opts.action,
    selectedAt: opts.selectedAt ?? new Date().toISOString(),
  });
}

function blockRecoveryAction(
  opts: ApplyRecoveryActionOptionsWithIssue & {
    code: RecoveryActionBlockedCode;
    message: string;
    implementerProfile?: string | undefined;
    publishSelected?: boolean | undefined;
  },
): ApplyRecoveryActionResult {
  if (opts.publishSelected) {
    publishRecoveryActionSelected(opts.bus, opts.issue, opts.action);
  }
  publishRecoveryActionFailed(opts.bus, opts.issue, opts.action, opts.message);
  return {
    ok: false,
    action: opts.action,
    state: opts.state,
    status: 'blocked',
    code: opts.code,
    message: opts.message,
    issue: opts.issue,
    implementerProfile: opts.implementerProfile,
  };
}

function currentRecoveryTask(
  state: WorkflowState,
  issue: RecoveryIssue,
): { task: Task; index: number } | undefined {
  const current = state.tasks[state.currentTaskIndex];
  const targetId = issue.taskId ?? current?.id;
  if (targetId === undefined) return undefined;
  const index = state.tasks.findIndex(task => task.id === targetId);
  if (index < 0 || index !== state.currentTaskIndex) return undefined;
  const task = state.tasks[index];
  if (!task || task.status === 'done' || task.status === 'escalated') return undefined;
  return { task, index };
}

function recordRecoverySkipEvidence(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  task: Task;
  mode?: WorkflowMode | undefined;
  reason: string;
}): void {
  const existing = readEvidenceLedger(opts.projectDir, opts.sessionId);
  const briefHash = hashTaskBrief(opts.state.tasks);
  const ledger = existing ?? createEvidenceLedger({
    sessionId: opts.sessionId,
    feature: opts.state.feature,
    mode: opts.mode ?? DEFAULT_WORKFLOW_MODE,
    tasks: opts.state.tasks,
    briefHash,
  });
  const updated = recordSkippedTaskEvidence({
    ledger,
    task: opts.task,
    reason: opts.reason,
    briefHash,
  });
  writeEvidenceLedger(opts.projectDir, opts.sessionId, updated);
}

function isSafeContinue(issue: RecoveryIssue): boolean {
  if (issue.reason === 'budget-exceeded') return false;
  if (issue.reason === 'budget-paused') {
    const belowMaxBudget = issueFactBoolean(issue, 'belowMaxBudget');
    if (belowMaxBudget === true) return true;

    const currentCost = issueFactNumber(issue, 'currentCost');
    const maxBudget = issueFactNumber(issue, 'maxBudget');
    return currentCost !== undefined && maxBudget !== undefined && currentCost < maxBudget;
  }
  if (issue.reason === 'user-edit-conflict') {
    return issueFactBoolean(issue, 'safeToContinue') === true;
  }
  return false;
}

function issueFactBoolean(issue: RecoveryIssue, key: string): boolean | undefined {
  const value = issue.facts?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function issueFactNumber(issue: RecoveryIssue, key: string): number | undefined {
  const value = issue.facts?.[key];
  return typeof value === 'number' ? value : undefined;
}

function issueFactString(issue: RecoveryIssue, key: string): string | undefined {
  const value = issue.facts?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createRecoveryIssue(opts: {
  id?: string | undefined;
  reason: RecoveryReason;
  phase: Phase;
  task?: Task | undefined;
  files: string[];
  affectedTaskIds: TaskId[];
  message: string;
  details: string[];
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  createdAt: string;
}): RecoveryIssue {
  const issue: RecoveryIssue = {
    id: opts.id ?? buildRecoveryIssueId({
      reason: opts.reason,
      phase: opts.phase,
      taskId: opts.task?.id,
      createdAt: opts.createdAt,
    }),
    reason: opts.reason,
    phase: opts.phase,
    status: 'awaiting-user',
    ...(opts.task ? { taskId: opts.task.id, taskTitle: opts.task.title } : {}),
    files: uniqueFiles(opts.files),
    affectedTaskIds: uniqueTaskIds(opts.affectedTaskIds),
    message: opts.message,
    details: opts.details.map(summarizeText).filter(detail => detail.length > 0),
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.selectedImplementerProfile !== undefined ? { selectedImplementerProfile: opts.selectedImplementerProfile } : {}),
    ...(opts.facts !== undefined && Object.keys(opts.facts).length > 0 ? { facts: opts.facts } : {}),
    availableActions: opts.availableActions,
    recommendedAction: opts.recommendedAction,
    createdAt: opts.createdAt,
  };
  return issue;
}

function orderedActions(actions: Array<RecoveryAction | undefined>): RecoveryAction[] {
  const requested = new Set(actions.filter(action => action !== undefined));
  return ACTION_ORDER.filter(action => requested.has(action));
}

function chooseRecommended(actions: RecoveryAction[], preferences: RecoveryAction[]): RecoveryAction {
  for (const preference of preferences) {
    if (actions.includes(preference)) return preference;
  }
  return actions[0] ?? 'pause-run';
}

function chooseUserEditRecommendation(conflict: UserEditConflict, actions: RecoveryAction[]): RecoveryAction {
  if (conflict.safeToContinue && actions.includes('continue')) return 'continue';
  return chooseRecommended(actions, ['planner-split-rebase', 'pause-run']);
}

function mapUserEditAction(action: UserEditConflictAction): RecoveryAction {
  if (action === 'continue-unrelated') return 'continue';
  if (action === 'regenerate-rebase') return 'planner-split-rebase';
  if (action === 'pause') return 'pause-run';
  return action;
}

function hasRetryBudget(attempts: number | undefined, maxAttempts: number | undefined): boolean {
  if (attempts === undefined || maxAttempts === undefined) return true;
  return attempts < maxAttempts;
}

function hasRouteBigger(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): boolean {
  if (opts.canRouteBigger === false) return false;
  return opts.routeBiggerProfile !== undefined || opts.canRouteBigger === true;
}

function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return summarizeText(error.message || error.name);
  }
  if (typeof error === 'string') return summarizeText(error);
  return 'Unknown implementation error';
}

function summarizeValidation(opts: {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}): { detail: string; summary: string; stage?: ValidationResult['stage'] | undefined } {
  if (opts.validationSummary !== undefined && opts.validationSummary.trim().length > 0) {
    const summary = summarizeText(opts.validationSummary);
    return { detail: `Validation: ${summary}`, summary };
  }

  const failed = opts.validationResults?.find(result => !result.passed);
  if (!failed) {
    return {
      detail: 'Validation failed without a reported failing stage.',
      summary: 'Validation failed without a reported failing stage.',
    };
  }

  const summary = summarizeText(failed.error || failed.output || `${failed.stage} failed`);
  return {
    detail: `Validation ${failed.stage} failed: ${summary}`,
    summary,
    stage: failed.stage,
  };
}

function summarizeText(input: string): string {
  const normalized = input.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function attemptDetails(attempts: number | undefined, maxAttempts: number | undefined): string[] {
  if (attempts === undefined && maxAttempts === undefined) return [];
  if (attempts !== undefined && maxAttempts !== undefined) return [`Attempts: ${attempts}/${maxAttempts}`];
  if (attempts !== undefined) return [`Attempts: ${attempts}`];
  return [`Max attempts: ${maxAttempts}`];
}

function implementerDetails(selectedImplementerProfile: string | undefined): string[] {
  return selectedImplementerProfile ? [`Worker profile: ${selectedImplementerProfile}`] : [];
}

function routeBiggerDetails(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): string[] {
  if (opts.routeBiggerProfile) return [`Bigger worker available: ${opts.routeBiggerProfile}`];
  if (opts.canRouteBigger) return ['Bigger worker available'];
  return [];
}

function contextDetails(opts: {
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}): string[] {
  return [
    opts.estimatedTokens !== undefined ? `Estimated prompt: ${opts.estimatedTokens} tokens` : undefined,
    opts.untruncatedEstimatedTokens !== undefined
      ? `Untruncated estimate: ${opts.untruncatedEstimatedTokens} tokens`
      : undefined,
    opts.contextLength !== undefined ? `Context limit: ${opts.contextLength} tokens` : undefined,
    opts.routingReason !== undefined ? `Routing: ${opts.routingReason}` : undefined,
  ].filter(detail => detail !== undefined);
}

function rejectedProfileDetails(routing: RoutingDecision | undefined): string[] {
  if (!routing || routing.rejected.length === 0) return [];
  const rejected = routing.rejected.map(profile => `${profile.profile}: ${profile.reason}`).join('; ');
  return [`Rejected profiles: ${rejected}`];
}

function fileConflictDetails(conflict: UserEditConflict): string[] {
  return conflict.fileConflicts.map(fileConflict => {
    const affected = fileConflict.affectedTaskIds.length > 0
      ? ` affects ${fileConflict.affectedTaskIds.join(', ')}`
      : '';
    return `${fileConflict.file}: ${fileConflict.kind}${affected}`;
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

function dependencyDetail(blockedByTaskIds: TaskId[], blockedByTasks: Task[]): string {
  if (blockedByTasks.length > 0) {
    const formatted = blockedByTasks
      .map(task => `${task.id} (${task.status})`)
      .join(', ');
    return `Blocked dependencies: ${formatted}`;
  }
  if (blockedByTaskIds.length > 0) {
    return `Blocked dependencies: ${blockedByTaskIds.join(', ')}`;
  }
  return 'Blocked dependency was not identified.';
}

function taskFiles(task: Task): string[] {
  return uniqueFiles([
    task.file,
    ...(task.scope?.inBounds ?? []).filter(looksLikeFilePath),
    ...(task.scope?.approvedOutOfBounds ?? []).filter(looksLikeFilePath),
  ]);
}

const ROOT_FILE_NAMES = new Set([
  'Dockerfile',
  'Makefile',
  'README',
  'LICENSE',
  'CHANGELOG',
  'NOTICE',
  'Procfile',
]);

function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('*')) return true;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith('.') && trimmed.length > 1) return true;
  if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(trimmed)) return true;
  return ROOT_FILE_NAMES.has(trimmed);
}

function uniqueFiles(files: string[]): string[] {
  return Array.from(new Set(files.map(file => file.trim()).filter(Boolean))).sort();
}

function uniqueTaskIds(ids: TaskId[]): TaskId[] {
  return Array.from(new Set(ids)).sort((left, right) => left.localeCompare(right));
}

function compactFacts(values: Record<string, RecoveryFact | undefined>): Record<string, RecoveryFact> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, RecoveryFact] => entry[1] !== undefined),
  );
}

function budgetPercentOf(currentCost: number, maxBudget: number): number {
  if (!Number.isFinite(currentCost) || !Number.isFinite(maxBudget) || maxBudget <= 0) return 0;
  return Math.round((currentCost / maxBudget) * 10_000) / 100;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  return `${Math.round(value)}%`;
}

function formatCostFact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return `$${value.toFixed(2)}`;
}
