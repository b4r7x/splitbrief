import type { ProviderDetection, Config } from '../../../types.js';
import { getRunnerDisplayName } from '../../../core/config/runner-config.js';
import { modelCacheStore } from '../../../stores/model-cache.js';
import { type ModelOption, sortModelsByRecency } from './model-sorting.js';
import { type PickerOption } from './picker-options.js';

export type { ModelOption } from './model-sorting.js';
export { isCustomModel, sortModelsByRecency } from './model-sorting.js';
export type { PickerOption, PlannerPickerOpts, ImplementerPickerOpts } from './picker-options.js';
export { buildPlannerPickerOptions, buildImplementerPickerOptions } from './picker-options.js';

function resolveAndSort(providerId: string): ModelOption[] {
  return sortModelsByRecency(
    modelCacheStore.resolveModelCatalog(providerId).map(m => ({
      id: m.id,
      isDefault: m.isDefault,
      isDetected: m.isDetected,
      contextLength: m.contextLength,
      releaseDate: m.releaseDate,
    })),
  );
}

export function modelsForPlannerTool(toolId: string): ModelOption[] {
  return resolveAndSort(toolId);
}

export function modelsForImplementerProvider(
  providerId: string,
  providerKind: PickerOption['kind'],
): ModelOption[] {
  if (providerKind === 'cli') {
    return resolveAndSort(providerId);
  }
  if (providerKind === 'shell' || providerKind === 'agent' || providerKind === 'agent-sdk') return [];
  return resolveAndSort(providerId);
}

export function buildRightModels(params: {
  isPlanner: boolean;
  customModels: string[];
  implementerDetections: ProviderDetection[];
  currentItem: PickerOption | undefined;
}): ModelOption[] {
  const customOptions: ModelOption[] = params.customModels.map(id => ({ id, isCustom: true }));
  if (!params.currentItem) return customOptions;
  const knownModels = params.isPlanner
    ? modelsForPlannerTool(params.currentItem.id)
    : modelsForImplementerProvider(params.currentItem.id, params.currentItem.kind);
  return [...customOptions, ...knownModels];
}

export function isCurrentConfig(
  item: PickerOption,
  config: Config,
  role: 'planner' | 'implementer',
): boolean {
  const runnerConfig = role === 'planner' ? config.planner : config.implementer;
  return item.id === getRunnerDisplayName(runnerConfig);
}
