import type { PickerOption } from './model-catalog/options.js';
import * as typeGuards from '../../utils/type-guards.js';

export type View =
  | { kind: 'picker' }
  | { kind: 'custom-command'; intendedKind: 'shell' | 'agent' }
  | { kind: 'custom-model'; item: PickerOption };

export type ViewAction =
  | { type: 'open-custom-command'; preservedLeftIndex: number; intendedKind: 'shell' | 'agent' }
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
      return {
        view: { kind: 'custom-command', intendedKind: action.intendedKind },
        preservedLeftIndex: action.preservedLeftIndex,
      };
    case 'open-custom-model':
      return { ...state, view: { kind: 'custom-model', item: action.item } };
    case 'close':
      return { ...state, view: { kind: 'picker' } };
    default:
      return typeGuards.assertNever(action);
  }
}
