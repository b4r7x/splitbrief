import type { PickerOption } from './picker-catalog.js';

export type View =
  | { kind: 'picker' }
  | { kind: 'custom-command' }
  | { kind: 'custom-model'; item: PickerOption };

export type ViewAction =
  | { type: 'open-custom-command'; preservedLeftIndex: number }
  | { type: 'open-custom-model'; item: PickerOption }
  | { type: 'close' };

export interface ViewState {
  view: View;
  preservedLeftIndex: number;
}
