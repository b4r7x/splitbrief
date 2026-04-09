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

export const initialViewState: ViewState = {
  view: { kind: 'picker' },
  preservedLeftIndex: 0,
};

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'open-custom-command':
      return { view: { kind: 'custom-command' }, preservedLeftIndex: action.preservedLeftIndex };
    case 'open-custom-model':
      return { ...state, view: { kind: 'custom-model', item: action.item } };
    case 'close':
      return { ...state, view: { kind: 'picker' } };
  }
}
