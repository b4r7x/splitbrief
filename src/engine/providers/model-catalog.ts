import type { DetectedModel } from '../../core/types/config.js';
import type { ProviderId } from '../../core/types/schemas/enums.js';
import { isProviderId, isProviderLocal } from '../../core/providers.js';
import type { KnownModel } from '../../core/providers/known-models.js';
import {
  NULL_CACHE,
  findModelMetadata,
  getBundledModels,
  getModelsDevEntries,
  getRuntimeLookupProvider,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './model-resolution.js';
import { isApiPricedProvider, getPricingMode, mergeModelMetadata, buildComparableKeys, type ResolvedModelCatalogEntry } from './model-utils.js';

export type { ModelCacheAccessor, ResolvedModelCatalogEntry } from './model-utils.js';

function toBundledEntry(providerId: ProviderId, entry: KnownModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  const base: ResolvedModelCatalogEntry = {
    id: entry.name,
    source: 'bundled-fallback',
    pricingMode: getPricingMode(providerId),
    ...(entry.isDefault !== undefined && { isDefault: entry.isDefault }),
    ...(entry.contextLength !== undefined && { contextLength: entry.contextLength }),
    ...(entry.pricingInput !== undefined && { pricingInput: entry.pricingInput }),
    ...(entry.pricingOutput !== undefined && { pricingOutput: entry.pricingOutput }),
    ...(entry.isFree !== undefined && { isFree: entry.isFree }),
  };

  if (!isApiPricedProvider(providerId)) {
    delete base.pricingInput;
    delete base.pricingOutput;
    delete base.isFree;
  }

  return mergeModelMetadata(
    providerId,
    base,
    undefined,
    entry.catalogModelId ? findModelMetadata(entry.catalogProvider ?? providerId, entry.catalogModelId, cache) ?? undefined : undefined,
  ) ?? base;
}

function toRuntimeEntry(providerId: ProviderId, entry: DetectedModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  const result = mergeModelMetadata(
    providerId,
    {
      id: entry.id,
      source: 'runtime',
      pricingMode: getPricingMode(providerId),
      isDetected: true,
    },
    entry,
    isApiPricedProvider(providerId) ? findModelMetadata(providerId, entry.id, cache) ?? undefined : undefined,
  );
  // mergeModelMetadata returns undefined only when base, runtime, and modelsDev are all undefined.
  // Here base is always defined, so the result is always defined.
  return result ?? { id: entry.id, source: 'runtime', pricingMode: getPricingMode(providerId), isDetected: true };
}

function toModelsDevEntry(providerId: ProviderId, entry: DetectedModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  const result = mergeModelMetadata(
    providerId,
    {
      id: entry.id,
      source: 'models-dev',
      pricingMode: getPricingMode(providerId),
    },
    lookupRuntimeModel(providerId, entry.id, cache) ?? undefined,
    entry,
  );
  return result ?? { id: entry.id, source: 'models-dev', pricingMode: getPricingMode(providerId) };
}

/**
 * Merges bundled, runtime, and models-dev catalog entries, deduplicating by model ID.
 * Uses a pre-computed normalized-key index for O(n) lookups instead of O(n²) linear scans.
 */
function mergeCatalogEntries(
  providerId: ProviderId,
  bundled: ResolvedModelCatalogEntry[],
  runtime: ResolvedModelCatalogEntry[],
  modelsDev: ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const byId = new Map<string, ResolvedModelCatalogEntry>();
  // Maps each normalized key → canonical entry ID stored in byId
  const keyIndex = new Map<string, string>();

  const setEntry = (entry: ResolvedModelCatalogEntry) => {
    const entryKeys = buildComparableKeys(entry.id);
    const canonicalId = entryKeys.map((k) => keyIndex.get(k)).find((v) => v !== undefined);

    if (canonicalId === undefined) {
      byId.set(entry.id, entry);
      for (const k of entryKeys) keyIndex.set(k, entry.id);
      return;
    }

    const existing = byId.get(canonicalId);
    if (!existing) return;

    const merged = mergeModelMetadata(
      providerId,
      {
        ...existing,
        ...((existing.isDefault ?? entry.isDefault) !== undefined
          && { isDefault: existing.isDefault ?? entry.isDefault }),
      },
      entry.source === 'runtime' ? entry : undefined,
      entry.source === 'models-dev' ? entry : undefined,
    ) ?? existing;
    const mergedIsDefault = existing.isDefault ?? entry.isDefault;
    const mergedIsDetected = existing.isDetected || entry.isDetected;
    if (mergedIsDefault !== undefined) merged.isDefault = mergedIsDefault;
    if (mergedIsDetected !== undefined) merged.isDetected = mergedIsDetected;

    byId.delete(canonicalId);
    byId.set(merged.id, merged);
    // Remap all keys that pointed to old canonical id to the new merged id
    for (const [k, v] of keyIndex) {
      if (v === canonicalId) keyIndex.set(k, merged.id);
    }
    for (const k of buildComparableKeys(merged.id)) keyIndex.set(k, merged.id);
  };

  bundled.forEach(setEntry);
  modelsDev.forEach(setEntry);
  runtime.forEach(setEntry);

  return [...byId.values()];
}

function filterStaleBundled(
  entries: ResolvedModelCatalogEntry[],
  freshIds: Set<string>,
): ResolvedModelCatalogEntry[] {
  if (freshIds.size === 0) return entries;
  const freshKeySet = new Set<string>();
  for (const id of freshIds) {
    for (const key of buildComparableKeys(id)) freshKeySet.add(key);
  }
  return entries.filter((e) => {
    if (e.isDefault) return true;
    return buildComparableKeys(e.id).some((key) => freshKeySet.has(key));
  });
}

function collectFreshIds(modelsDev: ResolvedModelCatalogEntry[], runtime: ResolvedModelCatalogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of modelsDev) ids.add(e.id);
  for (const e of runtime) ids.add(e.id);
  return ids;
}

function resolveCatalogEntries(
  providerId: ProviderId,
  cache: ModelCacheAccessor,
  opts: { runtimeProvider?: ProviderId; includeModelsDev?: boolean },
): ResolvedModelCatalogEntry[] {
  const bundled = getBundledModels(providerId).map((entry) => toBundledEntry(providerId, entry, cache));
  const modelsDev = opts.includeModelsDev
    ? getModelsDevEntries(providerId, cache).map((entry) => toModelsDevEntry(providerId, entry, cache))
    : [];
  const runtimeSource: ProviderId = opts.runtimeProvider ?? providerId;
  const runtime = (cache.getProviderModels(runtimeSource) ?? []).map((entry) => toRuntimeEntry(providerId, entry, cache));
  return filterStaleBundled(mergeCatalogEntries(providerId, bundled, runtime, modelsDev), collectFreshIds(modelsDev, runtime));
}

function resolveApiCatalog(providerId: ProviderId, cache: ModelCacheAccessor): ResolvedModelCatalogEntry[] {
  return resolveCatalogEntries(providerId, cache, { runtimeProvider: getRuntimeLookupProvider(providerId), includeModelsDev: true });
}

function resolveToolCatalog(providerId: ProviderId, cache: ModelCacheAccessor): ResolvedModelCatalogEntry[] {
  return resolveCatalogEntries(providerId, cache, { includeModelsDev: true });
}

function resolveLocalCatalog(providerId: ProviderId, cache: ModelCacheAccessor): ResolvedModelCatalogEntry[] {
  return resolveCatalogEntries(providerId, cache, {});
}

export function resolveModelCatalog(providerId: string, cache: ModelCacheAccessor = NULL_CACHE): ResolvedModelCatalogEntry[] {
  if (!isProviderId(providerId)) return [];
  if (isProviderLocal(providerId)) return resolveLocalCatalog(providerId, cache);
  if (isApiPricedProvider(providerId)) return resolveApiCatalog(providerId, cache);
  return resolveToolCatalog(providerId, cache);
}
