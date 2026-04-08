import type { PlannerDetection, ProviderDetection } from '../../../types.js';
import type { Config } from '../../../types.js';
import { KNOWN_PLANNER_MODELS, KNOWN_IMPLEMENTER_MODELS, type KnownModel } from '../../../core/providers/models.js';
import { CLI_TOOL_NAMES } from '../../../types.js';
import { getProviderDisplayName, type ProviderId } from '../../../core/providers/catalog.js';

export interface PickerOption {
  id: string;
  displayName: string;
  kind: 'cli' | 'api' | 'provider' | 'shell';
  available: boolean;
  badge: string;
  version?: string | null;
}

export interface ModelOption {
  id: string;
  isDefault?: boolean;
  isDetected?: boolean;
  isCustom?: boolean;
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

const API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function plannerBadge(d: PlannerDetection): string {
  if (d.type === 'shell') return 'Custom';
  return d.type === 'cli' ? 'CLI' : 'API';
}

export function buildPlannerPickerOptions(detections: PlannerDetection[]): PickerOption[] {
  const items: PickerOption[] = [];

  if (detections.some(d => d.type === 'shell')) {
    items.push(makeShellOption());
  }

  for (const d of detections.filter(d => d.type !== 'shell')) {
    items.push({
      id: d.tool,
      displayName: getProviderDisplayName(d.tool),
      kind: d.type,
      available: d.available,
      badge: plannerBadge(d),
      version: d.version,
    });
  }

  items.sort(sortByAvailability);
  return items;
}

function implementerBadge(item: { kind: string; isLocal?: boolean }): string {
  if (item.kind === 'shell') return 'Custom';
  if (item.kind === 'cli') return 'CLI tool';
  return item.isLocal ? 'local, free' : 'remote';
}

function defaultHasApiKey(provider: string): boolean {
  const envVar = API_KEY_ENV[provider];
  return envVar ? !!process.env[envVar] : false;
}

export function buildImplementerPickerOptions(
  detections: ProviderDetection[],
  hasApiKey: (provider: string) => boolean = defaultHasApiKey,
): PickerOption[] {
  const items: PickerOption[] = [];

  items.push(makeShellOption());

  for (const tool of CLI_TOOL_NAMES) {
    items.push({
      id: tool,
      displayName: getProviderDisplayName(tool),
      kind: 'cli' as const,
      available: true,
      badge: 'CLI tool',
    });
  }

  for (const d of detections) {
    items.push({
      id: d.provider,
      displayName: getProviderDisplayName(d.provider),
      kind: 'provider',
      available: d.available,
      badge: implementerBadge({ kind: 'provider', isLocal: d.isLocal }),
    });
  }

  const detectedNames = new Set(detections.map(d => d.provider));
  for (const provider of Object.keys(KNOWN_IMPLEMENTER_MODELS)) {
    if (!detectedNames.has(provider)) {
      items.push({
        id: provider,
        displayName: getProviderDisplayName(provider),
        kind: 'provider',
        available: hasApiKey(provider),
        badge: 'remote',
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
  return knownToModelOptions(KNOWN_PLANNER_MODELS[toolId as ProviderId] ?? []);
}

export function modelsForImplementerProvider(
  detections: ProviderDetection[],
  providerId: string,
  providerKind: PickerOption['kind'],
): ModelOption[] {
  if (providerKind === 'cli') {
    return knownToModelOptions(KNOWN_PLANNER_MODELS[providerId as ProviderId] ?? []);
  }

  if (providerKind === 'shell') return [];

  const d = detections.find(det => det.provider === providerId);
  const detected = (d?.models ?? []).map(m => ({ id: m, isDetected: true }));
  const known = knownToModelOptions(KNOWN_IMPLEMENTER_MODELS[providerId as ProviderId] ?? []);

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
  plannerTool: string;
  implementerDetections: ProviderDetection[] | null;
  currentItem: PickerOption | undefined;
}): ModelOption[] {
  const customOptions: ModelOption[] = params.customModels.map(id => ({ id, isCustom: true }));
  if (params.isPlanner) {
    return [...customOptions, ...modelsForPlannerTool(params.plannerTool)];
  }
  const knownModels = params.implementerDetections && params.currentItem
    ? modelsForImplementerProvider(params.implementerDetections, params.currentItem.id, params.currentItem.kind)
    : [];
  return [...customOptions, ...knownModels];
}

export function isCurrentConfig(
  item: PickerOption,
  config: Config,
  role: 'planner' | 'implementer',
): boolean {
  if (role === 'planner') return item.id === config.planner.tool;
  if (item.kind === 'cli') return item.id === config.implementer.kind;
  return item.id === config.implementer.tool;
}
