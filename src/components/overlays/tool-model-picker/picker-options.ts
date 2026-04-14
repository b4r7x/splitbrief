import type { PlannerDetection, ProviderDetection } from '../../../types.js';
import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS, LOCAL_PROVIDER_IDS, type ProviderId } from '../../../core/types/schemas/enums.js';
import { getProviderDisplayName, hasApiKey } from '../../../core/providers.js';
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
