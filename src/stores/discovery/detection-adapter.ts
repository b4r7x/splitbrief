import { detectionStore } from '../project/detection.js';
import { modelCacheStore } from './model-cache.js';
import { isProviderId } from '../../core/schemas/enums.js';
import type { DetectionDeps, DetectionServiceResult, DetectionService } from '../../engine/detection/service.js';

function applyToStores(result: DetectionServiceResult): void {
  detectionStore.setDetection(result.detection);
  if (result.catalog) modelCacheStore.setModelsDevCatalog(result.catalog);
  for (const [toolId, models] of Object.entries(result.cliModels)) {
    if (models && models.length > 0 && isProviderId(toolId)) {
      modelCacheStore.setProviderModels(toolId, models);
    }
  }
}

export async function loadDetectionIntoStores(service: DetectionService, deps: DetectionDeps, projectDir?: string): Promise<void> {
  const result = await service.loadDetection(deps, projectDir);
  applyToStores(result);
}

export async function refreshDetectionStores(service: DetectionService, projectDir: string | undefined): Promise<void> {
  modelCacheStore.invalidateAll();
  const result = await service.refreshDetection(projectDir);
  if (result) applyToStores(result);
}
