import { useEffect, useReducer, useRef, type RefObject } from 'react';
import type { PairingSelection } from './pairings.js';
import {
  INITIAL_MATRIX_STATE,
  PATCH_PULSE_MS,
  matrixStateReducer,
  pairingAnnouncement,
  samePairingSelection,
  type MatrixPulse,
} from './matrix-state.js';

export type PairingSelectionController = Readonly<{
  selected: PairingSelection;
  output: PairingSelection;
  pulse: MatrixPulse | null;
  announcement: string;
  select: (selection: PairingSelection) => void;
}>;

type UsePairingSelectionOptions = {
  readonly reducedMotion: boolean;
};

function cancelPulseTimer(timerRef: RefObject<number | null>): void {
  if (timerRef.current === null) {
    return;
  }

  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

export function usePairingSelection({
  reducedMotion,
}: UsePairingSelectionOptions): PairingSelectionController {
  const [state, dispatch] = useReducer(matrixStateReducer, INITIAL_MATRIX_STATE);
  const timerRef = useRef<number | null>(null);
  const nextRevisionRef = useRef(0);

  useEffect(() => () => cancelPulseTimer(timerRef), []);

  useEffect(() => {
    const pulse = state.pulse;
    if (!reducedMotion || pulse === null) {
      return;
    }

    cancelPulseTimer(timerRef);
    dispatch({ type: 'pulse-completed', revision: pulse.revision });
  }, [reducedMotion, state.pulse]);

  function select(selection: PairingSelection): void {
    if (samePairingSelection(state.selected, selection)) {
      return;
    }

    cancelPulseTimer(timerRef);

    if (reducedMotion) {
      dispatch({ type: 'selection-committed', selection });
      return;
    }

    nextRevisionRef.current += 1;
    const revision = nextRevisionRef.current;

    dispatch({ type: 'pulse-started', revision, selection });

    const timer = window.setTimeout(() => {
      if (timerRef.current !== timer) {
        return;
      }

      timerRef.current = null;
      dispatch({ type: 'pulse-completed', revision });
    }, PATCH_PULSE_MS);

    timerRef.current = timer;
  }

  const settlingSelection = reducedMotion ? state.pulse?.selection : undefined;

  return {
    selected: state.selected,
    output: settlingSelection ?? state.output,
    pulse: settlingSelection ? null : state.pulse,
    announcement: settlingSelection ? pairingAnnouncement(settlingSelection) : state.announcement,
    select,
  };
}
