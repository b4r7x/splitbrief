import { loadDetectionCache, saveDetectionCache, invalidateCache } from '../../core/detection/index.js';
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

let _pendingSave: Promise<void> = Promise.resolve();
let _lastDeps: DetectionDeps | undefined;

export async function loadDetection(deps: DetectionDeps, projectDir?: string): Promise<DetectionServiceResult> {
  _lastDeps = deps;
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
    _pendingSave = _pendingSave.then(() => saveDetectionCache(projectDir, detection.planners, detection.implementers).catch(() => {}));
  }

  return { detection, catalog, cliModels };
}

export async function invalidateDetection(projectDir: string): Promise<void> {
  await invalidateCache(projectDir);
}

export async function refreshDetection(projectDir: string | undefined): Promise<DetectionServiceResult | null> {
  if (!_lastDeps) return null;
  if (projectDir) await invalidateCache(projectDir).catch(() => {});
  return loadDetection(_lastDeps, projectDir);
}

/** Resolves when the last fire-and-forget cache save completes. Test-only. */
export function getPendingSave(): Promise<void> {
  return _pendingSave;
}

/** Reset module-level state. Test-only. */
export function resetServiceState(): void {
  _pendingSave = Promise.resolve();
  _lastDeps = undefined;
}
