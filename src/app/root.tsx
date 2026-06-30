import { useApp, useInput } from 'ink';
import { isConfiguredKeyDebugEnabled, logDiptychParsedKey } from '../core/key-debug.js';
import { AppProvider } from './provider.js';
import { Router } from './router.js';
import { useAppKeys } from './keys.js';
import { useRuntimeCommands } from './command-context.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { useStores } from '../stores/use-stores.js';
import { interruptTurn, requestCancel } from '../features/workflow/handlers.js';
import { useMouseScroll } from '../features/workflow/hooks/use-mouse-scroll.js';
import { usePointer } from '../features/workflow/hooks/use-mouse-pointer.js';

export function App() {
  const [{ screen }, { active: overlayActive }, { phase }] = useStores(
    routerStore,
    overlayStore,
    lifecycleStore,
  );
  const { exit } = useApp();
  const { commands, copyTarget, setWorkflowMode, handleRuntimeCommand } = useRuntimeCommands({
    exit,
    phase,
  });
  useAppKeys({ exit, interruptWorkflow: interruptTurn, cancelWorkflow: requestCancel });
  useMouseScroll();
  usePointer();
  useInput((input, key) => logDiptychParsedKey(input, key), {
    isActive: isConfiguredKeyDebugEnabled(),
  });

  return (
    <AppProvider>
      <Router
        screen={screen}
        overlayActive={overlayActive}
        commands={commands}
        onRuntime={handleRuntimeCommand}
        copyTarget={copyTarget}
        onWorkflowMode={setWorkflowMode}
      />
    </AppProvider>
  );
}
