import type { Config } from '../../../types.js';
import { getRunnerDisplayName } from '../../../core/config/runner-config.js';
import { type ModelOption, sortModelsByRecency } from './model-sorting.js';
import { type PickerOption } from './picker-options.js';
import type { ModelCacheAccessor } from '../../../core/model-catalog.js';
import { resolveModelCatalog, NULL_CACHE } from '../../../core/model-catalog.js';

export type { ModelOption } from './model-sorting.js';
export { isCustomModel, sortModelsByRecency } from './model-sorting.js';
export type { PickerOption, PlannerPickerOpts, ImplementerPickerOpts } from './picker-options.js';
export { buildPlannerPickerOptions, buildImplementerPickerOptions } from './picker-options.js';

function resolveAndSort(providerId: string, cache: ModelCacheAccessor = NULL_CACHE): ModelOption[] {
  return sortModelsByRecency(
    resolveModelCatalog(providerId, cache).map(m => ({
      id: m.id,
      isDefault: m.isDefault,
      isDetected: m.isDetected,
      contextLength: m.contextLength,
      releaseDate: m.releaseDate,
    })),
  );
}

export function modelsForPlannerTool(toolId: string, cache: ModelCacheAccessor = NULL_CACHE): ModelOption[] {
  return resolveAndSort(toolId, cache);
}

export function modelsForImplementerProvider(
  providerId: string,
  providerKind: PickerOption['kind'],
  cache: ModelCacheAccessor = NULL_CACHE,
): ModelOption[] {
  if (providerKind === 'shell' || providerKind === 'agent') return [];
  return resolveAndSort(providerId, cache);
}

export function buildRightModels(params: {
  isPlanner: boolean;
  customModels: string[];
  currentItem: PickerOption | undefined;
  cache?: ModelCacheAccessor;
}): ModelOption[] {
  const customOptions: ModelOption[] = params.customModels.map(id => ({ id, isCustom: true }));
  if (!params.currentItem) return customOptions;
  const cache = params.cache ?? NULL_CACHE;
  const knownModels = params.isPlanner
    ? modelsForPlannerTool(params.currentItem.id, cache)
    : modelsForImplementerProvider(params.currentItem.id, params.currentItem.kind, cache);
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
