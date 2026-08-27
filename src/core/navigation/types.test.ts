import { describe, expect, it } from 'vitest';
import {
  ACTIVE_OVERLAYS,
  SEAT_PICKER_OVERLAYS,
  overlayAllowsPickerKeys,
  seatPickerOverlayFor,
} from './types.js';
import { SEAT_PICKER_ROLES } from '../runners/cli-tool-catalog.js';

describe('seat picker overlays', () => {
  it('gives every seat picker role a routable overlay', () => {
    expect(SEAT_PICKER_ROLES.map(seatPickerOverlayFor)).toEqual([...SEAT_PICKER_OVERLAYS]);
    expect(SEAT_PICKER_ROLES).toEqual(['planner', 'implementer', 'reviewer']);
  });

  it('routes every seat picker overlay from the overlay set', () => {
    for (const overlay of SEAT_PICKER_OVERLAYS) {
      expect(ACTIVE_OVERLAYS).toContain(overlay);
    }
  });

  it('keeps the picker keys live on a seat picker and dead on any other overlay', () => {
    expect(overlayAllowsPickerKeys('none')).toBe(true);
    expect(overlayAllowsPickerKeys('planner-picker')).toBe(true);
    expect(overlayAllowsPickerKeys('settings')).toBe(false);
  });
});
