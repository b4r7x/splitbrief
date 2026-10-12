import { configStore } from '../../stores/project/config.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { installHistoryPersistence } from '../../stores/ui/persistence.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { readUiPrefs } from '../../core/ui-prefs.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import { cliError } from '../errors.js';
import { workflowOptsToCLIOverrides } from '../../core/config/runtime/overrides/from-options.js';

let historyPersistenceTeardown: (() => void) | null = null;

export function loadProjectState(projectDir: string, opts: WorkflowOpts): void {
  const overrides = workflowOptsToCLIOverrides(opts);
  configStore.load(projectDir, overrides);
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  sessionsStore.load(projectDir);
  historyPersistenceTeardown = installHistoryPersistence();
  const prefs = readUiPrefs(projectDir);
  controlsStore.setSidebar(prefs.sidebarVisible);
}

export function teardownProjectState(): void {
  historyPersistenceTeardown?.();
  historyPersistenceTeardown = null;
}
