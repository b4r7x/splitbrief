import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import { resolveModelCatalog } from '../../../engine/providers/model/catalog.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import type { PickerOption } from './options.js';
import { sortModelsByRecency, type ModelOption } from './recency.js';

// A selection policy, not catalog data: it carries no context length, pricing,
// release date or provenance, and is synthesized per render rather than merged.
const AUTOMATIC_MODEL_OPTION: ModelOption = Object.freeze({ id: AUTOMATIC_MODEL });

function mergeModelOptions(custom: ModelOption[], known: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();

  for (const model of known) {
    byId.set(model.id, model);
  }

  for (const model of custom) {
    const existing = byId.get(model.id);
    byId.set(model.id, existing ? { ...existing, isCustom: true } : { ...model, isCustom: true });
  }

  return sortModelsByRecency([...byId.values()]);
}

function toModelOption(entry: ReturnType<typeof resolveModelCatalog>[number]): ModelOption {
  return {
    id: entry.id,
    isDefault: entry.isDefault,
    isDetected: entry.isDetected,
    contextLength: entry.contextLength,
    releaseDate: entry.releaseDate,
  };
}

function resolveAndSort(providerId: string, cache: ModelCacheAccessor = NULL_CACHE): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const entry of resolveModelCatalog(providerId, cache)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(toModelOption(entry));
  }
  return sortModelsByRecency(models);
}

export function modelsForPlannerTool(
  toolId: string,
  cache: ModelCacheAccessor = NULL_CACHE,
): ModelOption[] {
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
  if (!params.currentItem) {
    return params.customModels.map((id) => ({ id, isCustom: true }));
  }

  const capability = params.currentItem.modelCapability;
  if (!capability.showsDiscovered && !capability.allowsCustom && !capability.allowsAutomatic) {
    return [];
  }

  const cache = params.cache ?? NULL_CACHE;
  const knownModels = capability.showsDiscovered
    ? params.isPlanner
      ? modelsForPlannerTool(params.currentItem.id, cache)
      : modelsForImplementerProvider(params.currentItem.id, params.currentItem.kind, cache)
    : [];
  const customOptions = capability.allowsCustom
    ? params.customModels
        .filter((id) => !isAutomaticModel(id))
        .map((id) => ({ id, isCustom: true }))
    : [];

  const merged = mergeModelOptions(customOptions, knownModels);
  return capability.allowsAutomatic ? [AUTOMATIC_MODEL_OPTION, ...merged] : merged;
}

export function isCurrentConfig(
  item: PickerOption,
  config: Config,
  role: 'planner' | 'implementer',
): boolean {
  const runnerConfig =
    role === 'planner' ? config.planner : resolveImplementerProfiles(config).defaultProfile.config;
  return item.id === getRunnerDisplayName(runnerConfig);
}
