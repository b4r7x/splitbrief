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
