import type { DetectedModel } from '../../../core/discovery/detection.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  canonicalModelBucket,
  isSameCanonicalModel,
  type ModelIdentity,
} from '../../../core/providers/canonical-model-id.js';
import { TOOL_EFFORT_LADDERS, type KnownModel } from '../../../core/providers/known-models.js';
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
import { areExactModelSelectionIdsEqual, matchesModelsDevId } from './parsing.js';

export type ResolvedModelSource =
  | 'models-dev'
  | 'runtime'
  | 'bundled-fallback'
  | 'account-options'
  | 'configured-recovery';
/** The models.dev catalog lane's membership — produced for `api` runners only (REQ-B08). */
export const CATALOG_SUGGESTION_MEMBERSHIP = 'catalog-suggestion';

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
  /** The catalog id a documented alias resolves to; absent when the row's own id already is one. */
  readonly catalogModelId?: string;
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

function isChatCapable(model: DetectedModel): boolean {
  if (model.supportsToolCalls === false) return false;
  return model.outputModalities === undefined || model.outputModalities.includes('text');
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
      matchesModelsDevId({ left: entry.id, right: input.selectionId }) &&
      (input.sourceProviderId === undefined || entry.providerId === input.sourceProviderId),
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

/**
 * The row's own owner is tried first, then any owner: a runner whose models.dev
 * vendor is not its runner id (`copilot` → `github-copilot`) only ever matches
 * on the second try, and an id two vendors both serve stays ambiguous there —
 * so relaxing the owner can add metadata but never swap one row's for another's.
 */
function metadataForSelection(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    sourceProviderId: string;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): DetectedModel | null {
  const direct =
    exactModelsDevMetadata({
      entries: input.modelsDevEntries,
      selectionId: input.selectionId,
      sourceProviderId: input.sourceProviderId,
    }) ??
    exactModelsDevMetadata({
      entries: input.modelsDevEntries,
      selectionId: input.selectionId,
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
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = ownerFor(input.model, input.runtimeProviderId);
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.model.id,
    sourceProviderId,
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
    membership: CATALOG_SUGGESTION_MEMBERSHIP,
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
  // A row that names the catalog id it is enriched from has said where its numbers live, so the
  // catalog's window wins there and the declared one is the offline answer only — what the row
  // shows before a catalog loads and the floor `bundledMinimumWindow` reads (REQ-D26). Without
  // this, a claude-code alias would print its own copy of a number models.dev is re-publishing,
  // and the two would drift apart on their own schedules. A row that declares a window and names
  // no catalog id keeps it: there the tool's own probe is the authority on what the tool accepts.
  const declaredWindow =
    input.model.catalogModelId !== undefined && metadata?.contextLength !== undefined
      ? undefined
      : input.model.contextLength;
  const base: DetectedModel = {
    id: input.model.name,
    // The alias is the only thing that tells these rows apart, so its own identity outranks the
    // enrichment: four claude-code aliases resolve to one models.dev row and would otherwise all
    // paint that row's name. Numbers still arrive from `metadata`.
    ...(input.model.displayName === undefined ? {} : { displayName: input.model.displayName }),
    ...(input.model.detail === undefined ? {} : { detail: input.model.detail }),
    ...(declaredWindow === undefined ? {} : { contextLength: declaredWindow }),
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
    // A bundled row whose own id already is the catalog id would restate itself,
    // so only a true alias carries the id it resolves to.
    ...(input.model.catalogModelId !== undefined && input.model.catalogModelId !== input.model.name
      ? { catalogModelId: input.model.catalogModelId }
      : {}),
    ...(input.keepBundledDefault && input.model.isDefault ? { isDefault: true } : {}),
    isDetected: false,
    nativeOrder: input.nativeOrder,
    source: 'bundled-fallback',
    membership: 'bundled-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

const DESCRIPTION_SEGMENT = ' · ';

function versionedOptionLabel(option: ClaudeCodeModelOption): string | undefined {
  const label = option.displayName;
  if (label === undefined) return undefined;
  const first = option.description?.split(DESCRIPTION_SEGMENT)[0]?.trim();
  if (first === undefined || first.length <= label.length) return label;
  return first.toLowerCase().startsWith(label.toLowerCase()) ? first : label;
}

/**
 * An account description that opens by naming the model restates the name its own row already
 * prints, and the repeat is charged to the name column on every row that carries one. The
 * leading segment goes; what is left is the only part of the cell the row had not said yet.
 */
function peelDescriptionNameRepeat(description: string, name: string): string {
  const [lead, ...rest] = description.split(DESCRIPTION_SEGMENT);
  if (lead === undefined || rest.length === 0) return description;
  const head = lead.trim().toLowerCase();
  const printed = name.trim().toLowerCase();
  if (head === '' || printed === '') return description;
  if (!head.startsWith(printed) && !printed.startsWith(head)) return description;
  const peeled = rest.join(DESCRIPTION_SEGMENT).trim();
  return peeled === '' ? description : peeled;
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
    sourceProviderId: input.runnerId,
    modelsDevEntries: input.modelsDevEntries,
  });
  // The option takes every published fact of the row it strips to — window, effort ladder, output
  // cap, release date — so one model never renders two rows that disagree. The name is the one
  // thing it keeps: the cache's own word, versioned by its own description when that names the
  // version, or the id itself, never the catalog's.
  const { displayName: _catalogName, ...facts } = metadata ?? {};
  const label = versionedOptionLabel(input.option);
  const description = input.option.description;
  const detail =
    description === undefined || label === undefined
      ? description
      : peelDescriptionNameRepeat(description, label);
  const base: DetectedModel = {
    id: input.option.id,
    ...(label === undefined ? {} : { displayName: label }),
    ...(detail === undefined ? {} : { detail }),
  };
  return stripUnpricedFields({
    ...facts,
    ...base,
    selectionId: input.option.id,
    runnerId: input.runnerId,
    sourceProviderId: input.runnerId,
    isDetected: false,
    source: 'account-options',
    membership: 'bundled-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function configuredRecovery(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): ResolvedModelCatalogEntry {
  // A configured id no lane lists is still a model the catalog may know — a full
  // `claude-opus-5` beside the aliases, say — so it takes the catalog's window rather than
  // rendering a blank size cell beside nine complete rows. The name it does not take: the id
  // reads in the tool's own vocabulary through `formatModelName`, where models.dev's
  // `Claude Haiku 4.5 (latest)` would print a second naming system one line above the `Haiku 4.5`
  // alias row for the same model.
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.selectionId,
    sourceProviderId: input.runnerId,
    modelsDevEntries: input.modelsDevEntries,
  });
  return stripUnpricedFields({
    ...(metadata?.contextLength === undefined ? {} : { contextLength: metadata.contextLength }),
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

/**
 * Claude writes its own account cache in resolved form — the model id the alias points at plus
 * the alias's own window suffix (`fable[1m]` → `claude-fable-5-1[1m]`). An entry spelled that way
 * names an alias the list already shows, so it folds into that row instead of painting a second —
 * but only when one alias answers to it. Three aliases resolve to `claude-opus-5`, and folding
 * into whichever is declared first would delete a selectable row and gloss an arbitrary sibling.
 * The suffix is read off the alias verbatim rather than matched: which brackets exist is
 * `parsing.ts`'s vocabulary, and a second copy of it here would be a build behind the day one
 * more window ships.
 */
function aliasAnsweringToOptionId(
  providerId: ProviderId,
  optionId: string,
): KnownModel | undefined {
  const matches = getBundledModels(providerId).filter((model) => {
    const bracket = model.name.indexOf('[');
    const suffix = bracket === -1 ? '' : model.name.slice(bracket);
    return (
      `${model.catalogModelId ?? model.name}${suffix}`.toLowerCase() === optionId.toLowerCase()
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The account's description enriches an alias that has none. An alias that wrote its own detail
 * keeps it: `forces the 1M window` is what tells a `[1m]` row from the plain one, while the
 * account's sentence describes the model underneath and reads the same on both.
 */
function withAliasDetail(
  entry: ResolvedModelCatalogEntry,
  details: ReadonlyMap<string, string>,
): ResolvedModelCatalogEntry {
  if (entry.detail !== undefined) return entry;
  const description = details.get(entry.selectionId);
  if (description === undefined) return entry;
  return {
    ...entry,
    detail: peelDescriptionNameRepeat(description, entry.displayName ?? entry.id),
  };
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
    if (!isChatCapable(model)) return;
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
  const aliasDetails = new Map<string, string>();
  if (lanes.claudeCodeOptions) {
    for (const option of cache.getClaudeCodeModelOptions?.() ?? []) {
      if (indexNamesSameModel(runtimeIndex, { id: option.id, owner: providerId })) continue;
      const alias = aliasAnsweringToOptionId(providerId, option.id);
      if (
        alias !== undefined &&
        bundledKeys.has(entryKey({ owner: providerId, selectionId: alias.name }))
      ) {
        if (option.description !== undefined) aliasDetails.set(alias.name, option.description);
        continue;
      }
      claudeCodeOptionRows.push(
        claudeCodeOptionEntry({ runnerId: providerId, option, modelsDevEntries }),
      );
    }
  }

  const catalogRows = [
    ...runtimeRows,
    ...modelsDevRows.sort(compareSuggestions),
    ...bundledRows.sort(compareSuggestions).map((row) => withAliasDetail(row, aliasDetails)),
    ...claudeCodeOptionRows,
  ];
  const configured = configuredSelectionId({
    providerId,
    selectionId: input.configuredSelectionId,
  });
  if (configured === null || hasExactSelection(catalogRows, configured)) return catalogRows;

  return [
    configuredRecovery({ runnerId: providerId, selectionId: configured, modelsDevEntries }),
    ...catalogRows,
  ];
}

/**
 * A tool's own flag ladder is the floor for a row no catalog knows. A row that already
 * carries a ladder keeps it — including an empty one, which means the model publishes
 * no named levels (models.dev gives `claude-haiku-4-5` only a token budget).
 */
function withToolEffortFloor(
  providerId: ProviderId,
  entries: ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const ladder = TOOL_EFFORT_LADDERS[providerId];
  if (ladder === undefined) return entries;
  return entries.map((entry) =>
    entry.nativeReasoningEfforts === undefined
      ? { ...entry, nativeReasoningEfforts: [...ladder.levels] }
      : entry,
  );
}

export function resolveModelCatalog(
  providerId: string,
  options: ResolveModelCatalogOptions = {},
): ResolvedModelCatalogEntry[] {
  if (!isProviderId(providerId)) return [];
  return withToolEffortFloor(
    providerId,
    resolveCatalogEntries({
      providerId,
      cache: options.cache ?? NULL_CACHE,
      configuredSelectionId: options.configuredSelectionId,
      role: options.role,
      browseCatalog: options.browseCatalog,
    }),
  );
}
