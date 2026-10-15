import { configStore } from '../../stores/project/config.js';
import { skillsStore } from '../../stores/project/skills.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { warnError } from '../../lib/warn.js';
import { detectCapabilities } from '../../engine/providers/capabilities.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import {
  detectionContextsForCurrentConfig,
  loadDetectionForCurrentConfig,
} from '../../engine/detection/store-publication.js';
import {
  hydrateDetectionIntoStores,
  hydrateModelsDevCatalogIntoStores,
} from '../../stores/discovery/detection-adapter.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedPresentationSnapshot } from '../../engine/detection/cache.js';
import { loadModelsDevCatalogCache } from '../../engine/providers/models-dev-cache.js';
import { discoverSkills } from '../../engine/skill-discovery.js';
import type { Config } from '../../core/schemas/config.js';
import { loadConfig } from '../../core/config/load/io.js';

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

export async function loadDiscovery(projectDir: string): Promise<void> {
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
  await hydrateRememberedDetection(current);

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

async function hydrateRememberedDetection(
  current: Readonly<{ config: Config; projectDir: string }>,
): Promise<void> {
  const contexts = detectionContextsForCurrentConfig(current);
  const remembered = await loadRememberedPresentationSnapshot({
    projectDir: current.projectDir,
    contextKey: contexts.readiness,
  });
  if (remembered === null) return;
  hydrateDetectionIntoStores({
    detection: detectionStore,
    snapshot: remembered.snapshot,
    contexts,
    foreignContext: remembered.foreignContext,
  });
}

/**
 * Loads presentation labels without tool probes.
 */
export async function loadRememberedCatalog(projectDir: string): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(projectDir).config;
  } catch (err) {
    warnError('Could not load model names', err);
    return;
  }
  await hydrateRememberedDetection({ config, projectDir });
  await seedModelsDevCatalog();
}

async function seedModelsDevCatalog(): Promise<void> {
  const snapshot = await loadModelsDevCatalogCache();
  if (snapshot === null) return;
  hydrateModelsDevCatalogIntoStores({ cache: modelCacheStore, snapshot });
}
