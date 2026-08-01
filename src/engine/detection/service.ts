import { loadDetectionCache, saveDetectionCache, invalidateCache } from './cache.js';
import type { ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type {
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import { includes } from '../../utils/type-guards.js';

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

function cloneCliToolDetection(cli: CliToolDetection): CliToolDetection {
  return {
    tool: cli.tool,
    trust: cli.trust,
    installedVersion: cli.installedVersion,
    testedVersion: cli.testedVersion,
    compatibility: cli.compatibility,
    auth: cli.auth,
    probedAt: cli.probedAt,
    executable: cli.executable
      ? {
          path: cli.executable.path,
          fingerprint: { ...cli.executable.fingerprint },
        }
      : null,
    diagnostic:
      cli.diagnostic.state === 'ready'
        ? { state: 'ready', remediation: null }
        : { state: cli.diagnostic.state, remediation: cli.diagnostic.remediation },
  };
}

function cloneProviderDetection(provider: ProviderDetection): ProviderDetection {
  return {
    ...provider,
    ...(provider.models ? { models: provider.models.map(cloneDetectedModel) } : {}),
  };
}

function cloneProjection(detection: DetectionProjection): DetectionProjection {
  return {
    providers: detection.providers.map(cloneProviderDetection),
    cliTools: detection.cliTools.map(cloneCliToolDetection),
  };
}

function cloneCliModels(
  cliModels: Partial<Record<CliToolId, DetectedModel[]>>,
): Partial<Record<CliToolId, DetectedModel[]>> {
  const cloned: Partial<Record<CliToolId, DetectedModel[]>> = {};
  for (const [toolId, models] of Object.entries(cliModels)) {
    if (models && includes(CLI_TOOL_IDS, toolId)) {
      cloned[toolId] = models.map(cloneDetectedModel);
    }
  }
  return cloned;
}

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
        detection = cloneProjection(cached);
      } else {
        shouldPersist = true;
        detection = cloneProjection(await deps.detectAll());
      }
    } else {
      detection = cloneProjection(await deps.detectAll());
    }

    const [catalog, cliModels] = await Promise.all([
      deps.fetchModelsDevCatalog().catch(() => null),
      deps.discoverAllCliTools().catch(() => EMPTY_CLI_MODELS),
    ]);

    if (projectDir && shouldPersist) {
      const snapshot = cloneProjection(detection);
      pendingSave = pendingSave.then(() =>
        saveDetectionCache(projectDir, snapshot.providers, snapshot.cliTools).catch(() => {}),
      );
    }

    return {
      providers: detection.providers,
      cliTools: detection.cliTools,
      catalog: catalog ? structuredClone(catalog) : null,
      cliModels: cloneCliModels(cliModels),
    };
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
