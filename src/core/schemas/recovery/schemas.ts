import { z } from 'zod';
import {
  EffortLevelSchema,
  PhaseSchema,
  RECOVERY_ACTIONS,
  RETIRED_RECOVERY_ACTIONS,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
  type RecoveryAction,
} from '../enums.js';
import { TaskIdSchema } from '../task.js';
import { CREW_SEAT_IDS } from '../../crew/identity.js';
import { allowedActionsForHalt, haltOf } from '../../recovery/halt.js';
import { includes, isRecord } from '../../../utils/type-guards.js';

export const RecoveryFactSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * One seat a quota-blocked run could move to: a detected, ready tool other
 * than the one that hit the limit. The model is present only when the
 * candidate names a specific one; absent means the seat keeps its own default.
 * The effort and variant are present when the picker chose them for the swap.
 */
export const SeatSwapCandidateSchema = z
  .object({
    tool: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: EffortLevelSchema.optional(),
    variant: z.string().min(1).optional(),
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

/** One saved action name in today's vocabulary; a retired name with no successor reads as none. */
export function readSavedRecoveryAction(value: unknown): unknown {
  if (typeof value !== 'string' || !(value in RETIRED_RECOVERY_ACTIONS)) return value;
  return RETIRED_RECOVERY_ACTIONS[value] ?? undefined;
}

export function readSavedRecoverySelections(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter(
    (entry) =>
      !isRecord(entry) ||
      typeof entry.action !== 'string' ||
      readSavedRecoveryAction(entry.action) !== undefined,
  );
}

/**
 * The reader for the actions a saved halt, a logged recovery event or a review packet carries.
 * Older runs offered actions the halts no longer do: each list keeps the actions its cause's halt
 * still offers, a recommendation the reader dropped becomes the first one left, and a selection
 * it dropped is cleared. `end-run` is every halt's last exit, so a list is never left empty. An
 * action no reading dropped stays as written, so the schema still refuses a list that never
 * offered its own recommendation.
 */
export function readSavedRecoveryActions(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const reason = RecoveryReasonSchema.safeParse(value.reason);
  const legal = reason.success ? allowedActionsForHalt(haltOf(reason.data)) : RECOVERY_ACTIONS;
  const next: Record<string, unknown> = { ...value };
  if ('action' in value) next.action = readSavedRecoveryAction(value.action);
  const saved = value.availableActions;
  if (!Array.isArray(saved)) return next;
  const retiredHere = (live: unknown): boolean =>
    live === undefined || (includes(RECOVERY_ACTIONS, live) && !legal.includes(live));
  const kept = [...new Set(saved.map(readSavedRecoveryAction))].filter(
    (live) => !retiredHere(live),
  );
  const available: unknown[] = kept.length > 0 ? kept : ['end-run'];
  next.availableActions = available;
  const dropped = (action: unknown): boolean => {
    const live = readSavedRecoveryAction(action);
    if (live === undefined) return true;
    const offered = saved.some((entry) => readSavedRecoveryAction(entry) === live);
    return offered && retiredHere(live);
  };
  const recommended = readSavedRecoveryAction(value.recommendedAction);
  next.recommendedAction = dropped(value.recommendedAction) ? available[0] : recommended;
  if ('selectedAction' in value) {
    if (dropped(value.selectedAction)) delete next.selectedAction;
    else next.selectedAction = readSavedRecoveryAction(value.selectedAction);
  }
  return next;
}

type RecoveryActionSelection = {
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  selectedAction?: RecoveryAction | undefined;
};

function recommendedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return issue.availableActions.includes(issue.recommendedAction);
}

function selectedActionIsAvailable(issue: RecoveryActionSelection): boolean {
  return (
    issue.selectedAction === undefined || issue.availableActions.includes(issue.selectedAction)
  );
}

export const RecoveryIssueSchema = z.preprocess(
  readSavedRecoveryActions,
  z
    .object({
      id: z.string(),
      reason: RecoveryReasonSchema,
      phase: PhaseSchema,
      status: RecoveryStatusSchema,
      /** Which seat the halt is about, when it is about a seat rather than the run. */
      seat: z.enum(CREW_SEAT_IDS).optional(),
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
      availableActions: z.array(RecoveryActionSchema).min(1),
      recommendedAction: RecoveryActionSchema,
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
    }),
);

export const TaskReviewRecoverySchema = z.preprocess(
  readSavedRecoveryActions,
  z
    .object({
      reason: RecoveryReasonSchema,
      availableActions: z.array(RecoveryActionSchema).min(1),
      recommendedAction: RecoveryActionSchema,
      message: z.string(),
    })
    .refine(recommendedActionIsAvailable, {
      path: ['recommendedAction'],
      message: 'recommendedAction must be one of availableActions',
    }),
);

export type RecoveryFact = z.infer<typeof RecoveryFactSchema>;
export type SeatSwapCandidate = z.infer<typeof SeatSwapCandidateSchema>;
export type SwitchSeatOffer = z.infer<typeof SwitchSeatOfferSchema>;
export type RecoveryIssue = z.infer<typeof RecoveryIssueSchema>;
