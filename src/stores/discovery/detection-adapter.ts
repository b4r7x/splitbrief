import { modelCacheStore } from './model-cache.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { isProviderId } from '../../core/schemas/enums.js';
import type {
  DetectionDeps,
  DetectionServiceResult,
  DetectionService,
} from '../../engine/detection/service.js';

export interface DetectionStoreWriter {
  setDetection: (detection: {
    cliTools: CliToolDetection[];
    implementers: ProviderDetection[];
  }) => void;
}

function applyToStores(result: DetectionServiceResult, detection: DetectionStoreWriter): void {
  detection.setDetection({
    cliTools: result.cliTools,
    implementers: result.providers,
  });
  if (result.catalog) modelCacheStore.setModelsDevCatalog(result.catalog);
  for (const [toolId, models] of Object.entries(result.cliModels)) {
    if (models && models.length > 0 && isProviderId(toolId)) {
      modelCacheStore.setProviderModels(toolId, models);
    }
  }
}

export async function loadDetectionIntoStores(
  service: DetectionService,
  deps: DetectionDeps,
  detection: DetectionStoreWriter,
  projectDir?: string,
): Promise<void> {
  const result = await service.loadDetection(deps, projectDir);
  applyToStores(result, detection);
}

export async function refreshDetectionStores(
  service: DetectionService,
  detection: DetectionStoreWriter,
  projectDir: string | undefined,
): Promise<void> {
  modelCacheStore.invalidateAll();
  const result = await service.refreshDetection(projectDir);
  if (result) applyToStores(result, detection);
}
