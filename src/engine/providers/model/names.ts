import {
  TOOL_EFFORT_LADDERS,
  MODELS_DEV_VENDOR_FOR_RUNNER,
} from '../../../core/providers/known-models.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { findCatalogModelByIdentity } from '../models-dev/catalog.js';
import { splitModelVendorPrefix } from './parsing.js';
import type { ModelCacheAccessor } from './runtime-snapshot.js';
import type { ResolvedModelCatalogEntry } from './types.js';

/**
 * A tool's own flag ladder is the floor for a row no catalog knows. A row that already
 * carries a ladder keeps it — including an empty one, which means the model publishes
 * no named levels (models.dev gives `claude-haiku-4-5` only a token budget).
 */
export function withToolEffortFloor(
  providerId: ProviderId,
  entries: ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const ladder = TOOL_EFFORT_LADDERS[providerId];
  if (ladder === undefined) return entries;
  return entries.map((entry) =>
    entry.nativeReasoningEfforts === undefined
      ? { ...entry, nativeReasoningEfforts: [...ladder.levels], effortFromFloor: true }
      : entry,
  );
}

/** The one name every vendor serving this id publishes, or none when they disagree. */
function agreedCatalogName(catalog: ModelsDevCatalog, modelId: string): string | undefined {
  const names = new Set<string>();
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) {
      if (model.id === modelId && model.name !== undefined) names.add(model.name);
    }
  }
  const [only] = [...names];
  return names.size === 1 ? only : undefined;
}

/**
 * A CLI tool's rows carry no catalog metadata — the tool bills its own subscription and its own
 * enum is the row set, so `getModelsDevEntries` serves api runners only — and a listing that
 * publishes bare ids (`deepseek/deepseek-v4-flash`, `claude-sonnet-5`) leaves the picker nothing
 * to print but the id. The name alone crosses over: no window, rate or ladder, and the id stays
 * the selection. The vendor is the id's own prefix, else the runner's catalog vendor; an id
 * neither names takes a name only where every vendor serving it agrees on one.
 */
function catalogDisplayName(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    cache: ModelCacheAccessor;
  }>,
): string | undefined {
  const catalog = input.cache.getModelsDevCatalog();
  if (catalog === null) return undefined;
  const { vendor, bareId } = splitModelVendorPrefix(input.selectionId);
  const owner = vendor ?? MODELS_DEV_VENDOR_FOR_RUNNER[input.runnerId];
  if (owner === undefined) return agreedCatalogName(catalog, bareId);
  return findCatalogModelByIdentity(catalog, { vendor: owner, bareId })?.displayName;
}

export function withCatalogNames(
  providerId: ProviderId,
  cache: ModelCacheAccessor,
  entries: ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  if (!isCliToolId(providerId)) return entries;
  return entries.map((entry) => {
    if (entry.displayName !== undefined) return entry;
    if (entry.source !== 'runtime' && entry.source !== 'bundled-fallback') return entry;
    const displayName = catalogDisplayName({
      runnerId: providerId,
      selectionId: entry.selectionId,
      cache,
    });
    return displayName === undefined ? entry : { ...entry, displayName };
  });
}
