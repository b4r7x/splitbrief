import type { PlannerDetection, ProviderDetection, Config } from '../../../types.js';
import type { DetectedModel } from '../../../core/types/config.js';
import { KNOWN_MODELS, type KnownModel } from '../../../engine/providers/known.js';
import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS } from '../../../core/types/schemas/enums.js';
import { getRunnerDisplayName } from '../../../core/config/runner-config.js';
import { getProviderDisplayName, hasApiKey, isProviderId, isProviderLocal } from '../../../core/providers.js';
import { includes } from '../../../utils/type-guards.js';
import { modelCacheStore } from '../../../stores/model-cache.js';
import { getModelsForProvider } from '../../../engine/providers/models-dev.js';

export interface PickerOption {
  id: string;
  displayName: string;
  kind: 'cli' | 'api' | 'shell' | 'agent' | 'agent-sdk';
  available: boolean;
  badge: string;
  version?: string | undefined;
  isCurrent?: boolean;
}

export interface ModelOption {
  id: string;
  isDefault?: boolean | undefined;
  isDetected?: boolean | undefined;
  isCustom?: boolean | undefined;
  contextLength?: number | undefined;
  pricingInput?: number | undefined;
  pricingOutput?: number | undefined;
  isFree?: boolean | undefined;
}

export function isCustomModel(item: ModelOption): boolean {
  return item.isCustom === true;
}

export function sortModelsWithFreeFirst(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.isFree && !b.isFree) return -1;
    if (!a.isFree && b.isFree) return 1;
    return 0;
  });
}

function sortByAvailability(a: PickerOption, b: PickerOption): number {
  if (a.available && !b.available) return -1;
  if (!a.available && b.available) return 1;
  return 0;
}

function makeShellOption(): PickerOption {
  return {
    id: 'shell',
    displayName: getProviderDisplayName('shell'),
    kind: 'shell',
    available: true,
    badge: 'Custom',
  };
}

function makeAgentOption(): PickerOption {
  return {
    id: 'agent',
    displayName: getProviderDisplayName('agent'),
    kind: 'agent',
    available: true,
    badge: 'Custom',
  };
}

function makeAgentSdkOption(): PickerOption {
  return {
    id: 'agent-sdk',
    displayName: getProviderDisplayName('agent-sdk'),
    kind: 'agent-sdk',
    available: true,
    badge: 'SDK',
  };
}

function plannerBadge(d: PlannerDetection): string {
  if (d.type === 'shell') return 'Custom';
  return d.type === 'cli' ? 'CLI' : 'API';
}

export interface PlannerPickerOpts {
  detections: PlannerDetection[];
  implementerDetections?: ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
}

export function buildPlannerPickerOptions(opts: PlannerPickerOpts): PickerOption[] {
  const items: PickerOption[] = [];

  if (opts.detections.some(d => d.type === 'shell')) {
    items.push(makeShellOption());
  }

  items.push(makeAgentSdkOption());

  for (const d of opts.detections.filter(d => d.type !== 'shell')) {
    items.push({
      id: d.tool,
      displayName: getProviderDisplayName(d.tool),
      kind: d.type,
      available: d.available,
      badge: plannerBadge(d),
      version: d.version,
    });
  }

  const addedIds = new Set(items.map(i => i.id));
  for (const provider of KNOWN_API_PROVIDERS) {
    if (!addedIds.has(provider) && !includes(CLI_TOOL_IDS, provider)) {
      const det = opts.implementerDetections?.find(d => d.provider === provider);
      items.push({
        id: provider,
        displayName: getProviderDisplayName(provider),
        kind: 'api',
        available: det?.available ?? (opts.hasApiKeyOverride ?? hasApiKey)(provider),
        badge: det?.isLocal ? 'API, local' : 'API',
      });
    }
  }

  items.sort(sortByAvailability);
  return items;
}

function implementerBadge(item: { kind: PickerOption['kind']; isLocal?: boolean }): string {
  if (item.kind === 'shell' || item.kind === 'agent') return 'Custom';
  if (item.kind === 'cli') return 'CLI';
  if (item.kind === 'agent-sdk') return 'SDK';
  return item.isLocal ? 'API, local' : 'API';
}

export interface ImplementerPickerOpts {
  detections: ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
  plannerDetections?: PlannerDetection[];
}

export function buildImplementerPickerOptions(opts: ImplementerPickerOpts): PickerOption[] {
  const { detections, hasApiKeyOverride = hasApiKey, plannerDetections = [] } = opts;
  const items: PickerOption[] = [];

  items.push(makeShellOption());
  items.push(makeAgentOption());

  for (const tool of CLI_TOOL_IDS) {
    const plannerDet = plannerDetections.find(d => d.tool === tool);
    const cliItem: PickerOption = {
      id: tool,
      displayName: getProviderDisplayName(tool),
      kind: 'cli',
      available: plannerDet?.available ?? false,
      badge: 'CLI',
      version: plannerDet?.version,
    };
    items.push(cliItem);
  }

  const addedIds = new Set(items.map(i => i.id));

  for (const d of detections) {
    if (addedIds.has(d.provider)) continue;
    items.push({
      id: d.provider,
      displayName: getProviderDisplayName(d.provider),
      kind: 'api',
      available: d.available,
      badge: implementerBadge({ kind: 'api', isLocal: d.isLocal }),
    });
    addedIds.add(d.provider);
  }
  for (const provider of KNOWN_API_PROVIDERS) {
    if (!addedIds.has(provider)) {
      items.push({
        id: provider,
        displayName: getProviderDisplayName(provider),
        kind: 'api',
        available: hasApiKeyOverride(provider),
        badge: 'API',
      });
    }
  }

  items.sort(sortByAvailability);
  return items;
}

function knownToModelOptions(models: KnownModel[], isDetected = false): ModelOption[] {
  return models.map(m => ({
    id: m.name,
    isDefault: m.isDefault,
    isDetected,
    contextLength: m.contextLength,
    pricingInput: m.pricingInput,
    pricingOutput: m.pricingOutput,
    isFree: m.isFree,
  }));
}

function detectedToModelOption(m: DetectedModel, extra?: Partial<ModelOption>): ModelOption {
  return {
    id: m.id,
    isDetected: true,
    contextLength: m.contextLength,
    pricingInput: m.pricingInput,
    pricingOutput: m.pricingOutput,
    isFree: m.isFree,
    ...extra,
  };
}

function enrichWithModelsDevData(models: ModelOption[], providerId: string): ModelOption[] {
  const catalog = modelCacheStore.getModelsDevCatalog();
  if (!catalog) return models;

  const devModels = isProviderId(providerId) ? getModelsForProvider(catalog, providerId) : [];
  if (devModels.length === 0) return models;

  const devMap = new Map(devModels.map(m => [m.id, m]));
  return models.map(m => {
    const dev = devMap.get(m.id);
    if (!dev) return m;
    return {
      ...m,
      contextLength: m.contextLength ?? dev.contextLength,
      pricingInput: m.pricingInput ?? dev.pricingInput,
      pricingOutput: m.pricingOutput ?? dev.pricingOutput,
      isFree: m.isFree ?? dev.isFree,
    };
  });
}

function getModelsDevModels(providerId: string): ModelOption[] {
  const catalog = modelCacheStore.getModelsDevCatalog();
  if (!catalog || !isProviderId(providerId)) return [];
  const models = getModelsForProvider(catalog, providerId);
  return models.map(m => detectedToModelOption(m));
}

function mergeModelOptions(base: ModelOption | undefined, override: ModelOption): ModelOption {
  if (!base) return override;
  return {
    ...base,
    ...override,
    contextLength: override.contextLength ?? base.contextLength,
    pricingInput: override.pricingInput ?? base.pricingInput,
    pricingOutput: override.pricingOutput ?? base.pricingOutput,
    isFree: override.isFree ?? base.isFree,
    isDefault: override.isDefault ?? base.isDefault,
  };
}

export function modelsForPlannerTool(toolId: string): ModelOption[] {
  if (!isProviderId(toolId)) return [];

  const cached = modelCacheStore.getProviderModels(toolId);
  const layer1: ModelOption[] = cached
    ? cached.map(m => detectedToModelOption(m))
    : [];

  const layer2 = getModelsDevModels(toolId);
  const layer3 = knownToModelOptions(KNOWN_MODELS[toolId] ?? []);

  const mergedMap = new Map<string, ModelOption>();
  for (const m of layer3) mergedMap.set(m.id, m);
  for (const m of layer2) mergedMap.set(m.id, mergeModelOptions(mergedMap.get(m.id), m));
  for (const m of layer1) mergedMap.set(m.id, mergeModelOptions(mergedMap.get(m.id), m));

  return sortModelsWithFreeFirst([...mergedMap.values()]);
}

export function modelsForImplementerProvider(
  detections: ProviderDetection[],
  providerId: string,
  providerKind: PickerOption['kind'],
): ModelOption[] {
  if (providerKind === 'cli') {
    return modelsForPlannerTool(providerId);
  }

  if (providerKind === 'shell' || providerKind === 'agent' || providerKind === 'agent-sdk') return [];

  const isLocal = isProviderLocal(providerId);

  const d = detections.find(det => det.provider === providerId);
  const known = isProviderId(providerId)
    ? knownToModelOptions(KNOWN_MODELS[providerId] ?? [])
    : [];
  const knownMap = new Map(known.map(k => [k.id, k]));

  const detected: ModelOption[] = (d?.models ?? []).map(m =>
    mergeModelOptions(knownMap.get(m.id), detectedToModelOption(m)),
  );

  if (isLocal) {
    if (detected.length === 0) return [];
    return sortModelsWithFreeFirst(detected);
  }

  if (detected.length === 0) {
    const layer2 = getModelsDevModels(providerId);
    const mergedMap = new Map<string, ModelOption>();
    for (const m of known) mergedMap.set(m.id, m);
    for (const m of layer2) mergedMap.set(m.id, mergeModelOptions(mergedMap.get(m.id), m));
    return sortModelsWithFreeFirst([...mergedMap.values()]);
  }

  const detectedSet = new Set(detected.map(m => m.id));
  const merged: ModelOption[] = [...detected];
  for (const k of known) {
    if (!detectedSet.has(k.id)) merged.push(k);
  }
  return sortModelsWithFreeFirst(enrichWithModelsDevData(merged, providerId));
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
    : modelsForImplementerProvider(params.implementerDetections, params.currentItem.id, params.currentItem.kind);
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
