import { DEFAULT_SELECTION, type PairingSelection } from './pairings.js';

export const PATCH_PULSE_MS = 400;

export type MatrixPulse = Readonly<{
  revision: number;
  selection: PairingSelection;
}>;

export type MatrixState = Readonly<{
  selected: PairingSelection;
  output: PairingSelection;
  pulse: MatrixPulse | null;
  announcement: string;
}>;

export type MatrixAction =
  | Readonly<{
      type: 'pulse-started';
      revision: number;
      selection: PairingSelection;
    }>
  | Readonly<{
      type: 'pulse-completed';
      revision: number;
    }>
  | Readonly<{
      type: 'selection-committed';
      selection: PairingSelection;
    }>;

export const INITIAL_MATRIX_STATE: MatrixState = {
  selected: DEFAULT_SELECTION,
  output: DEFAULT_SELECTION,
  pulse: null,
  announcement: '',
};

export function samePairingSelection(left: PairingSelection, right: PairingSelection): boolean {
  return left.plannerId === right.plannerId && left.implementerId === right.implementerId;
}

export function pairingAnnouncement(selection: PairingSelection): string {
  return `Config updated: ${selection.plannerId} × ${selection.implementerId}`;
}

export function matrixStateReducer(state: MatrixState, action: MatrixAction): MatrixState {
  switch (action.type) {
    case 'pulse-started':
      if (samePairingSelection(state.selected, action.selection)) {
        return state;
      }

      return {
        ...state,
        selected: action.selection,
        pulse: {
          revision: action.revision,
          selection: action.selection,
        },
        announcement: '',
      };
    case 'pulse-completed':
      if (state.pulse?.revision !== action.revision) {
        return state;
      }

      return {
        ...state,
        output: state.pulse.selection,
        pulse: null,
        announcement: pairingAnnouncement(state.pulse.selection),
      };
    case 'selection-committed':
      return {
        selected: action.selection,
        output: action.selection,
        pulse: null,
        announcement: pairingAnnouncement(action.selection),
      };
  }
}
