import { useRef } from 'react';
import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
// engine bridge: abortTurn fires through the handler registry, not a feature-internal function
import { abortTurn } from '../features/workflow/handlers.js';
import { abortStore } from '../stores/workflow/abort.js';
import { killAllProcesses } from '../lib/process/registry.js';
import { isLivePhase } from '../core/phases.js';
import { useStores } from '../stores/use-stores.js';
import type { OverlayType, Screen } from '../stores/navigation/router.js';

const DOUBLE_PRESS_WINDOW_MS = 2000;

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };

function applyAction(action: AppKeyAction, exit: () => void) {
  switch (action.type) {
    case 'none': return;
    case 'exit': exit(); return;
    case 'open-overlay': overlayStore.open(action.overlay); return;
  }
}

export function useAppKeys({ exit }: { exit: () => void }) {
  const [route, overlay] = useStores(routerStore, overlayStore);
  const { screen } = route;
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const overlayHasStack = overlay.stack.length > 0;
  const lastCtrlCRef = useRef(0);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (route.screen === 'workflow' && route.attach) {
      exit();
      return;
    }
    if (Date.now() - lastCtrlCRef.current < DOUBLE_PRESS_WINDOW_MS) {
      exit();
      return;
    }
    if (screen === 'workflow') {
      const { phase, cancelled } = lifecycleStore.get();
      if (!cancelled && isLivePhase(phase)) {
        lastCtrlCRef.current = Date.now();
        abortStore.markPending();
        abortTurn();
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
      const shortcut = handleShortcutKeys(input, key, screen);
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
