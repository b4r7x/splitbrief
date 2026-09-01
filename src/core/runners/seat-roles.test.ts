import { describe, expect, it } from 'vitest';
import {
  seatPickerLane,
  SEAT_PICKER_ROLES,
  type ActiveRunnerRole,
  type SeatPickerRole,
} from './seat-roles.js';

describe('seatPickerLane', () => {
  it('reads every picker role through its own seat lane', () => {
    for (const role of ['planner', 'implementer', 'reviewer'] as const) {
      expect(seatPickerLane(role)).toBe(role);
    }
  });

  it('accepts every config seat as a picker role', () => {
    for (const seat of [
      'planner',
      'implementer',
      'reviewer',
    ] as const satisfies readonly ActiveRunnerRole[]) {
      const pickerRole: SeatPickerRole = seat;
      expect(SEAT_PICKER_ROLES).toContain(pickerRole);
    }
  });
});
