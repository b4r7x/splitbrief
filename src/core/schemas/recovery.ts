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

export const RecoveryIssueSchema = z
  .object({
    id: z.string(),
    reason: RecoveryReasonSchema,
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
    availableActions: z.array(RecoveryActionSchema).min(1),
    recommendedAction: RecoveryActionSchema,
    selectedAction: RecoveryActionSchema.optional(),
    createdAt: z.string(),
  })
  .refine((issue) => issue.availableActions.includes(issue.recommendedAction), {
    path: ['recommendedAction'],
    message: 'recommendedAction must be one of availableActions',
  })
  .refine(
    (issue) =>
      issue.selectedAction === undefined || issue.availableActions.includes(issue.selectedAction),
    {
      path: ['selectedAction'],
      message: 'selectedAction must be one of availableActions',
    },
  )
  .refine(
    (issue) => {
      const legal = allowedActionsForReason(issue.reason);
      return issue.availableActions.every((a) => legal.includes(a));
    },
    {
      path: ['availableActions'],
      message: 'availableActions contain actions illegal for the recovery reason',
    },
  );

export type RecoveryFact = z.infer<typeof RecoveryFactSchema>;
export type RecoveryIssue = z.infer<typeof RecoveryIssueSchema>;

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
