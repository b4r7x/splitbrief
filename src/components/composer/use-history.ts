import { useState } from 'react';
import { getInputHistoryEntries, inputHistoryStore } from '../../stores/ui/input-history.js';
import { useStores } from '../../stores/use-stores.js';
import { INITIAL_INPUT_HISTORY_NAVIGATION_STATE, stepInputHistory } from './history.js';
import type { Screen } from '../../core/navigation/types.js';

interface UseHistoryParams {
  disabled: boolean | undefined;
  value: string;
  setValue: (value: string) => void;
  currentScreen: Screen;
}

interface ComposerHistory {
  inputEpoch: number;
  bumpEpoch: () => void;
  handleBoundaryNavigate: (direction: 'up' | 'down') => boolean;
  resetHistory: () => void;
  onChange: (nextValue: string) => void;
  historyActive: boolean;
}

export function useHistory({
  disabled,
  value,
  setValue,
  currentScreen,
}: UseHistoryParams): ComposerHistory {
  const [history] = useStores(inputHistoryStore);
  const [historyState, setHistoryState] = useState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  const [inputEpoch, setInputEpoch] = useState(0);
  const entries = getInputHistoryEntries(history, { currentScreen });

  const onChange = (nextValue: string) => {
    setValue(nextValue);
    if (historyState.historyIndex !== null) {
      setHistoryState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
    }
  };

  const handleBoundaryNavigate = (direction: 'up' | 'down') => {
    if (disabled) {
      return false;
    }

    const result = stepInputHistory({
      entries,
      state: historyState,
      direction,
      currentValue: value,
    });
    if (!result.changed) return false;

    setValue(result.nextValue);
    setHistoryState(result.nextState);
    setInputEpoch((epoch) => epoch + 1);
    return true;
  };

  const resetHistory = () => setHistoryState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  const bumpEpoch = () => setInputEpoch((epoch) => epoch + 1);

  return {
    inputEpoch,
    bumpEpoch,
    handleBoundaryNavigate,
    resetHistory,
    onChange,
    historyActive: historyState.historyIndex !== null,
  };
}
