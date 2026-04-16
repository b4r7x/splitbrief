import { loadDetection, refreshDetection } from '../engine/detection/service.js';
import { detectionStore } from './detection.js';
import { modelCacheStore } from './model-cache.js';
import { isProviderId } from '../core/providers.js';
import type { DetectionDeps, DetectionServiceResult, DetectionService } from '../engine/detection/service.js';

function applyToStores(result: DetectionServiceResult): void {
  detectionStore.setDetection(result.detection);
  if (result.catalog) modelCacheStore.setModelsDevCatalog(result.catalog);
  for (const [toolId, models] of Object.entries(result.cliModels)) {
    if (models && models.length > 0 && isProviderId(toolId)) {
      modelCacheStore.setProviderModels(toolId, models);
    }
  }
}

export async function loadDetectionIntoStores(deps: DetectionDeps, projectDir?: string, service?: DetectionService): Promise<void> {
  const fn = service?.loadDetection ?? loadDetection;
  const result = await fn(deps, projectDir);
  applyToStores(result);
}

export async function refreshDetectionStores(projectDir: string | undefined): Promise<void> {
  modelCacheStore.invalidateAll();
  const result = await refreshDetection(projectDir);
  if (result) applyToStores(result);
}
