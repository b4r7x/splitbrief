import type { PlannerDetection, ProviderDetection } from '../../../types.js';
import type { Config } from '../../../types.js';
import { KNOWN_MODELS, type KnownModel } from '../../../core/providers/models.js';
import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS } from '../../../core/types/schemas/enums.js';
import { getRunnerDisplayName } from '../../../core/config/runner-config.js';
import { getProviderDisplayName, hasApiKey, isProviderId } from '../../../core/providers/catalog.js';
import { includes } from '../../../utils/type-guards.js';

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
}

export function isCustomModel(item: ModelOption): boolean {
  return item.isCustom === true;
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
    items.push({
      id: tool,
      displayName: getProviderDisplayName(tool),
      kind: 'cli' as const,
      available: plannerDet?.available ?? false,
      badge: 'CLI',
      version: plannerDet?.version,
    });
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
  }));
}

export function modelsForPlannerTool(toolId: string): ModelOption[] {
  if (!isProviderId(toolId)) return [];
  return knownToModelOptions(KNOWN_MODELS[toolId] ?? []);
}

export function modelsForImplementerProvider(
  detections: ProviderDetection[],
  providerId: string,
  providerKind: PickerOption['kind'],
): ModelOption[] {
  if (providerKind === 'cli') {
    if (!isProviderId(providerId)) return [];
    return knownToModelOptions(KNOWN_MODELS[providerId] ?? []);
  }

  if (providerKind === 'shell' || providerKind === 'agent' || providerKind === 'agent-sdk') return [];

  const d = detections.find(det => det.provider === providerId);
  const detected = (d?.models ?? []).map(m => ({ id: m, isDetected: true }));
  const known = isProviderId(providerId)
    ? knownToModelOptions(KNOWN_MODELS[providerId] ?? [])
    : [];

  if (detected.length === 0) return known;

  const detectedSet = new Set(detected.map(m => m.id));
  const merged: ModelOption[] = [...detected];
  for (const k of known) {
    if (!detectedSet.has(k.id)) merged.push(k);
  }
  return merged;
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
