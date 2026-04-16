import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import type { DetectAllResult } from './detect.js';
import type { ModelsDevCatalog } from '../providers/models-dev.js';
import type { CliToolId } from '../../core/types/schemas/enums.js';
import type { DetectedModel } from '../../core/types/config.js';

export interface DetectionDeps {
  detectAll(): Promise<DetectAllResult>;
  fetchModelsDevCatalog(): Promise<ModelsDevCatalog>;
  discoverAllCliTools(): Promise<Partial<Record<CliToolId, DetectedModel[]>>>;
}

export interface DetectionServiceResult {
  detection: { planners: DetectAllResult['planners']; implementers: DetectAllResult['implementers'] };
  catalog: ModelsDevCatalog | null;
  cliModels: Partial<Record<CliToolId, DetectedModel[]>>;
}

export interface DetectionService {
  loadDetection(deps: DetectionDeps, projectDir?: string): Promise<DetectionServiceResult>;
  invalidateDetection(projectDir: string): Promise<void>;
  refreshDetection(projectDir: string | undefined): Promise<DetectionServiceResult | null>;
  getPendingSave(): Promise<void>;
}

export function createDetectionService(): DetectionService {
  let pendingSave: Promise<void> = Promise.resolve();
  let lastDeps: DetectionDeps | undefined;

  async function loadDetection(deps: DetectionDeps, projectDir?: string): Promise<DetectionServiceResult> {
    lastDeps = deps;
    let detection: DetectionServiceResult['detection'];
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
      deps.discoverAllCliTools().catch(() => ({} as Partial<Record<CliToolId, DetectedModel[]>>)),
    ]);

    if (projectDir && shouldPersist) {
      pendingSave = pendingSave.then(() => saveDetectionCache(projectDir, detection.planners, detection.implementers).catch(() => {}));
    }

    return { detection, catalog, cliModels };
  }

  async function invalidateDetection(projectDir: string): Promise<void> {
    await invalidateCache(projectDir);
  }

  async function refreshDetection(projectDir: string | undefined): Promise<DetectionServiceResult | null> {
    if (!lastDeps) return null;
    if (projectDir) await invalidateCache(projectDir).catch(() => {});
    return loadDetection(lastDeps, projectDir);
  }

  function getPendingSave(): Promise<void> {
    return pendingSave;
  }

  return { loadDetection, invalidateDetection, refreshDetection, getPendingSave };
}

const _defaultService = createDetectionService();

export const loadDetection = _defaultService.loadDetection.bind(_defaultService);
export const invalidateDetection = _defaultService.invalidateDetection.bind(_defaultService);
export const refreshDetection = _defaultService.refreshDetection.bind(_defaultService);
export const getPendingSave = _defaultService.getPendingSave.bind(_defaultService);
