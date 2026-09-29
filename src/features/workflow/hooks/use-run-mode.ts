import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { modeAdviceStore } from '../../../stores/workflow/mode-advice.js';
import { resolveRunMode } from '../display/run-mode.js';

/** The one run-mode derivation every running surface and the rail's hit zones share. */
export function useRunMode(): WorkflowMode | null {
  const resolvedMode = modeAdviceStore.use((state) => state.mode);
  const savedMode = routerStore.use((state) =>
    state.screen === 'workflow' ? state.run.mode : null,
  );
  // The local execution's prepared config is the run's own; the store's config is the next
  // run's. A fresh run reads the former while it has neither a resolved nor a recorded mode.
  const preparedConfig = routerStore.use((state) =>
    state.screen === 'workflow' && state.execution.kind === 'local'
      ? state.execution.prepared.config
      : null,
  );
  const config = configStore.use((state) => state.config);
  return resolveRunMode({ resolvedMode, savedMode, preparedConfig, config });
}
