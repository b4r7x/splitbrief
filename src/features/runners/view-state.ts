import type { RunnerPickerOption } from './model-catalog/options.js';
import type { ModelOption } from './model-catalog/recency.js';
import * as typeGuards from '../../utils/type-guards.js';

export type View =
  | { kind: 'picker' }
  | {
      kind: 'custom-command-contract';
      refocusKind?: 'shell' | 'agent' | undefined;
      draft?: string | undefined;
    }
  | { kind: 'custom-command'; intendedKind: 'shell' | 'agent'; draft?: string | undefined }
  | { kind: 'custom-model'; item: RunnerPickerOption }
  | { kind: 'provider-auth'; item: RunnerPickerOption }
  | { kind: 'provider-choice'; item: RunnerPickerOption; model: ModelOption };

export type ViewAction =
  | { type: 'open-custom-command-contract'; preservedLeftIndex: number }
  | { type: 'open-custom-command'; preservedLeftIndex: number; intendedKind: 'shell' | 'agent' }
  | { type: 'set-custom-command-draft'; draft: string }
  | { type: 'back-to-contract' }
  | { type: 'open-custom-model'; item: RunnerPickerOption }
  | { type: 'open-provider-auth'; item: RunnerPickerOption }
  | { type: 'open-provider-choice'; item: RunnerPickerOption; model: ModelOption }
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
    case 'open-custom-command-contract':
      return {
        view: { kind: 'custom-command-contract' },
        preservedLeftIndex: action.preservedLeftIndex,
      };
    case 'open-custom-command':
      return {
        view: {
          kind: 'custom-command',
          intendedKind: action.intendedKind,
          // A draft typed before stepping back survives the round trip.
          draft: state.view.kind === 'custom-command-contract' ? state.view.draft : undefined,
        },
        preservedLeftIndex: action.preservedLeftIndex,
      };
    case 'set-custom-command-draft':
      if (state.view.kind !== 'custom-command') return state;
      return { ...state, view: { ...state.view, draft: action.draft } };
    case 'back-to-contract':
      if (state.view.kind !== 'custom-command') return state;
      return {
        ...state,
        view: {
          kind: 'custom-command-contract',
          refocusKind: state.view.intendedKind,
          draft: state.view.draft,
        },
      };
    case 'open-custom-model':
      return { ...state, view: { kind: 'custom-model', item: action.item } };
    case 'open-provider-auth':
      return { ...state, view: { kind: 'provider-auth', item: action.item } };
    case 'open-provider-choice':
      return {
        ...state,
        view: { kind: 'provider-choice', item: action.item, model: action.model },
      };
    case 'close':
      return { ...state, view: { kind: 'picker' } };
    default:
      return typeGuards.assertNever(action);
  }
}
