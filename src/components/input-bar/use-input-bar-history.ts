import { useState } from 'react';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { useStores } from '../../stores/use-stores.js';
import type { Screen } from '../../stores/navigation/router.js';
import {
  INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
  stepInputHistory,
} from './history-navigation.js';

interface UseInputBarHistoryParams {
  currentScreen: Screen;
  disabled: boolean | undefined;
  value: string;
  setValue: (value: string) => void;
}

interface InputBarHistory {
  inputEpoch: number;
  bumpEpoch: () => void;
  handleBoundaryNavigate: (direction: 'up' | 'down') => boolean;
  resetHistory: () => void;
  onChange: (nextValue: string) => void;
}

export function useInputBarHistory({
  currentScreen,
  disabled,
  value,
  setValue,
}: UseInputBarHistoryParams): InputBarHistory {
  const [{ entries: homeHistory }] = useStores(inputHistoryStore);
  const [historyState, setHistoryState] = useState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  const [inputEpoch, setInputEpoch] = useState(0);

  const onChange = (nextValue: string) => {
    setValue(nextValue);
    if (historyState.historyIndex !== null) {
      setHistoryState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
    }
  };

  const handleBoundaryNavigate = (direction: 'up' | 'down') => {
    if (currentScreen !== 'home' || disabled) {
      return false;
    }

    const result = stepInputHistory(homeHistory, historyState, direction, value);
    if (!result.changed) return false;

    setValue(result.nextValue);
    setHistoryState(result.nextState);
    setInputEpoch((epoch) => epoch + 1);
    return true;
  };

  const resetHistory = () => setHistoryState(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  const bumpEpoch = () => setInputEpoch((epoch) => epoch + 1);

  return { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange };
}
