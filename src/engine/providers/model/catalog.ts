import type { DetectedModel } from '../../../core/types/config-options.js';
import { isProviderId, type ProviderId } from '../../../core/schemas/enums.js';
import { isProviderLocal } from '../../../core/providers/catalog.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import {
  NULL_CACHE,
  findModelMetadata,
  getBundledModels,
  getModelsDevEntries,
  getRuntimeLookupProvider,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './resolution.js';
import { isApiPricedProvider, getPricingMode, type PricingMode } from '../pricing-resolver.js';
import { buildComparableKeys } from './parsing.js';

export type { ModelCacheAccessor } from './resolution.js';

export interface ResolvedModelCatalogEntry extends DetectedModel {
  id: string;
  isDefault?: boolean;
  isDetected?: boolean;
  source: 'models-dev' | 'runtime' | 'bundled-fallback';
  pricingMode: PricingMode;
}

function mergeModelMetadata(
  providerId: ProviderId,
  base: ResolvedModelCatalogEntry,
  runtime: DetectedModel | undefined,
  modelsDev: DetectedModel | undefined,
): ResolvedModelCatalogEntry {
  const apiPriced = isApiPricedProvider(providerId);
  const { pricingInput: seedIn, pricingOutput: seedOut, isFree: seedFree, ...seedRest } = base;
  const contextLength = modelsDev?.contextLength ?? runtime?.contextLength ?? base.contextLength;
  const pricingInput = modelsDev?.pricingInput ?? runtime?.pricingInput ?? seedIn;
  const pricingOutput = modelsDev?.pricingOutput ?? runtime?.pricingOutput ?? seedOut;
  const isFree = modelsDev?.isFree ?? runtime?.isFree ?? seedFree;
  const isDetected = base.isDetected ?? !!runtime;
  const releaseDate = modelsDev?.releaseDate ?? runtime?.releaseDate ?? base.releaseDate;

  return {
    ...seedRest,
    source: modelsDev
      ? 'models-dev'
      : base.source === 'models-dev'
        ? 'models-dev'
        : runtime
          ? 'runtime'
          : base.source,
    ...(contextLength !== undefined && { contextLength }),
    ...(apiPriced && pricingInput !== undefined && { pricingInput }),
    ...(apiPriced && pricingOutput !== undefined && { pricingOutput }),
    ...(apiPriced && isFree !== undefined && { isFree }),
    ...(isDetected !== undefined && { isDetected }),
    ...(releaseDate !== undefined && { releaseDate }),
  };
}

function toBundledEntry(providerId: ProviderId, entry: KnownModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  const apiPriced = isApiPricedProvider(providerId);
  const base: ResolvedModelCatalogEntry = {
    id: entry.name,
    source: 'bundled-fallback',
    pricingMode: getPricingMode(providerId),
    ...(entry.isDefault !== undefined && { isDefault: entry.isDefault }),
    ...(entry.contextLength !== undefined && { contextLength: entry.contextLength }),
    ...(apiPriced && entry.pricingInput !== undefined && { pricingInput: entry.pricingInput }),
    ...(apiPriced && entry.pricingOutput !== undefined && { pricingOutput: entry.pricingOutput }),
    ...(apiPriced && entry.isFree !== undefined && { isFree: entry.isFree }),
  };

  return mergeModelMetadata(
    providerId,
    base,
    undefined,
    entry.catalogModelId ? findModelMetadata(entry.catalogProvider ?? providerId, entry.catalogModelId, cache) ?? undefined : undefined,
  );
}

function toRuntimeEntry(providerId: ProviderId, entry: DetectedModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  return mergeModelMetadata(
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
}

function toModelsDevEntry(providerId: ProviderId, entry: DetectedModel, cache: ModelCacheAccessor): ResolvedModelCatalogEntry {
  return mergeModelMetadata(
    providerId,
    {
      id: entry.id,
      source: 'models-dev',
      pricingMode: getPricingMode(providerId),
    },
    lookupRuntimeModel(providerId, entry.id, cache) ?? undefined,
    entry,
  );
}

function mergeCatalogEntries(
  providerId: ProviderId,
  bundled: ResolvedModelCatalogEntry[],
  runtime: ResolvedModelCatalogEntry[],
  modelsDev: ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const byId = new Map<string, ResolvedModelCatalogEntry>();
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
    );
    const mergedIsDefault = existing.isDefault ?? entry.isDefault;
    const mergedIsDetected = existing.isDetected || entry.isDetected;
    if (mergedIsDefault !== undefined) merged.isDefault = mergedIsDefault;
    if (mergedIsDetected !== undefined) merged.isDetected = mergedIsDetected;

    byId.delete(canonicalId);
    byId.set(merged.id, merged);
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
