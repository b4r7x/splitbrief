import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';

export interface InputHistoryNavigationState {
  historyIndex: number | null;
  draftValue: DraftDocument;
}

export interface InputHistoryNavigationResult {
  changed: boolean;
  nextValue: DraftDocument;
  nextState: InputHistoryNavigationState;
}

export const INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE: InputHistoryNavigationState = {
  historyIndex: null,
  draftValue: createDraftDocument(''),
};

export interface StepInputHistoryInput {
  entries: readonly DraftDocument[];
  state: InputHistoryNavigationState;
  direction: 'up' | 'down';
  currentValue: DraftDocument;
}

export function stepDocumentHistory(input: StepInputHistoryInput): InputHistoryNavigationResult {
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
