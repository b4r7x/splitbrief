import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { installHistoryPersistence } from '../stores/ui/persistence.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { detectionStore } from '../stores/project/detection.js';
import { warnError, warnStderr } from '../lib/warn.js';
import { detectCapabilities } from '../engine/providers/capabilities.js';
import { detectAll } from '../engine/detection/detect.js';
import { getDefaultDetectionService } from '../engine/detection/service.js';
import { loadDetectionIntoStores } from '../stores/discovery/detection-adapter.js';
import { fetchModelsDevCatalog } from '../engine/providers/models-dev.js';
import { discoverAllCliTools } from '../engine/providers/discovery.js';
import { discoverSkills } from '../engine/skill-discovery.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import { cliError } from './errors.js';
import { getPlannerToolId } from '../core/config/accessors/runner-config.js';
import { ensureHooksTrusted } from './hook-trust-prompt.js';
import { resolveHooksConfig } from '../engine/hooks/discover.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';

let historyPersistenceTeardown: (() => void) | null = null;

export async function initStores(projectDir: string, opts: WorkflowOpts = {}): Promise<void> {
  initUIChrome();
  loadProjectState(projectDir, opts);
  const storeConfig = configStore.get().config;
  const mergedHooks = await resolveHooksConfig(projectDir, storeConfig?.hooks);
  await ensureHooksTrusted({
    projectDir,
    hooks: mergedHooks,
    allowHooks: opts.allowHooks ?? false,
  });
  await loadDiscovery(projectDir);
}

export function teardownStores(): void {
  historyPersistenceTeardown?.();
  historyPersistenceTeardown = null;
}

function initUIChrome(): void {
  terminalSizeStore.subscribeToResize();
}

function loadProjectState(projectDir: string, opts: WorkflowOpts): void {
  const rawMode = opts.mode as string | undefined;
  if (rawMode === 'full' && process.env.DIPTYCH_QUIET !== '1') {
    warnStderr('--mode full is deprecated; use --mode speckit');
  }
  const overrides = workflowOptsToCLIOverrides(opts);
  configStore.load(projectDir, overrides);
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  sessionsStore.load(projectDir);
  historyPersistenceTeardown = installHistoryPersistence();
}

async function loadDiscovery(projectDir: string): Promise<void> {
  const storeConfig = configStore.get().config;
  if (!storeConfig) return;

  try {
    const caps = await detectCapabilities(storeConfig);
    if (caps.origin === 'env' || caps.origin === 'detected' || caps.origin === 'catalog') {
      configStore.setContextLength(caps.contextLength, caps.origin !== 'env');
    }
  } catch (err) {
    warnError('Could not detect provider capabilities', err);
    feedbackStore.setMessage('Provider detection failed — using defaults');
  }

  await Promise.all([
    discoverSkills(getPlannerToolId(storeConfig.planner), projectDir).then((skills) => {
      skillsStore.setAvailable(skills);
    }),
    loadDetectionIntoStores(
      getDefaultDetectionService(),
      { detectAll, fetchModelsDevCatalog, discoverAllCliTools },
      detectionStore,
      projectDir,
    ),
  ]);
}
