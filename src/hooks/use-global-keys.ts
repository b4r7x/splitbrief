import { useRef } from 'react';
import { useInput } from 'ink';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { feedbackStore } from '../stores/feedback.js';
import { workflowStore } from '../stores/workflow.js';
import { killAllProcesses } from '../utils/process.js';

const CANCEL_PHASES = new Set(['researching', 'specifying', 'reviewing-spec', 'planning', 'reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review']);
const DOUBLE_PRESS_WINDOW = 3000;

export function useGlobalKeys({ exit }: { exit: () => void }) {
  const screen = routerStore.use(s => s.screen);
  const isOpen = overlayStore.use(s => s.active) !== 'none';
  const lastCtrlCRef = useRef(0);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (Date.now() - lastCtrlCRef.current < DOUBLE_PRESS_WINDOW) {
      exit();
      return;
    }
    lastCtrlCRef.current = Date.now();
    if (screen === 'workflow') {
      const { cancelled } = workflowStore.get();
      if (!cancelled) workflowStore.requestCancel();
      else killAllProcesses();
      feedbackStore.setError('Cancelling workflow... Ctrl+C to exit');
    } else {
      feedbackStore.setError('Press Ctrl+C again to exit');
    }
  });

  useInput(
    (input, key) => {
      if (key.escape && screen === 'workflow') {
        const { phase, cancelled } = workflowStore.get();
        if (cancelled) {
          routerStore.navigate('home');
          return;
        }
        if (CANCEL_PHASES.has(phase)) {
          workflowStore.requestCancel();
          return;
        }
      }
      if (key.ctrl && input === 'k') {
        overlayStore.open('command-palette');
        return;
      }
      if (key.ctrl && input === 's' && screen === 'home') {
        overlayStore.open('skills');
        return;
      }
      if (key.ctrl && input === 'i' && screen === 'home') {
        overlayStore.open('settings');
        return;
      }
      if (input === '\x1f') { // Ctrl+/
        overlayStore.open('help');
        return;
      }
      if (key.ctrl && input === ',') {
        overlayStore.open('settings');
        return;
      }
      if (key.ctrl && input === 'q') {
        exit();
        return;
      }
    },
    { isActive: !isOpen },
  );
}
