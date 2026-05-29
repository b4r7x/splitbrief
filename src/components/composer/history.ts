export interface InputHistoryNavigationState {
  historyIndex: number | null;
  draftValue: string;
}

export interface InputHistoryNavigationResult {
  changed: boolean;
  nextValue: string;
  nextState: InputHistoryNavigationState;
}

export const INITIAL_INPUT_HISTORY_NAVIGATION_STATE: InputHistoryNavigationState = {
  historyIndex: null,
  draftValue: '',
};

export interface StepInputHistoryInput {
  entries: string[];
  state: InputHistoryNavigationState;
  direction: 'up' | 'down';
  currentValue: string;
}

export function stepInputHistory(input: StepInputHistoryInput): InputHistoryNavigationResult {
  const { entries, state, direction, currentValue } = input;
  if (entries.length === 0) {
    return { changed: false, nextValue: currentValue, nextState: state };
  }

  if (direction === 'up') {
    const nextIndex =
      state.historyIndex === null ? 0 : Math.min(state.historyIndex + 1, entries.length - 1);

    if (state.historyIndex === nextIndex) {
      return { changed: false, nextValue: currentValue, nextState: state };
    }

    return {
      changed: true,
      nextValue: entries[nextIndex] ?? currentValue,
      nextState: {
        historyIndex: nextIndex,
        draftValue: state.historyIndex === null ? currentValue : state.draftValue,
      },
    };
  }

  if (state.historyIndex === null) {
    return { changed: false, nextValue: currentValue, nextState: state };
  }

  if (state.historyIndex === 0) {
    return {
      changed: true,
      nextValue: state.draftValue,
      nextState: INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
    };
  }

  const nextIndex = state.historyIndex - 1;
  return {
    changed: true,
    nextValue: entries[nextIndex] ?? currentValue,
    nextState: {
      ...state,
      historyIndex: nextIndex,
    },
  };
}
