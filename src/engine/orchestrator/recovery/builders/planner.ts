import type { Phase, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { SeatSwitchRecord } from '../../../../core/schemas/workflow.js';
import type {
  DeepReadonly,
  RunnerConfig,
} from '../../../../core/config/accessors/runner-config.js';
import type { PlannerCallDiagnosis } from '../planner-call-failure.js';
import type { RecoveryBuilderBase } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, haltActions } from './actions.js';
import { taskFiles } from './details.js';
import { buildSeatDownIssue, switchSeatOffer, type SeatSwapContext } from './task.js';

/** Why the plan seat could not produce its artifact. */
export type PlannerSeatFailure = 'unauthenticated' | 'usage-limit' | 'call-failed';

const PLANNER_FAILURE_REASONS = {
  unauthenticated: 'runner-unauthenticated',
  'usage-limit': 'runner-usage-limit',
  'call-failed': 'planner-call-failed',
} as const satisfies Record<PlannerSeatFailure, RecoveryReason>;

export interface PlannerCallFailureRecoveryOptions extends RecoveryBuilderBase {
  /**
   * What the failed call says about its seat, as `diagnosePlannerCallFailure` reads it. A failure
   * that is read off typed data instead names only its kind and message.
   */
  diagnosis: Pick<PlannerCallDiagnosis, 'failure' | 'message'> & Partial<PlannerCallDiagnosis>;
  phase: Phase;
  /** The runner the halted call ran on; the seat-down halt names it. */
  runner: DeepReadonly<RunnerConfig>;
  /** The planner-tier seat the call ran on. The final review's call halts on the review seat. */
  seat?: 'plan' | 'review' | undefined;
  /** The brief whose hint call it was, when it was one: the halt names it and can skip it. */
  task?: Task | undefined;
  /** What the halt adds after the tool's own words. */
  details?: string[] | undefined;
  seatSwap?: SeatSwapContext | undefined;
  /** The switches this run already made, so a seat is moved to its fallback at most once. */
  seatSwitches?: readonly SeatSwitchRecord[] | undefined;
  /**
   * Scalar diagnosis the halt carries beyond its prose — the insufficient-context
   * figures, which belong in facts because `details[]` renders inline and is
   * truncated. Merged over the builder's own facts, never replacing them.
   */
  facts?: Record<string, RecoveryFact> | undefined;
}

/**
 * A planner call that failed halts the run instead of ending it: the seat can be
 * re-issued, moved to another detected tool, or the run stopped on it. There is
 * no bigger profile to route to — the seat either runs again or it does not run —
 * and a task to skip only when the call was a brief's hint. A sign-out or a
 * refusal the classifier named builds the one seat-down halt instead.
 */
export function buildPlannerCallFailedRecoveryIssue(
  opts: PlannerCallFailureRecoveryOptions,
): RecoveryIssue {
  const { diagnosis } = opts;
  if (diagnosis.seatDown !== undefined) {
    return buildSeatDownIssue({
      id: opts.id,
      seat: opts.seat ?? 'plan',
      runner: opts.runner,
      classification: diagnosis.seatDown.classification,
      words: diagnosis.seatDown.words,
      ...(diagnosis.seatDown.requestId !== undefined && {
        requestId: diagnosis.seatDown.requestId,
      }),
      task: opts.task,
      phase: opts.phase,
      seatSwitches: opts.seatSwitches,
      ...(opts.seatSwap !== undefined && { seatSwap: opts.seatSwap }),
      ...(opts.details !== undefined && { details: opts.details }),
      createdAt: opts.createdAt,
    });
  }
  const reason = PLANNER_FAILURE_REASONS[diagnosis.failure];
  const resetsAt = diagnosis.resetsAt ?? null;
  const offer = switchSeatOffer(opts.seatSwap);
  const actions = haltActions(reason, [
    'retry-same-worker',
    offer === undefined ? undefined : 'switch-seat',
    opts.task === undefined ? undefined : 'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: opts.seat ?? 'plan',
    reason,
    phase: opts.phase,
    task: opts.task,
    files: opts.task === undefined ? [] : taskFiles(opts.task),
    affectedTaskIds: opts.task === undefined ? [] : [opts.task.id],
    message: diagnosis.message,
    details: [...(diagnosis.details ?? []), ...(opts.details ?? [])],
    ...(resetsAt !== null && { resetAt: resetsAt.toISOString() }),
    ...(offer !== undefined && { switchSeat: offer }),
    facts: compactFacts({ tool: diagnosis.tool, ...opts.facts }),
    availableActions: actions,
    recommendedAction: chooseRecommended(
      actions,
      diagnosis.failure === 'usage-limit' ? ['switch-seat'] : [],
    ),
    createdAt: opts.createdAt,
  });
}

export interface PlannerArtifactRecoveryOptions extends RecoveryBuilderBase {
  phase: Phase;
  message: string;
  details?: string[] | undefined;
}

/**
 * The planning session stopped inside its bounds: a third round of questions, or a plan that still
 * failed its checks after the one repair. The conversation stays, so the operator's correction or
 * a re-issue continues the same session.
 */
export function buildPlanSessionHaltRecoveryIssue(
  opts: PlannerArtifactRecoveryOptions & {
    reason: Extract<RecoveryReason, 'plan-questions-exhausted' | 'plan-checks-failed'>;
  },
): RecoveryIssue {
  const actions = haltActions(opts.reason, ['retry-same-worker', 'revise', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'plan',
    reason: opts.reason,
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['revise']),
    createdAt: opts.createdAt,
  });
}
