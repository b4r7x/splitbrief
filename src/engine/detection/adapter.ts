import { loadDetection, refreshDetection } from './service.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { isProviderId } from '../../core/types/schemas/enums.js';
import type { DetectionDeps, DetectionServiceResult, DetectionService } from './service.js';

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
