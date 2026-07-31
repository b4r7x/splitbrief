import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import type { CliToolId } from '../../core/schemas/enums.js';
import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../core/discovery/detection.js';

export interface DetectionProjection {
  providers: ProviderDetection[];
  cliTools: CliToolDetection[];
}

export interface DetectionDeps {
  detectAll(): Promise<DetectionProjection>;
  fetchModelsDevCatalog(): Promise<ModelsDevCatalog>;
  discoverAllCliTools(): Promise<Partial<Record<CliToolId, DetectedModel[]>>>;
}

export interface DetectionServiceResult extends DetectionProjection {
  catalog: ModelsDevCatalog | null;
  cliModels: Partial<Record<CliToolId, DetectedModel[]>>;
}

export interface DetectionService {
  loadDetection(deps: DetectionDeps, projectDir?: string): Promise<DetectionServiceResult>;
  refreshDetection(projectDir: string | undefined): Promise<DetectionServiceResult | null>;
}

const EMPTY_CLI_MODELS: Partial<Record<CliToolId, DetectedModel[]>> = {};

export function createDetectionService() {
  let pendingSave: Promise<void> = Promise.resolve();
  let lastDeps: DetectionDeps | undefined;

  async function loadDetection(
    deps: DetectionDeps,
    projectDir?: string,
  ): Promise<DetectionServiceResult> {
    lastDeps = deps;
    let detection: DetectionProjection;
    let shouldPersist = false;

    if (projectDir) {
      const cached = await loadDetectionCache(projectDir);
      if (cached) {
        detection = cached;
      } else {
        shouldPersist = true;
        detection = await deps.detectAll();
      }
    } else {
      detection = await deps.detectAll();
    }

    const [catalog, cliModels] = await Promise.all([
      deps.fetchModelsDevCatalog().catch(() => null),
      deps.discoverAllCliTools().catch(() => EMPTY_CLI_MODELS),
    ]);

    if (projectDir && shouldPersist) {
      pendingSave = pendingSave.then(() =>
        saveDetectionCache(projectDir, detection.providers, detection.cliTools).catch(() => {}),
      );
    }

    return { ...detection, catalog, cliModels };
  }

  async function invalidateDetection(projectDir: string): Promise<void> {
    await invalidateCache(projectDir);
  }

  async function refreshDetection(
    projectDir: string | undefined,
  ): Promise<DetectionServiceResult | null> {
    if (!lastDeps) return null;
    if (projectDir) await invalidateCache(projectDir).catch(() => {});
    return loadDetection(lastDeps, projectDir);
  }

  function getPendingSave(): Promise<void> {
    return pendingSave;
  }

  return { loadDetection, invalidateDetection, refreshDetection, getPendingSave };
}

const defaultService = createDetectionService();

export function getDefaultDetectionService(): DetectionService {
  return defaultService;
}
