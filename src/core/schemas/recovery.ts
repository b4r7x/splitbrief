import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  type RecoveryAction,
  RecoveryReasonSchema,
  type RecoveryReason,
  RecoveryStatusSchema,
} from './enums.js';
import { TaskIdSchema } from './task.js';

export const RecoveryFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const recoveryActionFields = {
  reason: RecoveryReasonSchema,
  availableActions: z.array(RecoveryActionSchema).min(1),
  recommendedAction: RecoveryActionSchema,
} as const;

const BUDGET_ONLY_ACTIONS = [
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const BUDGET_PAUSED_ACTIONS = [
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const TASK_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const CONTEXT_OVERFLOW_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const CONFLICT_RECOVERY_ACTIONS = [
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];
const DEPENDENCY_BLOCKED_ACTIONS = [
  'skip-current-task',
  'pause-run',
  'abort-workflow',
] as const satisfies readonly RecoveryAction[];

function copyActions(actions: readonly RecoveryAction[]): RecoveryAction[] {
  return [...actions];
}

export function allowedActionsForReason(reason: RecoveryReason): RecoveryAction[] {
  switch (reason) {
    case 'budget-exceeded':
      return copyActions(BUDGET_ONLY_ACTIONS);
    case 'budget-paused':
      return copyActions(BUDGET_PAUSED_ACTIONS);
    case 'user-edit-conflict':
    case 'approval-promotion-conflict':
      return copyActions(CONFLICT_RECOVERY_ACTIONS);
    case 'implementation-error':
    case 'validation-failed':
    case 'retry-exhausted':
      return copyActions(TASK_RECOVERY_ACTIONS);
    case 'context-overflow':
      return copyActions(CONTEXT_OVERFLOW_ACTIONS);
    case 'dependency-blocked':
      return copyActions(DEPENDENCY_BLOCKED_ACTIONS);
    default:
      return copyActions(BUDGET_ONLY_ACTIONS);
  }
}

type RecoveryActionSelection = {
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  selectedAction?: RecoveryAction | undefined;
};

type RecoveryReasonActions = {
  reason: RecoveryReason;
  availableActions: RecoveryAction[];
};

function recommendedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return issue.availableActions.includes(issue.recommendedAction);
}

function selectedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return (
    issue.selectedAction === undefined || issue.availableActions.includes(issue.selectedAction)
  );
}

function actionsAreLegalForReason(issue: RecoveryReasonActions): boolean {
  const legal = allowedActionsForReason(issue.reason);
  return issue.availableActions.every((action) => legal.includes(action));
}

export const RecoveryIssueSchema = z
  .object({
    id: z.string(),
    reason: recoveryActionFields.reason,
    phase: PhaseSchema,
    status: RecoveryStatusSchema,
    taskId: TaskIdSchema.optional(),
    taskTitle: z.string().optional(),
    files: z.array(z.string()),
    affectedTaskIds: z.array(TaskIdSchema),
    message: z.string(),
    details: z.array(z.string()),
    attempts: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    selectedImplementerProfile: z.string().optional(),
    facts: z.record(z.string(), RecoveryFactSchema).optional(),
    availableActions: recoveryActionFields.availableActions,
    recommendedAction: recoveryActionFields.recommendedAction,
    selectedAction: RecoveryActionSchema.optional(),
    createdAt: z.string(),
  })
  .refine(recommendedActionIsAvailable, {
    path: ['recommendedAction'],
    message: 'recommendedAction must be one of availableActions',
  })
  .refine(selectedActionIsAvailable, {
    path: ['selectedAction'],
    message: 'selectedAction must be one of availableActions',
  })
  .refine(actionsAreLegalForReason, {
    path: ['availableActions'],
    message: 'availableActions contain actions illegal for the recovery reason',
  });

export const TaskReviewRecoverySchema = z
  .object({
    ...recoveryActionFields,
    message: z.string(),
  })
  .refine(recommendedActionIsAvailable, {
    path: ['recommendedAction'],
    message: 'recommendedAction must be one of availableActions',
  })
  .refine(actionsAreLegalForReason, {
    path: ['availableActions'],
    message: 'availableActions contain actions illegal for the recovery reason',
  });

export const IpcRecoveryIssueSchema = z
  .strictObject({
    id: z.string(),
    reason: recoveryActionFields.reason,
    phase: PhaseSchema,
    taskId: TaskIdSchema.optional(),
    taskTitle: z.string().optional(),
    files: z.array(z.string()),
    affectedTaskIds: z.array(TaskIdSchema),
    selectedImplementerProfile: z.string().optional(),
    availableActions: recoveryActionFields.availableActions,
    recommendedAction: recoveryActionFields.recommendedAction,
    workerProfile: z.string().optional(),
    facts: z.record(z.string(), z.boolean()).optional(),
  })
  .refine(recommendedActionIsAvailable, {
    path: ['recommendedAction'],
    message: 'recommendedAction must be one of availableActions',
  })
  .refine(actionsAreLegalForReason, {
    path: ['availableActions'],
    message: 'availableActions contain actions illegal for the recovery reason',
  });

export type RecoveryFact = z.infer<typeof RecoveryFactSchema>;
export type RecoveryIssue = z.infer<typeof RecoveryIssueSchema>;
export type TaskReviewRecovery = z.infer<typeof TaskReviewRecoverySchema>;
export type IpcRecoveryIssue = z.infer<typeof IpcRecoveryIssueSchema>;

export function projectIpcRecoveryIssue(issue: RecoveryIssue): IpcRecoveryIssue {
  const facts = booleanFacts(issue.facts);
  const workerProfile =
    typeof issue.facts?.['routeBiggerProfile'] === 'string'
      ? issue.facts['routeBiggerProfile']
      : undefined;
  return {
    id: issue.id,
    reason: issue.reason,
    phase: issue.phase,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.taskTitle !== undefined && { taskTitle: issue.taskTitle }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    ...(issue.selectedImplementerProfile !== undefined && {
      selectedImplementerProfile: issue.selectedImplementerProfile,
    }),
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    ...(workerProfile !== undefined && { workerProfile }),
    ...(facts !== undefined && { facts }),
  };
}

function booleanFacts(
  facts: Record<string, RecoveryFact> | undefined,
): Record<string, boolean> | undefined {
  if (facts === undefined) return undefined;
  const entries = Object.entries(facts).filter((entry): entry is [string, boolean] => {
    return typeof entry[1] === 'boolean';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function recoveryFactString(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): string | undefined {
  const value = facts?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recoveryFactNumber(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): number | undefined {
  const value = facts?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function recoveryFactBoolean(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): boolean | undefined {
  const value = facts?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
