import type { DetectedModel } from '../../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  isCliToolId,
  type ActiveRunnerRole,
} from '../../../core/runners/cli-tool-catalog.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { isProviderId, type ProviderId } from '../../../core/schemas/enums.js';
import { getPricingMode, isApiPricedProvider, type PricingMode } from '../pricing-resolver.js';
import {
  NULL_CACHE,
  findKnownModel,
  getBundledModels,
  getModelsDevEntries,
  getRuntimeModelSnapshot,
  type ModelCacheAccessor,
} from './resolution.js';
import { areExactModelSelectionIdsEqual } from './parsing.js';

export type ResolvedModelSource =
  | 'models-dev'
  | 'runtime'
  | 'bundled-fallback'
  | 'configured-recovery';
export type ResolvedModelMembership =
  | 'confirmed'
  | 'stale'
  | 'catalog-suggestion'
  | 'bundled-suggestion'
  | 'custom';

export interface ResolveModelCatalogOptions {
  readonly cache?: ModelCacheAccessor | undefined;
  readonly configuredSelectionId?: string | undefined;
  readonly role?: ActiveRunnerRole | undefined;
}

export interface ResolvedModelCatalogEntry extends DetectedModel {
  readonly id: string;
  readonly selectionId: string;
  readonly runnerId: ProviderId;
  readonly sourceProviderId: string;
  readonly isDefault?: boolean;
  readonly isDetected?: boolean;
  readonly isCustom?: boolean;
  readonly nativeOrder?: number | undefined;
  readonly source: ResolvedModelSource;
  readonly membership: ResolvedModelMembership;
  readonly isStale?: boolean;
  readonly canConfigure: boolean;
  readonly pricingMode: PricingMode;
}

function ownerFor(entry: DetectedModel, fallback: string): string {
  return entry.providerId ?? fallback;
}

function entryKey(input: Readonly<{ owner: string; selectionId: string }>): string {
  return `${input.owner}\u0000${input.selectionId}`;
}

function exactModelsDevMetadata(
  input: Readonly<{
    entries: readonly DetectedModel[];
    selectionId: string;
    sourceProviderId?: string | undefined;
  }>,
): DetectedModel | null {
  const matches = input.entries.filter(
    (entry) =>
      areExactModelSelectionIdsEqual({ left: entry.id, right: input.selectionId }) &&
      (input.sourceProviderId === undefined || entry.providerId === input.sourceProviderId),
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

function metadataForSelection(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    sourceProviderId: string | undefined;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): DetectedModel | null {
  const direct = exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId: input.selectionId,
    sourceProviderId: input.sourceProviderId,
  });
  if (direct !== null) return direct;

  const known = findKnownModel(input.runnerId, input.selectionId);
  if (known?.catalogModelId === undefined || known.catalogProvider === undefined) return null;
  return exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId: known.catalogModelId,
    sourceProviderId: known.catalogProvider,
  });
}

function metadataForBundledModel(
  input: Readonly<{
    model: KnownModel;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): DetectedModel | null {
  const { model } = input;
  const selectionId = model.catalogModelId ?? model.name;
  return exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId,
    ...(model.catalogProvider === undefined ? {} : { sourceProviderId: model.catalogProvider }),
  });
}

function mergeRuntimeMetadata(
  runtime: DetectedModel,
  modelsDev: DetectedModel | null,
): DetectedModel {
  if (modelsDev === null) return runtime;
  return { ...modelsDev, ...runtime };
}

function stripUnpricedFields(
  providerId: ProviderId,
  entry: ResolvedModelCatalogEntry,
): ResolvedModelCatalogEntry {
  if (isApiPricedProvider(providerId)) return entry;
  const {
    pricingInput: _pricingInput,
    pricingOutput: _pricingOutput,
    pricingCacheRead: _pricingCacheRead,
    pricingCacheWrite: _pricingCacheWrite,
    pricingTiers: _pricingTiers,
    isFree: _isFree,
    ...unpriced
  } = entry;
  return unpriced;
}

function runtimeEntry(
  input: Readonly<{
    runnerId: ProviderId;
    runtimeProviderId: ProviderId;
    model: DetectedModel;
    nativeOrder: number;
    isStale: boolean;
    modelsDevEntries: readonly DetectedModel[];
    matchMetadataAcrossOwners: boolean;
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = ownerFor(input.model, input.runtimeProviderId);
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.model.id,
    sourceProviderId:
      input.matchMetadataAcrossOwners && input.model.id.includes('/')
        ? undefined
        : sourceProviderId,
    modelsDevEntries: input.modelsDevEntries,
  });
  const merged = mergeRuntimeMetadata(input.model, metadata);
  return stripUnpricedFields(input.runnerId, {
    ...merged,
    id: input.model.id,
    selectionId: input.model.id,
    runnerId: input.runnerId,
    sourceProviderId,
    isDetected: !input.isStale,
    nativeOrder: input.model.nativeOrder ?? input.nativeOrder,
    source: 'runtime',
    membership: input.isStale ? 'stale' : 'confirmed',
    ...(input.isStale ? { isStale: true } : {}),
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function modelsDevSuggestion(
  input: Readonly<{
    runnerId: ProviderId;
    model: DetectedModel;
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = ownerFor(input.model, input.runnerId);
  return stripUnpricedFields(input.runnerId, {
    ...input.model,
    id: input.model.id,
    selectionId: input.model.id,
    runnerId: input.runnerId,
    sourceProviderId,
    isDetected: false,
    source: 'models-dev',
    membership: 'catalog-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function bundledSuggestion(
  input: Readonly<{
    runnerId: ProviderId;
    model: KnownModel;
    modelsDevEntries: readonly DetectedModel[];
    keepBundledDefault: boolean;
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = input.runnerId;
  const metadata = metadataForBundledModel({
    model: input.model,
    modelsDevEntries: input.modelsDevEntries,
  });
  const base: DetectedModel = {
    id: input.model.name,
    ...(input.model.contextLength === undefined
      ? {}
      : { contextLength: input.model.contextLength }),
    ...(input.model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.model.maxOutputTokens }),
    ...(input.model.pricingInput === undefined ? {} : { pricingInput: input.model.pricingInput }),
    ...(input.model.pricingOutput === undefined
      ? {}
      : { pricingOutput: input.model.pricingOutput }),
    ...(input.model.pricingCacheRead === undefined
      ? {}
      : { pricingCacheRead: input.model.pricingCacheRead }),
    ...(input.model.pricingCacheWrite === undefined
      ? {}
      : { pricingCacheWrite: input.model.pricingCacheWrite }),
    ...(input.model.isFree === undefined ? {} : { isFree: input.model.isFree }),
  };
  const merged = metadata === null ? base : { ...metadata, ...base };
  return stripUnpricedFields(input.runnerId, {
    ...merged,
    id: input.model.name,
    selectionId: input.model.name,
    runnerId: input.runnerId,
    sourceProviderId,
    ...(input.keepBundledDefault && input.model.isDefault ? { isDefault: true } : {}),
    isDetected: false,
    source: 'bundled-fallback',
    membership: 'bundled-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function configuredRecovery(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
  }>,
): ResolvedModelCatalogEntry {
  return stripUnpricedFields(input.runnerId, {
    id: input.selectionId,
    selectionId: input.selectionId,
    runnerId: input.runnerId,
    sourceProviderId: input.runnerId,
    isDetected: false,
    isCustom: true,
    source: 'configured-recovery',
    membership: 'custom',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function lifecycleRank(lifecycle: string | undefined): number {
  return lifecycle?.toLowerCase() === 'deprecated' ? 1 : 0;
}

function compareSuggestions(
  left: ResolvedModelCatalogEntry,
  right: ResolvedModelCatalogEntry,
): number {
  const lifecycleDifference = lifecycleRank(left.lifecycle) - lifecycleRank(right.lifecycle);
  if (lifecycleDifference !== 0) return lifecycleDifference;

  const releaseDifference = (right.releaseDate ?? '').localeCompare(left.releaseDate ?? '');
  if (releaseDifference !== 0) return releaseDifference;

  const displayDifference = (left.displayName ?? left.id).localeCompare(
    right.displayName ?? right.id,
  );
  if (displayDifference !== 0) return displayDifference;

  const idDifference = left.id.localeCompare(right.id);
  if (idDifference !== 0) return idDifference;
  return left.sourceProviderId.localeCompare(right.sourceProviderId);
}

function runtimeModels(
  providerId: ProviderId,
  cache: ModelCacheAccessor,
  role: ActiveRunnerRole | undefined,
): ReturnType<typeof getRuntimeModelSnapshot> {
  return getRuntimeModelSnapshot({ providerId, cache, role });
}

function configuredSelectionId(
  input: Readonly<{ providerId: ProviderId; selectionId: string | undefined }>,
): string | null {
  if (
    input.selectionId === undefined ||
    input.selectionId.trim() === '' ||
    isAutomaticModel(input.selectionId, input.providerId)
  ) {
    return null;
  }
  return input.selectionId;
}

function usesNativeCliModelDiscovery(providerId: ProviderId): boolean {
  return (
    isCliToolId(providerId) && CLI_TOOL_CATALOG[providerId].modelDiscoveryMode === 'native-cli'
  );
}

function hasExactSelection(
  entries: readonly ResolvedModelCatalogEntry[],
  selectionId: string,
): boolean {
  return entries.some((entry) =>
    areExactModelSelectionIdsEqual({ left: entry.selectionId, right: selectionId }),
  );
}

function resolveCatalogEntries(
  input: Readonly<{
    providerId: ProviderId;
    cache: ModelCacheAccessor;
    configuredSelectionId?: string | undefined;
    role?: ActiveRunnerRole | undefined;
  }>,
): ResolvedModelCatalogEntry[] {
  const { providerId, cache } = input;
  const modelsDevEntries = getModelsDevEntries(providerId, cache);
  const runtimeSnapshot = runtimeModels(providerId, cache, input.role);
  const runtime = runtimeSnapshot?.entries ?? [];
  const runtimeRows: ResolvedModelCatalogEntry[] = [];
  const runtimeKeys = new Set<string>();
  const runtimeConfirmed = runtime.length > 0 && runtimeSnapshot?.isStale !== true;

  runtime.forEach((model, nativeOrder) => {
    const owner = ownerFor(model, runtimeSnapshot?.providerId ?? providerId);
    const key = entryKey({ owner, selectionId: model.id });
    if (runtimeKeys.has(key)) return;
    runtimeKeys.add(key);
    runtimeRows.push(
      runtimeEntry({
        runnerId: providerId,
        runtimeProviderId: runtimeSnapshot?.providerId ?? providerId,
        model,
        nativeOrder,
        isStale: runtimeSnapshot?.isStale ?? false,
        modelsDevEntries,
        matchMetadataAcrossOwners: usesNativeCliModelDiscovery(providerId) && runtimeConfirmed,
      }),
    );
  });

  const modelsDevRows: ResolvedModelCatalogEntry[] = [];
  const modelsDevKeys = new Set<string>();
  const bundledRows: ResolvedModelCatalogEntry[] = [];
  const bundledKeys = new Set<string>();
  if (!runtimeConfirmed) {
    for (const model of modelsDevEntries) {
      const key = entryKey({ owner: ownerFor(model, providerId), selectionId: model.id });
      if (runtimeKeys.has(key) || modelsDevKeys.has(key)) continue;
      modelsDevKeys.add(key);
      modelsDevRows.push(modelsDevSuggestion({ runnerId: providerId, model }));
    }

    const keepBundledDefault = runtimeSnapshot === null;
    for (const model of getBundledModels(providerId)) {
      const owner = providerId;
      const key = entryKey({ owner, selectionId: model.name });
      if (runtimeKeys.has(key) || modelsDevKeys.has(key) || bundledKeys.has(key)) continue;
      bundledKeys.add(key);
      bundledRows.push(
        bundledSuggestion({
          runnerId: providerId,
          model,
          modelsDevEntries,
          keepBundledDefault,
        }),
      );
    }
  }

  const catalogRows = [
    ...runtimeRows,
    ...modelsDevRows.sort(compareSuggestions),
    ...bundledRows.sort(compareSuggestions),
  ];
  const configured = configuredSelectionId({
    providerId,
    selectionId: input.configuredSelectionId,
  });
  if (configured === null || hasExactSelection(catalogRows, configured)) return catalogRows;

  return [configuredRecovery({ runnerId: providerId, selectionId: configured }), ...catalogRows];
}

export function resolveModelCatalog(
  providerId: string,
  options: ResolveModelCatalogOptions = {},
): ResolvedModelCatalogEntry[] {
  if (!isProviderId(providerId)) return [];
  return resolveCatalogEntries({
    providerId,
    cache: options.cache ?? NULL_CACHE,
    configuredSelectionId: options.configuredSelectionId,
    role: options.role,
  });
}
