import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';

export interface InputHistoryNavigationState<T = string> {
  historyIndex: number | null;
  draftValue: T;
}

export interface InputHistoryNavigationResult<T = string> {
  changed: boolean;
  nextValue: T;
  nextState: InputHistoryNavigationState<T>;
}

export const INITIAL_INPUT_HISTORY_NAVIGATION_STATE: InputHistoryNavigationState = {
  historyIndex: null,
  draftValue: '',
};

export const INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE: InputHistoryNavigationState<DraftDocument> =
  {
    historyIndex: null,
    draftValue: createDraftDocument(''),
  };

export interface StepInputHistoryInput<T = string> {
  entries: readonly T[];
  state: InputHistoryNavigationState<T>;
  direction: 'up' | 'down';
  currentValue: T;
}

export function stepDocumentHistory(
  input: StepInputHistoryInput<DraftDocument>,
): InputHistoryNavigationResult<DraftDocument> {
  return stepInputHistory(input);
}

export function stepInputHistory<T>(
  input: StepInputHistoryInput<T>,
): InputHistoryNavigationResult<T> {
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
      nextState: { historyIndex: null, draftValue: state.draftValue },
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
