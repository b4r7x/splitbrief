import type { Config } from '../../core/schemas/config.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';
import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS, LOCAL_PROVIDER_IDS, type ProviderId } from '../../core/schemas/enums.js';
import { getProviderDisplayName, hasApiKey } from '../../core/providers/catalog.js';
import { includes } from '../../utils/type-guards.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { resolveModelCatalog } from '../../engine/providers/model/catalog.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../engine/providers/model/resolution.js';

export interface ModelOption {
  id: string;
  isDefault?: boolean | undefined;
  isDetected?: boolean | undefined;
  isCustom?: boolean | undefined;
  contextLength?: number | undefined;
  releaseDate?: string | undefined;
}

export function isCustomModel(item: ModelOption): boolean {
  return item.isCustom ?? false;
}

const TRAILING_DATE_CAPTURE_RE = /(\d{8})$/;
const SIZE_SEGMENT_RE = /^\d+(?:\.\d+)?b$/i;

function extractRecencyKey(id: string): { date: number; version: number[]; name: string } {
  const base = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const withoutTag = base.includes(':') ? base.slice(0, base.indexOf(':')) : base;

  const dateMatch = withoutTag.match(TRAILING_DATE_CAPTURE_RE);
  const date = dateMatch?.[1] ? parseInt(dateMatch[1], 10) : 0;

  const segments = withoutTag.split(/[-._]/);
  const version: number[] = [];
  for (const seg of segments) {
    if (/^\d+$/.test(seg) && !SIZE_SEGMENT_RE.test(seg)) {
      version.push(parseInt(seg, 10));
    }
  }

  return { date, version, name: base };
}

function compareRecency(a: ReturnType<typeof extractRecencyKey>, b: ReturnType<typeof extractRecencyKey>): number {
  if (a.date !== b.date) return b.date - a.date;
  const maxLen = Math.max(a.version.length, b.version.length);
  for (let i = 0; i < maxLen; i++) {
    const av = a.version[i] ?? 0;
    const bv = b.version[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return a.name.localeCompare(b.name);
}

export function sortModelsByRecency(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;

    if (a.releaseDate || b.releaseDate) {
      const aDate = a.releaseDate ?? '';
      const bDate = b.releaseDate ?? '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
    }

    return compareRecency(extractRecencyKey(a.id), extractRecencyKey(b.id));
  });
}

export interface PickerOption {
  id: string;
  displayName: string;
  kind: 'cli' | 'api' | 'shell' | 'agent' | 'agent-sdk';
  available: boolean;
  badge: string;
  version?: string | undefined;
  isCurrent?: boolean;
}

type SharedPickerId = ProviderId;

const SHARED_PICKER_IDS = [
  'shell',
  'agent',
  'agent-sdk',
  ...CLI_TOOL_IDS,
  ...KNOWN_API_PROVIDERS,
] as const satisfies readonly SharedPickerId[];

function makeSpecialOption(
  id: 'shell' | 'agent' | 'agent-sdk',
  kind: PickerOption['kind'],
  badge: string,
  available = true,
): PickerOption {
  return {
    id,
    displayName: getProviderDisplayName(id),
    kind,
    available,
    badge,
  };
}

function sortByAvailability(a: PickerOption, b: PickerOption): number {
  if (a.available && !b.available) return -1;
  if (!a.available && b.available) return 1;
  return 0;
}

export interface PlannerPickerOpts {
  detections: PlannerDetection[];
  implementerDetections?: ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
}

interface SharedPickerOpts {
  plannerDetections?: PlannerDetection[];
  implementerDetections?: ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
}

function buildCliOption(
  id: (typeof CLI_TOOL_IDS)[number],
  opts: SharedPickerOpts,
): PickerOption {
  const detection = opts.plannerDetections?.find(item => item.tool === id);
  return {
    id,
    displayName: getProviderDisplayName(id),
    kind: 'cli',
    available: detection?.available ?? false,
    badge: 'CLI',
    version: detection?.version,
  };
}

function buildApiOption(
  id: (typeof KNOWN_API_PROVIDERS)[number],
  opts: SharedPickerOpts,
): PickerOption {
  const detection = opts.implementerDetections?.find(item => item.provider === id);
  const isLocal = detection?.isLocal ?? includes(LOCAL_PROVIDER_IDS, id);
  return {
    id,
    displayName: getProviderDisplayName(id),
    kind: 'api',
    available: detection?.available ?? (opts.hasApiKeyOverride ?? hasApiKey)(id),
    badge: isLocal ? 'API, local' : 'API',
  };
}

function buildSharedPickerOption(id: SharedPickerId, opts: SharedPickerOpts): PickerOption {
  if (id === 'shell') return makeSpecialOption('shell', 'shell', 'Custom');
  if (id === 'agent') return makeSpecialOption('agent', 'agent', 'Custom');
  if (id === 'agent-sdk') {
    return makeSpecialOption('agent-sdk', 'agent-sdk', 'SDK', (opts.hasApiKeyOverride ?? hasApiKey)('agent-sdk'));
  }
  if (includes(CLI_TOOL_IDS, id)) return buildCliOption(id, opts);
  if (includes(KNOWN_API_PROVIDERS, id)) return buildApiOption(id, opts);
  return {
    id,
    displayName: getProviderDisplayName(id),
    kind: 'api',
    available: false,
    badge: 'API',
  };
}

function buildSharedPickerOptions(opts: SharedPickerOpts): PickerOption[] {
  return SHARED_PICKER_IDS
    .map(id => buildSharedPickerOption(id, opts))
    .sort(sortByAvailability);
}

export function buildPlannerPickerOptions(opts: PlannerPickerOpts): PickerOption[] {
  return buildSharedPickerOptions({
    plannerDetections: opts.detections,
    ...(opts.implementerDetections && { implementerDetections: opts.implementerDetections }),
    ...(opts.hasApiKeyOverride && { hasApiKeyOverride: opts.hasApiKeyOverride }),
  });
}

export interface ImplementerPickerOpts {
  detections: ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
  plannerDetections?: PlannerDetection[];
}

export function buildImplementerPickerOptions(opts: ImplementerPickerOpts): PickerOption[] {
  return buildSharedPickerOptions({
    implementerDetections: opts.detections,
    ...(opts.plannerDetections && { plannerDetections: opts.plannerDetections }),
    ...(opts.hasApiKeyOverride && { hasApiKeyOverride: opts.hasApiKeyOverride }),
  });
}

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

export function buildRightModelsForPicker(params: {
  isPlanner: boolean;
  customModels: string[];
  currentItem: PickerOption | undefined;
}): ModelOption[] {
  return buildRightModels({ ...params, cache: modelCacheStore });
}

export function isCurrentConfig(
  item: PickerOption,
  config: Config,
  role: 'planner' | 'implementer',
): boolean {
  const runnerConfig = role === 'planner' ? config.planner : config.implementer;
  return item.id === getRunnerDisplayName(runnerConfig);
}
