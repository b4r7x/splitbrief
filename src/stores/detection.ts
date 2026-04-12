import { createStore, storeBase } from './create-store.js';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from '../core/detection/index.js';
import { detectAll } from '../engine/detection/index.js';
import { fetchModelsDevCatalog } from '../engine/providers/models-dev.js';
import { discoverAllCliTools } from '../engine/providers/discovery.js';
import { modelCacheStore } from './model-cache.js';
import { isProviderId } from '../core/providers.js';

interface DetectionState {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

const initial: DetectionState = {
  planners: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

let _pendingSave: Promise<void> = Promise.resolve();

async function load(projectDir?: string): Promise<void> {
  if (projectDir) {
    const cached = await loadDetectionCache(projectDir);
    if (cached) {
      store.set(cached);
      return;
    }
  }

  // detectAll() shares provider detection results between planner and implementer detection,
  // avoiding redundant network calls (~40s saved)
  const [{ planners, implementers }, catalog, cliModels] = await Promise.all([
    detectAll(),
    fetchModelsDevCatalog().catch(() => null),
    discoverAllCliTools().catch(() => ({})),
  ]);
  store.set({ planners, implementers });

  if (catalog) modelCacheStore.setModelsDevCatalog(catalog);
  for (const [toolId, models] of Object.entries(cliModels)) {
    if (models.length > 0 && isProviderId(toolId)) modelCacheStore.setProviderModels(toolId, models);
  }

  if (projectDir) {
    _pendingSave = _pendingSave.then(() => saveDetectionCache(projectDir, planners, implementers).catch(() => {}));
  }
}

async function invalidate(projectDir: string): Promise<void> {
  await invalidateCache(projectDir);
}

export const detectionStore = {
  ...storeBase(store),
  load,
  invalidate,
  /** Resolves when the last fire-and-forget cache save completes. Test-only. */
  get _pendingSave() { return _pendingSave; },
};
