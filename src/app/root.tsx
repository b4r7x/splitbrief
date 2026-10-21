import { useApp, useInput } from 'ink';
import { useEffect } from 'react';
import { isConfiguredKeyDebugEnabled, logSplitbriefParsedKey } from '../core/key-debug.js';
import { AppProvider } from './provider.js';
import { Router } from './router.js';
import { useAppKeys } from './keys.js';
import { useRuntimeCommands } from './command-context.js';
import { useAppMouse } from './mouse.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { useStores } from '../stores/use-stores.js';
import { sessionSelectStore } from '../stores/navigation/session-select.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { APPLY_RUNNING_REFUSAL } from '../core/runtime/commands/messages.js';
import {
  activeApply,
  onActiveApplyChange,
} from '../engine/orchestrator/session-lifecycle/shutdown.js';

import type { WorkflowScreenDeps } from '../features/workflow/hooks/workflow-screen/use-model.js';
import type { HomeScreenDeps } from './screens/home.js';
import type { SetupScreenDeps } from './screens/setup.js';
import type { PickerEffectDeps } from '../features/runners/use-picker-actions.js';
import type { AppKeyDeps } from './keys.js';
import type { RuntimeCommandContext } from '../core/runtime/commands/types.js';
import type { readClipboardImage } from '../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../lib/file-listing.js';

/**
 * Every effect the interactive surfaces reach for, named at the one place that composes
 * them. Supplying it is all-or-nothing: a supplied object is used as given and is never
 * merged with the production ports, and omitting it leaves every surface on its own
 * default — which is what the production mount and the visual gallery do.
 */
export interface AppInteractionDeps {
  readonly home: HomeScreenDeps;
  readonly setup: SetupScreenDeps;
  readonly runtimeContext: () => RuntimeCommandContext;
  readonly keys: AppKeyDeps;
  readonly picker: PickerEffectDeps;
  readonly readClipboardImage: typeof readClipboardImage;
  readonly listProjectFiles: typeof listProjectFiles;
}

/** A refusal that says Apply is still writing is false once Apply ends, so it leaves every surface then. */
function clearApplyRefusals(): void {
  if (activeApply() !== undefined) return;
  if (feedbackStore.get().message?.startsWith(APPLY_RUNNING_REFUSAL)) feedbackStore.reset();
  if (sessionSelectStore.get().error?.startsWith(APPLY_RUNNING_REFUSAL)) {
    sessionSelectStore.clearError();
  }
}

export interface AppProps {
  readonly workflowDeps?: WorkflowScreenDeps | undefined;
  readonly interactionDeps?: AppInteractionDeps | undefined;
}

export function App({ workflowDeps, interactionDeps }: AppProps = {}) {
  const [{ screen }, { active: overlayActive }, { phase }] = useStores(
    routerStore,
    overlayStore,
    lifecycleStore,
  );
  const { exit } = useApp();
  const { commands, handleRuntimeCommand } = useRuntimeCommands({
    exit,
    phase,
    createContext: interactionDeps?.runtimeContext,
  });
  useAppKeys({ exit, deps: interactionDeps?.keys });
  useAppMouse();
  useEffect(() => onActiveApplyChange(clearApplyRefusals), []);
  useInput((input, key) => logSplitbriefParsedKey(input, key), {
    isActive: isConfiguredKeyDebugEnabled(),
  });

  return (
    <AppProvider>
      <Router
        screen={screen}
        overlayActive={overlayActive}
        commands={commands}
        onRuntime={handleRuntimeCommand}
        workflowDeps={workflowDeps}
        interactionDeps={interactionDeps}
      />
    </AppProvider>
  );
}
