import {
  RETIRED_RECOVERY_REASONS,
  type RecoveryAction,
  type RecoveryReason,
  type RetiredRecoveryReason,
} from '../schemas/enums.js';
import { includes } from '../../utils/type-guards.js';

/**
 * The two halts a person sees. *Needs you*: a decision only the operator can make — a spent bound,
 * a failed review after the cap, a protected write, a conflict at Apply. *Seat down*: the seat
 * cannot run — signed out, out of quota, refused its command, or answered off its contract twice.
 */
export type RecoveryHalt = 'needs-you' | 'seat-down';

const NEEDS_YOU_ACTIONS = [
  'continue',
  'retry-same-worker',
  'revise',
  'accept-as-is',
  'restore-backup',
  'skip-current-task',
  'end-run',
] as const satisfies readonly RecoveryAction[];

const SEAT_DOWN_ACTIONS = [
  'switch-seat',
  'retry-later',
  'retry-same-worker',
  'skip-current-task',
  'end-run',
] as const satisfies readonly RecoveryAction[];

export type HaltAction<H extends RecoveryHalt> = H extends 'seat-down'
  ? (typeof SEAT_DOWN_ACTIONS)[number]
  : (typeof NEEDS_YOU_ACTIONS)[number];

const HALT_ACTIONS: Record<RecoveryHalt, readonly RecoveryAction[]> = {
  'needs-you': NEEDS_YOU_ACTIONS,
  'seat-down': SEAT_DOWN_ACTIONS,
};

/** Every cause onto its halt. The cause code stays in the issue, the event and the log. */
export const REASON_HALT = {
  'implementation-error': 'needs-you',
  'retry-exhausted': 'needs-you',
  'consult-bound-spent': 'needs-you',
  'planner-calls-spent': 'needs-you',
  'dependency-blocked': 'needs-you',
  'checkout-changed': 'needs-you',
  'review-failed': 'needs-you',
  'review-input-too-large': 'needs-you',
  'required-checks-unrunnable': 'needs-you',
  'approval-denied': 'needs-you',
  'snapshot-failed': 'needs-you',
  'plan-questions-exhausted': 'needs-you',
  'plan-checks-failed': 'needs-you',
  'apply-conflict': 'needs-you',
  'apply-partial': 'needs-you',
  'runner-unauthenticated': 'seat-down',
  'runner-usage-limit': 'seat-down',
  'runner-timeout-repeated': 'seat-down',
  'implementer-recipe-invalid': 'seat-down',
  'implementer-left-isolation': 'seat-down',
  'context-overflow': 'seat-down',
  'planner-call-failed': 'seat-down',
  'seat-protocol-error': 'seat-down',
  'validation-failed': 'needs-you',
  'user-edit-conflict': 'needs-you',
  'approval-promotion-conflict': 'needs-you',
  'scope-violation': 'needs-you',
  'planner-returned-no-briefs': 'needs-you',
  'constitution-check-failed': 'needs-you',
  'brief-review-no-progress': 'needs-you',
  'brief-quality-unrepaired': 'needs-you',
} as const satisfies Record<RecoveryReason, RecoveryHalt>;

export type HaltOf<R extends RecoveryReason> = (typeof REASON_HALT)[R];

export function haltOf(reason: RecoveryReason): RecoveryHalt {
  return REASON_HALT[reason];
}

/** The actions a halt may offer; each cause offers the ones its situation allows. */
export function allowedActionsForHalt(halt: RecoveryHalt): readonly RecoveryAction[] {
  return HALT_ACTIONS[halt];
}

export function isRetiredRecoveryReason(reason: RecoveryReason): reason is RetiredRecoveryReason {
  return includes(RETIRED_RECOVERY_REASONS, reason);
}

/** The halt's name, the first words every surface shows. */
export function recoveryHaltLabel(halt: RecoveryHalt): string {
  return halt === 'needs-you' ? 'Needs you' : 'Seat down';
}
