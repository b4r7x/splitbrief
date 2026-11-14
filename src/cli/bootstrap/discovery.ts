import { configStore } from '../../stores/project/config.js';
import { skillsStore } from '../../stores/project/skills.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { warnError } from '../../lib/warn.js';
import { detectCapabilities } from '../../engine/providers/capabilities.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import {
  detectionContextsForCurrentConfig,
  loadDetectionForCurrentConfig,
  refreshDetectionForCurrentConfig,
} from '../../engine/detection/store-publication.js';
import { listsProjectProvidersOnRequest } from '../../engine/detection/route-catalog.js';
import { crewCliTools } from '../../core/crew/seats.js';
import { isCliToolId } from '../../core/runners/cli-tool/catalog.js';
import {
  hydrateDetectionIntoStores,
  hydrateModelsDevCatalogIntoStores,
} from '../../stores/discovery/detection-adapter.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedPresentationSnapshot } from '../../engine/detection/cache/store.js';
import { loadModelsDevCatalogCache } from '../../engine/providers/models-dev/cache.js';
import { discoverSkills } from '../../engine/skills/discover.js';
import type { Config } from '../../core/schemas/config.js';
import { loadConfig } from '../../core/config/load/io.js';

const inFlightDiscovery = new Set<Promise<void>>();
let crewWatchTeardown: (() => void) | null = null;

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
  teardownDiscovery();
  let watchCancelled = false;
  crewWatchTeardown = () => {
    watchCancelled = true;
  };

  await storeContextLength(storeConfig);

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
    })
      .catch((err: unknown) => {
        warnError('Could not check your tools', err, 'feedback');
      })
      .then(async () => {
        if (watchCancelled) return;
        crewWatchTeardown = watchCrewForProjectListing(storeConfig);
        // A CLI build seat's window is in its tool's own listing, which the cache holds only
        // now. Reading it again keeps the window boot stored equal to the one a run reads.
        if (storeConfig.implementer.kind === 'cli' && configStore.buildsOnLoadedSeat(storeConfig)) {
          await storeContextLength(storeConfig);
        }
      }),
  );

  const skills = await discoverSkills(projectDir);
  skillsStore.setAvailable(skills);
}

/** Stores the build seat's context length, read through the model cache a run reads. */
async function storeContextLength(config: Config): Promise<void> {
  try {
    const caps = await detectCapabilities(config, modelCacheStore);
    if (caps !== undefined && caps.origin !== 'config')
      configStore.setDetectedContextLength(caps.contextLength);
  } catch (err) {
    warnError('Could not detect provider capabilities', err);
  }
}

export function teardownDiscovery(): void {
  crewWatchTeardown?.();
  crewWatchTeardown = null;
}

/**
 * A tool whose model list carries the project's own providers only when the read names the project
 * was listed without them while it sat outside the crew of the start-up read. When the crew gains
 * it — on a seat or as a fallback — the lists are read again, as `/refresh` does. The watch starts
 * when the start-up read settles and first compares that read's crew with the current one: a read
 * started earlier would supersede a newer one, so a change made during it waits for it.
 */
function watchCrewForProjectListing(loadedConfig: Config): () => void {
  let previous = crewCliTools(loadedConfig);
  const refreshOnGain = () => {
    const config = configStore.get().config;
    const current = config === null ? new Set<string>() : crewCliTools(config);
    const gained = [...current].some(
      (tool) => !previous.has(tool) && isCliToolId(tool) && listsProjectProvidersOnRequest(tool),
    );
    previous = current;
    if (!gained) return;
    trackDiscovery(
      refreshDetectionForCurrentConfig({
        service: getDefaultDetectionService(),
        publication: detectionStore,
        getCurrent: () => {
          const { config, projectDir } = configStore.get();
          return config === null ? null : { config, projectDir };
        },
      }).then(
        () => undefined,
        (err: unknown) => {
          warnError('Could not check your tools', err, 'feedback');
        },
      ),
    );
  };
  refreshOnGain();
  return configStore.subscribe(refreshOnGain);
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
 * Loads the remembered model rows without tool probes.
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
