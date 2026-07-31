import { modelCacheStore } from './model-cache.js';
import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type {
  CliToolDetection,
  PlannerDetection,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG, cliToolSupportsRole } from '../../core/runners/cli-tool-catalog.js';
import { isPlannerToolId, isProviderId } from '../../core/schemas/enums.js';
import type {
  DetectionDeps,
  DetectionServiceResult,
  DetectionService,
} from '../../engine/detection/service.js';

export interface DetectionStoreWriter {
  setDetection: (detection: {
    planners: PlannerDetection[];
    implementers: ProviderDetection[];
  }) => void;
}

function projectPlanner(cliTool: CliToolDetection): PlannerDetection | null {
  if (!cliToolSupportsRole(cliTool.tool, 'planner') || !isPlannerToolId(cliTool.tool)) return null;

  const remediation = cliTool.diagnostic.remediation;
  return {
    tool: cliTool.tool,
    type: 'cli',
    available: cliTool.diagnostic.state === 'ready',
    description: CLI_TOOL_CATALOG[cliTool.tool].displayName,
    ...(cliTool.installedVersion ? { version: cliTool.installedVersion } : {}),
    ...(remediation ? { error: remediation } : {}),
  };
}

function cloneProvider(provider: ProviderDetection): ProviderDetection {
  return {
    ...provider,
    ...(provider.models ? { models: provider.models.map(cloneDetectedModel) } : {}),
  };
}

function applyToStores(result: DetectionServiceResult, detection: DetectionStoreWriter): void {
  detection.setDetection({
    planners: result.cliTools.flatMap((cliTool) => {
      const planner = projectPlanner(cliTool);
      return planner ? [planner] : [];
    }),
    implementers: result.providers.map(cloneProvider),
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
