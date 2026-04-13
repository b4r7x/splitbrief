import { createStore, storeBase } from './create-store.js';
import type { PlannerDetection, ProviderDetection } from '../types.js';
import { loadDetectionCache, saveDetectionCache, invalidateCache } from '../core/detection/index.js';
import { modelCacheStore } from './model-cache.js';
import { isProviderId } from '../core/providers.js';
import type { DetectAllResult } from '../engine/detection/detect.js';
import type { ModelsDevCatalog } from '../engine/providers/models-dev.js';
import type { CliToolId } from '../core/types/schemas/enums.js';
import type { DetectedModel } from '../core/types/config.js';

interface DetectionState {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

export interface DetectionDeps {
  detectAll(): Promise<DetectAllResult>;
  fetchModelsDevCatalog(): Promise<ModelsDevCatalog>;
  discoverAllCliTools(): Promise<Partial<Record<CliToolId, DetectedModel[]>>>;
}

const initial: DetectionState = {
  planners: [],
  implementers: [],
};

const store = createStore<DetectionState>(initial);

let _pendingSave: Promise<void> = Promise.resolve();
let _lastDeps: DetectionDeps | undefined;

async function load(deps: DetectionDeps, projectDir?: string): Promise<void> {
  _lastDeps = deps;
  let detectionResult: DetectionState;
  let shouldPersist = false;

  if (projectDir) {
    const cached = await loadDetectionCache(projectDir);
    if (cached) {
      store.set(cached);
      detectionResult = cached;
    } else {
      shouldPersist = true;
      detectionResult = await deps.detectAll();
      store.set(detectionResult);
    }
  } else {
    // detectAll() shares provider detection results between planner and implementer detection,
    // avoiding redundant network calls (~40s saved)
    detectionResult = await deps.detectAll();
    store.set(detectionResult);
  }

  const [catalog, cliModels] = await Promise.all([
    deps.fetchModelsDevCatalog().catch(() => null),
    deps.discoverAllCliTools().catch(() => ({})),
  ]);

  if (catalog) modelCacheStore.setModelsDevCatalog(catalog);
  for (const [toolId, models] of Object.entries(cliModels)) {
    if (models.length > 0 && isProviderId(toolId)) modelCacheStore.setProviderModels(toolId, models);
  }

  if (projectDir && shouldPersist) {
    _pendingSave = _pendingSave.then(() => saveDetectionCache(projectDir, detectionResult.planners, detectionResult.implementers).catch(() => {}));
  }
}

async function invalidate(projectDir: string): Promise<void> {
  await invalidateCache(projectDir);
}

async function refresh(projectDir: string | undefined): Promise<void> {
  if (!_lastDeps) return;
  if (projectDir) await invalidateCache(projectDir).catch(() => {});
  modelCacheStore.invalidateAll();
  await load(_lastDeps, projectDir);
}

export const detectionStore = {
  ...storeBase(store),
  load,
  invalidate,
  refresh,
  /** Resolves when the last fire-and-forget cache save completes. Test-only. */
  get _pendingSave() { return _pendingSave; },
};
