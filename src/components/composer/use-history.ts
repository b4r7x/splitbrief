import { useState } from 'react';
import { getInputHistoryDocuments, inputHistoryStore } from '../../stores/ui/input-history.js';
import { useStores } from '../../stores/use-stores.js';
import { INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE, stepDocumentHistory } from './history.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import type { Screen } from '../../core/navigation/types.js';

interface UseHistoryParams {
  disabled: boolean | undefined;
  document: DraftDocument;
  setDocument: (document: DraftDocument) => void;
  currentScreen: Screen;
}

interface ComposerHistory {
  inputEpoch: number;
  bumpEpoch: () => void;
  handleBoundaryNavigate: (direction: 'up' | 'down') => boolean;
  resetHistory: () => void;
  /** An edit means the draft is the operator's again, not the entry they walked back to. */
  noteEdit: () => void;
  historyActive: boolean;
}

export function useHistory({
  disabled,
  document,
  setDocument,
  currentScreen,
}: UseHistoryParams): ComposerHistory {
  const [history] = useStores(inputHistoryStore);
  const [historyState, setHistoryState] = useState(INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE);
  const [inputEpoch, setInputEpoch] = useState(0);
  const entries = getInputHistoryDocuments(history, { currentScreen });

  const noteEdit = () => {
    if (historyState.historyIndex !== null) {
      setHistoryState(INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE);
    }
  };

  const handleBoundaryNavigate = (direction: 'up' | 'down') => {
    if (disabled) {
      return false;
    }

    const result = stepDocumentHistory({
      entries,
      state: historyState,
      direction,
      currentValue: document,
    });
    if (!result.changed) return false;

    setDocument(result.nextValue);
    setHistoryState(result.nextState);
    setInputEpoch((epoch) => epoch + 1);
    return true;
  };

  const resetHistory = () => setHistoryState(INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE);
  const bumpEpoch = () => setInputEpoch((epoch) => epoch + 1);

  return {
    inputEpoch,
    bumpEpoch,
    handleBoundaryNavigate,
    resetHistory,
    noteEdit,
    historyActive: historyState.historyIndex !== null,
  };
}
