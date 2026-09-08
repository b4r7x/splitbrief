import { describe, expect, it } from 'vitest';
import type { CrewSeatId } from '../crew/identity.js';
import { CREW_SEAT_ROLES } from '../crew/seats.js';
import {
  PICKER_ROLE_SEAT_IDS,
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

describe('PICKER_ROLE_SEAT_IDS', () => {
  it('is the exact inverse of CREW_SEAT_ROLES', () => {
    expect(Object.keys(PICKER_ROLE_SEAT_IDS)).toHaveLength(3);
    expect(Object.keys(CREW_SEAT_ROLES)).toHaveLength(3);

    for (const [seat, role] of Object.entries(CREW_SEAT_ROLES)) {
      const expectedSeat: CrewSeatId = PICKER_ROLE_SEAT_IDS[role];
      expect(expectedSeat).toBe(seat);
    }
  });
});
