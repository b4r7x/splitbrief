import { useRef } from 'react';
import { useInput } from 'ink';
import { killAllProcesses } from '../utils/process.js';
import type { Screen } from '../types.js';

const DOUBLE_PRESS_WINDOW = 3000;

export function useCtrlC(
  screen: Screen,
  exit: () => void,
  setErrorMessage: (msg: string | null) => void,
) {
  const lastPressRef = useRef(0);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;

    if (Date.now() - lastPressRef.current < DOUBLE_PRESS_WINDOW) {
      exit();
      return;
    }

    lastPressRef.current = Date.now();
    if (screen === 'workflow') killAllProcesses();
    setErrorMessage('Press Ctrl+C again to exit');
  });
}
