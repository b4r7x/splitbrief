import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { uniqueIds } from '../../../../utils/collections.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './shared.js';
import {
  attemptDetails,
  chooseRecommended,
  compactFacts,
  createRecoveryIssue,
  hasRetryBudget,
  hasRouteBigger,
  implementerDetails,
  orderedActions,
  routeBiggerDetails,
  summarizeUnknownError,
  summarizeValidation,
  taskFiles,
  uniqueFiles,
} from './shared.js';

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

export function buildDependencyBlockedRecoveryIssue(opts: DependencyBlockedRecoveryOptions): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const blockedByTaskIds = uniqueIds([
    ...(opts.blockedByTaskIds ?? []),
    ...(opts.blockedByTasks ?? []).map(task => task.id),
  ]);
  const affectedTaskIds = uniqueIds([opts.task.id, ...blockedByTaskIds]);
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
