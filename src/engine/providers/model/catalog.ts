import type { DetectedModel } from '../../../core/discovery/detection.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  canonicalModelBucket,
  isSameCanonicalModel,
  type ModelIdentity,
} from '../../../core/providers/canonical-model-id.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { isProviderId, type ProviderId } from '../../../core/schemas/enums.js';
import { getPricingMode, type PricingMode } from '../pricing-resolver.js';
import type { ClaudeCodeModelOption } from '../../../core/providers/claude-code-options.js';
import { modelRowLanes } from './lane-policy.js';
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
  readonly browseCatalog?: boolean | undefined;
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
  if (known === undefined || known.catalogProvider === undefined) return null;
  return exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId: known.catalogModelId ?? known.name,
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

/**
 * No runner that owns a catalog meters per token — CLI tools bill their own
 * subscription, `ollama`/`lm-studio` are local, `shell`/`agent` name no model —
 * so a catalog row never carries rates, whatever metadata it merged.
 */
function stripUnpricedFields(entry: ResolvedModelCatalogEntry): ResolvedModelCatalogEntry {
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
    sourceProviderId: input.matchMetadataAcrossOwners ? undefined : sourceProviderId,
    modelsDevEntries: input.modelsDevEntries,
  });
  const merged = mergeRuntimeMetadata(input.model, metadata);
  return stripUnpricedFields({
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
  return stripUnpricedFields({
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
    nativeOrder: number;
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
  return stripUnpricedFields({
    ...merged,
    id: input.model.name,
    selectionId: input.model.name,
    runnerId: input.runnerId,
    sourceProviderId,
    ...(input.keepBundledDefault && input.model.isDefault ? { isDefault: true } : {}),
    isDetected: false,
    nativeOrder: input.nativeOrder,
    source: 'bundled-fallback',
    membership: 'bundled-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function claudeCodeOptionEntry(
  input: Readonly<{
    runnerId: ProviderId;
    option: ClaudeCodeModelOption;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): ResolvedModelCatalogEntry {
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.option.id,
    sourceProviderId: undefined,
    modelsDevEntries: input.modelsDevEntries,
  });
  const base: DetectedModel = {
    id: input.option.id,
    ...(input.option.displayName === undefined ? {} : { displayName: input.option.displayName }),
  };
  const merged = metadata === null ? base : { ...metadata, ...base };
  return stripUnpricedFields({
    ...merged,
    id: input.option.id,
    selectionId: input.option.id,
    runnerId: input.runnerId,
    sourceProviderId: input.runnerId,
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
  return stripUnpricedFields({
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

function hasExactSelection(
  entries: readonly ResolvedModelCatalogEntry[],
  selectionId: string,
): boolean {
  return entries.some((entry) =>
    areExactModelSelectionIdsEqual({ left: entry.selectionId, right: selectionId }),
  );
}

function identityOf(entry: ResolvedModelCatalogEntry): ModelIdentity {
  return { id: entry.selectionId, owner: entry.sourceProviderId };
}

/**
 * Candidates bucketed by their last canonical segment, so a dedup pass compares
 * an entry only against the rows that could possibly name the same model.
 */
type CanonicalIndex = Map<string, ResolvedModelCatalogEntry[]>;

function indexCanonically(index: CanonicalIndex, entry: ResolvedModelCatalogEntry): void {
  const key = canonicalModelBucket(identityOf(entry));
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [entry]);
  else bucket.push(entry);
}

/**
 * A provider-qualified runtime id (`openrouter/deepseek/x`) names the same
 * selection as its owner's shorter catalog id (`deepseek/x`, `x:free`).
 */
function indexNamesSameModel(index: CanonicalIndex, identity: ModelIdentity): boolean {
  const bucket = index.get(canonicalModelBucket(identity));
  if (bucket === undefined) return false;
  return bucket.some((row) => isSameCanonicalModel(identityOf(row), identity));
}

function dedupeCanonically(
  entries: readonly ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const index: CanonicalIndex = new Map();
  const kept: ResolvedModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (indexNamesSameModel(index, identityOf(entry))) continue;
    indexCanonically(index, entry);
    kept.push(entry);
  }
  return kept;
}

function resolveCatalogEntries(
  input: Readonly<{
    providerId: ProviderId;
    cache: ModelCacheAccessor;
    configuredSelectionId?: string | undefined;
    role?: ActiveRunnerRole | undefined;
    browseCatalog?: boolean | undefined;
  }>,
): ResolvedModelCatalogEntry[] {
  const { providerId, cache } = input;
  const modelsDevEntries = getModelsDevEntries(providerId, cache);
  const runtimeSnapshot = runtimeModels(providerId, cache, input.role);
  const runtime = runtimeSnapshot?.entries ?? [];
  const runtimeRows: ResolvedModelCatalogEntry[] = [];
  const runtimeKeys = new Set<string>();
  const runtimeIndex: CanonicalIndex = new Map();
  const lanes = modelRowLanes({
    providerId,
    hasRuntimeList: runtime.length > 0,
    browseCatalog: input.browseCatalog,
  });

  runtime.forEach((model, nativeOrder) => {
    const owner = ownerFor(model, runtimeSnapshot?.providerId ?? providerId);
    const key = entryKey({ owner, selectionId: model.id });
    if (runtimeKeys.has(key)) return;
    runtimeKeys.add(key);
    const row = runtimeEntry({
      runnerId: providerId,
      runtimeProviderId: runtimeSnapshot?.providerId ?? providerId,
      model,
      nativeOrder,
      isStale: runtimeSnapshot?.isStale ?? false,
      modelsDevEntries,
      matchMetadataAcrossOwners: !lanes.modelsDev,
    });
    runtimeRows.push(row);
    indexCanonically(runtimeIndex, row);
  });

  const modelsDevRows: ResolvedModelCatalogEntry[] = [];
  const modelsDevKeys = new Set<string>();
  if (lanes.modelsDev) {
    for (const model of modelsDevEntries) {
      const owner = ownerFor(model, providerId);
      const key = entryKey({ owner, selectionId: model.id });
      if (modelsDevKeys.has(key)) continue;
      if (indexNamesSameModel(runtimeIndex, { id: model.id, owner })) continue;
      modelsDevKeys.add(key);
      modelsDevRows.push(modelsDevSuggestion({ runnerId: providerId, model }));
    }
  }

  const bundledRows: ResolvedModelCatalogEntry[] = [];
  const bundledKeys = new Set<string>();
  if (lanes.bundled) {
    const keepBundledDefault = runtimeSnapshot === null;
    for (const [nativeOrder, model] of getBundledModels(providerId).entries()) {
      const key = entryKey({ owner: providerId, selectionId: model.name });
      if (modelsDevKeys.has(key) || bundledKeys.has(key)) continue;
      if (indexNamesSameModel(runtimeIndex, { id: model.name, owner: providerId })) continue;
      bundledKeys.add(key);
      bundledRows.push(
        bundledSuggestion({
          runnerId: providerId,
          model,
          modelsDevEntries,
          keepBundledDefault,
          nativeOrder,
        }),
      );
    }
  }

  const claudeCodeOptionRows: ResolvedModelCatalogEntry[] = [];
  if (lanes.claudeCodeOptions) {
    for (const option of cache.getClaudeCodeModelOptions?.() ?? []) {
      if (indexNamesSameModel(runtimeIndex, { id: option.id, owner: providerId })) continue;
      claudeCodeOptionRows.push(
        claudeCodeOptionEntry({ runnerId: providerId, option, modelsDevEntries }),
      );
    }
  }

  const catalogRows = [
    ...runtimeRows,
    ...dedupeCanonically([
      ...modelsDevRows.sort(compareSuggestions),
      ...bundledRows.sort(compareSuggestions),
      ...claudeCodeOptionRows,
    ]),
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
    browseCatalog: options.browseCatalog,
  });
}
