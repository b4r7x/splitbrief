import { useInput } from 'ink';
import { useCtrlC } from './use-ctrl-c.js';
import type { Screen, OverlayType } from '../types.js';

interface UseGlobalKeysOptions {
  screen: Screen;
  overlay: { isOpen: boolean; open: (t: OverlayType) => void; close: () => void };
  exit: () => void;
  setErrorMessage: (msg: string | null) => void;
}

export function useGlobalKeys({ screen, overlay, exit, setErrorMessage }: UseGlobalKeysOptions) {
  useCtrlC(screen, exit, setErrorMessage);

  useInput((input, key) => {
    if (key.escape) {
      if (overlay.isOpen) overlay.close();
      return;
    }

    if (overlay.isOpen) return;

    if (key.ctrl && input === 'k') {
      overlay.open('command-palette');
      return;
    }
    if (key.ctrl && input === 's' && screen === 'home') {
      overlay.open('skills');
      return;
    }
    if (key.ctrl && input === 'i' && screen === 'home') {
      overlay.open('picker');
      return;
    }
    if (key.ctrl && input === '/') {
      overlay.open('help');
      return;
    }
    if (key.ctrl && input === 'q') {
      exit();
      return;
    }
  });
}
