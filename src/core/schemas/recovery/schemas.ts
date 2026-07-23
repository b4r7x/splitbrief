import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
} from '../enums.js';
import { TaskIdSchema } from '../task.js';
import {
  actionsAreLegalForReason,
  recommendedActionIsAvailable,
  selectedActionIsAvailable,
} from './policy.js';

export const RecoveryFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const recoveryActionFields = {
  reason: RecoveryReasonSchema,
  availableActions: z.array(RecoveryActionSchema).min(1),
  recommendedAction: RecoveryActionSchema,
} as const;

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

export type RecoveryFact = z.infer<typeof RecoveryFactSchema>;
export type RecoveryIssue = z.infer<typeof RecoveryIssueSchema>;
export type TaskReviewRecovery = z.infer<typeof TaskReviewRecoverySchema>;
