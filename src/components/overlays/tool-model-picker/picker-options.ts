import type { PlannerDetection, ProviderDetection } from '../../../types.js';
import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS } from '../../../core/types/schemas/enums.js';
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
    items.push(makeSpecialOption('shell', 'shell', 'Custom'));
  }

  items.push(makeSpecialOption('agent-sdk', 'agent-sdk', 'SDK', hasApiKey('agent-sdk')));

  for (const d of opts.detections.filter(d => d.type !== 'shell' && d.tool !== 'agent-sdk')) {
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

  items.push(makeSpecialOption('shell', 'shell', 'Custom'));
  items.push(makeSpecialOption('agent', 'agent', 'Custom'));

  for (const tool of CLI_TOOL_IDS) {
    const plannerDet = plannerDetections.find(d => d.tool === tool);
    items.push({
      id: tool,
      displayName: getProviderDisplayName(tool),
      kind: 'cli',
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
