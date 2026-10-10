import { assertNever } from '../../utils/type-guards.js';
import type { CrewSeatId } from '../crew/identity.js';
import type { RUNNER_CALL_ROLES } from '../runner-call-contract.js';

export type RunnerRole = 'planner' | 'implementer';

/** The reviewer is a planner-tier seat: it shares the planner's admission set and policies. */
export type PlannerTierRole = 'planner' | 'reviewer';

export type ActiveRunnerRole = PlannerTierRole | 'implementer';

export const SEAT_PICKER_ROLES = ['planner', 'implementer', 'reviewer'] as const;

/** The config seats the tool/model picker can edit. */
export type SeatPickerRole = (typeof SEAT_PICKER_ROLES)[number];

export type PickerSlot = 'seat' | 'fallback';

/** The crew seat a picker role edits; the inverse of `CREW_SEAT_ROLES` in `src/core/crew/seats.ts`. */
export const PICKER_ROLE_SEAT_IDS: Readonly<Record<SeatPickerRole, CrewSeatId>> = {
  planner: 'plan',
  implementer: 'build',
  reviewer: 'review',
};

export function seatForRunningCall(call: {
  readonly role: (typeof RUNNER_CALL_ROLES)[number];
}): CrewSeatId | null {
  switch (call.role) {
    case 'planner':
    case 'implementer':
      return PICKER_ROLE_SEAT_IDS[call.role];
    case 'review':
      return PICKER_ROLE_SEAT_IDS.reviewer;
    case 'summary':
    case 'compaction':
    case 'escalation':
      return null;
    default:
      return assertNever(call.role);
  }
}

/** The config seat a picker role reads its catalog and policies from. */
export function seatPickerLane(role: SeatPickerRole): ActiveRunnerRole {
  switch (role) {
    case 'planner':
      return 'planner';
    case 'reviewer':
      return 'reviewer';
    case 'implementer':
      return 'implementer';
    default:
      return assertNever(role);
  }
}

export function runnerRoleForActiveRole(role: ActiveRunnerRole): RunnerRole {
  switch (role) {
    case 'planner':
    case 'reviewer':
      return 'planner';
    case 'implementer':
      return 'implementer';
    default:
      return assertNever(role);
  }
}
