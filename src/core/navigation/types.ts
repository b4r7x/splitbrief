import type { SeatPickerRole } from '../runners/seat-roles.js';
import { includes } from '../../utils/type-guards.js';

export const ALL_SCREENS = ['home', 'workflow', 'summary', 'setup'] as const;
export type Screen = (typeof ALL_SCREENS)[number];

export type InputMode = 'normal' | 'review' | 'question';

export const SEAT_PICKER_OVERLAYS = [
  'planner-picker',
  'implementer-picker',
  'reviewer-picker',
] as const;

export function seatPickerOverlayFor(role: SeatPickerRole): (typeof SEAT_PICKER_OVERLAYS)[number] {
  return `${role}-picker`;
}

const SEAT_AXIS_FOCUS_PREFIX = 'seat:';
const SEAT_AXIS_FOCUS_SUFFIX = ':effort';

/** The focus token a crew row hands the overlay so Enter lands on the seat's effort axis. */
export function seatAxisFocus(seatId: string): string {
  return `${SEAT_AXIS_FOCUS_PREFIX}${seatId}${SEAT_AXIS_FOCUS_SUFFIX}`;
}

/** The seat the token names, or undefined when the token is not one of ours. */
export function seatAxisFocusSeat(focus: string | undefined): string | undefined {
  if (focus === undefined) return undefined;
  if (!focus.startsWith(SEAT_AXIS_FOCUS_PREFIX) || !focus.endsWith(SEAT_AXIS_FOCUS_SUFFIX)) {
    return undefined;
  }
  return focus.slice(SEAT_AXIS_FOCUS_PREFIX.length, -SEAT_AXIS_FOCUS_SUFFIX.length) || undefined;
}

export const ACTIVE_OVERLAYS = [
  'help',
  'command-palette',
  'skills',
  'settings',
  'mode-selector',
  ...SEAT_PICKER_OVERLAYS,
  'sessions',
  'editor',
  'cost-drilldown',
] as const;
export type OverlayType = 'none' | (typeof ACTIVE_OVERLAYS)[number];

export function overlayAllowsPickerKeys(active: OverlayType): boolean {
  return active === 'none' || includes(SEAT_PICKER_OVERLAYS, active);
}
