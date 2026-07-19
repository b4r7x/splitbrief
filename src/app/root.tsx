import { useApp, useInput } from 'ink';
import { isConfiguredKeyDebugEnabled, logDiptychParsedKey } from '../core/key-debug.js';
import { AppProvider } from './provider.js';
import { Router } from './router.js';
import { useAppKeys } from './keys.js';
import { useRuntimeCommands } from './command-context.js';
import { useAppMouse } from './mouse.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { useStores } from '../stores/use-stores.js';
import { interruptTurn, requestCancel } from '../features/workflow/handlers.js';
import type { WorkflowScreenDeps } from '../features/workflow/hooks/use-workflow-screen.js';

export interface AppProps {
  readonly workflowDeps?: WorkflowScreenDeps | undefined;
}

export function App({ workflowDeps }: AppProps = {}) {
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
  useAppMouse();
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
        workflowDeps={workflowDeps}
      />
    </AppProvider>
  );
}
