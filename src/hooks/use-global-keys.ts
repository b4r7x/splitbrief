import { useInput } from 'ink';
import { useCtrlC } from './use-ctrl-c.js';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { feedbackStore } from '../stores/error.js';
import { workflowStore } from '../stores/workflow.js';

const CANCEL_PHASES = new Set(['researching', 'specifying', 'reviewing-spec', 'planning', 'reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review']);

export function useGlobalKeys({ exit }: { exit: () => void }) {
  const screen = routerStore.use(s => s.screen);
  const isOpen = overlayStore.use(s => s.active) !== 'none';

  useCtrlC(screen, exit, feedbackStore.setError);

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
