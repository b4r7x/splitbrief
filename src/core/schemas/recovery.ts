import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
} from './enums.js';
import { TaskIdSchema } from './task.js';

export const RecoveryFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

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
