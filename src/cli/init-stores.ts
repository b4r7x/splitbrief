import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { installHistoryPersistence } from '../stores/ui/persistence.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { controlsStore } from '../stores/ui/controls.js';
import { readUiPrefs } from '../core/ui-prefs.js';
import { detectionStore } from '../stores/project/detection.js';
import { warnError } from '../lib/warn.js';
import { detectCapabilities } from '../engine/providers/capabilities.js';
import { getDefaultDetectionService } from '../engine/detection/service.js';
import {
  detectionContextsForCurrentConfig,
  loadDetectionForCurrentConfig,
} from '../engine/detection/store-publication.js';
import {
  hydrateDetectionIntoStores,
  hydrateModelsDevCatalogIntoStores,
} from '../stores/discovery/detection-adapter.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { loadRememberedPresentationSnapshot } from '../engine/detection/cache.js';
import { loadModelsDevCatalogCache } from '../engine/providers/models-dev-cache.js';
import { discoverSkills } from '../engine/skill-discovery.js';
import { initLogger } from '../core/logger.js';
import { createLogger } from '../lib/logger.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import { cliError } from './errors.js';
import { ensureHooksTrusted } from './hook-trust-prompt.js';
import { workflowOptsToCLIOverrides } from '../core/config/runtime/overrides/from-options.js';

let historyPersistenceTeardown: (() => void) | null = null;
const inFlightDiscovery = new Set<Promise<void>>();

function trackDiscovery(work: Promise<void>): void {
  inFlightDiscovery.add(work);
  void work.finally(() => inFlightDiscovery.delete(work));
}

/**
 * Settles the discovery work boot starts without awaiting — the models.dev
 * catalog seed and the live detection refresh, both of which write caches under
 * the state home. Boot never waits for it; a caller that is about to remove the
 * state home does.
 */
export async function awaitBackgroundDiscovery(): Promise<void> {
  while (inFlightDiscovery.size > 0) await Promise.all([...inFlightDiscovery]);
}

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
  historyPersistenceTeardown?.();
  historyPersistenceTeardown = null;
}

function initUIChrome(): void {
  terminalSizeStore.subscribeToResize();
}

function loadProjectState(projectDir: string, opts: WorkflowOpts): void {
  const overrides = workflowOptsToCLIOverrides(opts);
  configStore.load(projectDir, overrides);
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  sessionsStore.load(projectDir);
  historyPersistenceTeardown = installHistoryPersistence();
  const prefs = readUiPrefs(projectDir);
  controlsStore.setSidebar(prefs.sidebarVisible);
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

  const current = { config: storeConfig, projectDir };
  const contexts = detectionContextsForCurrentConfig(current);
  const remembered = await loadRememberedPresentationSnapshot({
    projectDir,
    contextKey: contexts.readiness,
  });
  if (remembered !== null) {
    hydrateDetectionIntoStores({
      detection: detectionStore,
      snapshot: remembered.snapshot,
      contexts,
      foreignContext: remembered.foreignContext,
    });
  }

  // For a tool with no native catalog — claude-code, the default planner —
  // models.dev is the only real model source, so the picker shows bundled
  // fallbacks until this lands. Nothing awaits it and it yields to any catalog
  // a live lane already delivered, so it races the refresh below safely.
  trackDiscovery(
    seedModelsDevCatalog().catch((err: unknown) => {
      warnError('Could not read the remembered model catalog', err);
    }),
  );

  trackDiscovery(
    loadDetectionForCurrentConfig({
      service: getDefaultDetectionService(),
      publication: detectionStore,
      current,
    }).catch((err: unknown) => {
      warnError('Could not refresh runner discovery', err);
    }),
  );

  const skills = await discoverSkills(projectDir);
  skillsStore.setAvailable(skills);
}

async function seedModelsDevCatalog(): Promise<void> {
  const snapshot = await loadModelsDevCatalogCache();
  if (snapshot === null) return;
  hydrateModelsDevCatalogIntoStores({ cache: modelCacheStore, snapshot });
}
