import { useRef } from 'react';
import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { killAllProcesses } from '../lib/process/registry.js';
import { isLivePhase } from '../core/phases.js';
import { useStores } from '../stores/use-stores.js';
import type { OverlayType, Screen } from '../core/navigation/types.js';

const DOUBLE_PRESS_WINDOW_MS = 2000;

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };
const noop = () => {};

interface UseAppKeysOptions {
  exit: () => void;
  abortWorkflow?: (() => void) | undefined;
}

function applyAction(action: AppKeyAction, exit: () => void) {
  switch (action.type) {
    case 'none': return;
    case 'exit': exit(); return;
    case 'open-overlay': overlayStore.open(action.overlay); return;
  }
}

export function useAppKeys({ exit, abortWorkflow = noop }: UseAppKeysOptions) {
  const [route, overlay] = useStores(routerStore, overlayStore);
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const overlayHasStack = overlay.stack.length > 0;
  const lastCtrlCRef = useRef(0);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    const currentScreen = route.screen;
    if (currentScreen === 'workflow' && route.attach) {
      exit();
      return;
    }
    if (lastCtrlCRef.current > 0 && Date.now() - lastCtrlCRef.current < DOUBLE_PRESS_WINDOW_MS) {
      exit();
      return;
    }
    if (currentScreen === 'workflow') {
      const { phase, cancelled } = lifecycleStore.get();
      if (!cancelled && isLivePhase(phase)) {
        lastCtrlCRef.current = Date.now();
        abortStore.markPending();
        abortWorkflow();
        killAllProcesses();
        feedbackStore.setMessage('Aborting… Ctrl+C again to exit');
      } else {
        exit();
      }
    } else {
      exit();
    }
  });

  useInput(
    (_input, key) => {
      if (key.escape) overlayStore.close();
    },
    { isActive: isOpen && !overlayExclusive && !overlayHasStack },
  );

  useInput(
    (input, key) => {
      const shortcut = handleShortcutKeys(input, key, route.screen);
      if (shortcut.type !== 'none') { applyAction(shortcut, exit); return; }
    },
    { isActive: !isOpen },
  );
}

function handleShortcutKeys(
  input: string,
  key: Key,
  screen: Screen,
): AppKeyAction {
  if (key.ctrl && input === 'k') return { type: 'open-overlay', overlay: 'command-palette' };
  if (key.ctrl && input === 's' && screen === 'home') return { type: 'open-overlay', overlay: 'skills' };
  if (key.ctrl && input === 'i' && screen === 'home') return { type: 'open-overlay', overlay: 'settings' };
  if (input === '\x1f') return { type: 'open-overlay', overlay: 'help' }; // Ctrl+/
  if (key.ctrl && input === ',') return { type: 'open-overlay', overlay: 'settings' };
  if (key.ctrl && input === 'q') return { type: 'exit' };
  return NONE;
}
