import { assertNever } from '../../utils/type-guards.js';

export type RunnerRole = 'planner' | 'implementer';

/** The reviewer is a planner-tier seat: it shares the planner's admission set and policies. */
export type PlannerTierRole = 'planner' | 'reviewer';

export type ActiveRunnerRole = PlannerTierRole | 'implementer';

export const SEAT_PICKER_ROLES = ['planner', 'implementer', 'reviewer'] as const;

/** The config seats the tool/model picker can edit. */
export type SeatPickerRole = (typeof SEAT_PICKER_ROLES)[number];

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
