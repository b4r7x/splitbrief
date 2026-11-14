import { configStore } from '../../stores/project/config.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { initLogger } from '../../core/logger.js';
import { createLogger } from '../../lib/logger.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { loadDiscovery, teardownDiscovery } from './discovery.js';
import { workflowOptsToCLIOverrides } from '../../core/config/runtime/overrides/from-options.js';
import { readUiPrefs } from '../../core/settings/ui-prefs.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { installHistoryPersistence } from '../../stores/ui/input-history-persistence.js';
import { cliError } from '../errors.js';

export function bootstrapStoresSync(projectDir: string, opts: WorkflowOpts = {}): void {
  initLogger(projectDir);
  createLogger('bootstrap').info('stores bootstrap', { projectDir });
  initUIChrome();
  loadProjectState(projectDir, opts);
}

export async function bootstrapStoresHooks(
  projectDir: string,
  opts: WorkflowOpts = {},
): Promise<void> {
  const storeConfig = configStore.get().config;
  await ensureHooksTrusted({
    projectDir,
    hooks: storeConfig?.hooks,
    allowHooks: opts.allowHooks ?? false,
  });
}

export async function initStoresForTuiMount(
  projectDir: string,
  opts: WorkflowOpts = {},
): Promise<{ awaitDiscovery: Promise<void> }> {
  bootstrapStoresSync(projectDir, opts);
  await bootstrapStoresHooks(projectDir, opts);
  return { awaitDiscovery: loadDiscovery(projectDir) };
}

export async function initStores(projectDir: string, opts: WorkflowOpts = {}): Promise<void> {
  bootstrapStoresSync(projectDir, opts);
  await bootstrapStoresHooks(projectDir, opts);
  await loadDiscovery(projectDir);
}

export function teardownStores(): void {
  teardownProjectState();
  teardownDiscovery();
}

function initUIChrome(): void {
  terminalSizeStore.subscribeToResize();
}

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
