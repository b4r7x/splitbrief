import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
} from '../enums.js';
import { TaskIdSchema } from '../task.js';
import { CREW_SEAT_IDS } from '../../crew/identity.js';
import {
  actionsAreLegalForReason,
  recommendedActionIsAvailable,
  selectedActionIsAvailable,
} from './policy.js';

export const RecoveryFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * One seat a quota-blocked run could move to: a detected, ready tool other
 * than the one that hit the limit. The model is present only when the
 * candidate names a specific one; absent means the seat keeps its own default.
 */
export const SeatSwapCandidateSchema = z
  .object({
    tool: z.string().min(1),
    model: z.string().min(1).optional(),
  })
  .strict();

/**
 * The seat-swap offer a `runner-usage-limit` issue carries when other ready
 * tools exist. Absent — never present-but-empty — when the machine has none.
 */
export const SwitchSeatOfferSchema = z
  .object({
    seat: z.enum(CREW_SEAT_IDS),
    candidates: z.array(SeatSwapCandidateSchema).min(1),
  })
  .strict();

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
    /** ISO instant the runner's own diagnostic advertised as its reset, when it named one. */
    resetAt: z.string().optional(),
    switchSeat: SwitchSeatOfferSchema.optional(),
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
export type SeatSwapCandidate = z.infer<typeof SeatSwapCandidateSchema>;
export type SwitchSeatOffer = z.infer<typeof SwitchSeatOfferSchema>;
export type RecoveryIssue = z.infer<typeof RecoveryIssueSchema>;
export type TaskReviewRecovery = z.infer<typeof TaskReviewRecoverySchema>;
