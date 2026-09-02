import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { variantChoicesForModelId } from '../../../core/runners/variant-vocabulary.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  resolveModelCatalog,
  type ResolvedModelCatalogEntry,
  type ResolvedModelMembership,
} from '../../../engine/providers/model/catalog.js';
import {
  canonicalModelBucket,
  isSameCanonicalModel,
  type ModelIdentity,
} from '../../../core/providers/canonical-model-id.js';
import { resolveModelDisplayName } from '../../../core/discovery/model-catalog.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import type { PickerOption } from './options.js';
import { mergeOptionFamilies } from './option-merge.js';
import { mergeProviderVariants } from './provider-merge.js';
import { sortModelsByRecency, type ModelOption } from './recency.js';

// A selection policy, not catalog data: it carries no context length, pricing,
// release date or provenance, and is synthesized per render rather than merged.
const AUTOMATIC_MODEL_OPTION: ModelOption = Object.freeze({ id: AUTOMATIC_MODEL });

export interface PickerModelCounts {
  readonly confirmed: number;
  readonly stale: number;
  readonly suggestions: number;
  readonly bundled: number;
  readonly custom: number;
}

/**
 * Counts state enumeration truth: a provider-merged row contributes one tally
 * per variant, so "N models detected" never deflates when rows collapse.
 */
export function countModelOptions(models: readonly ModelOption[]): PickerModelCounts {
  let confirmed = 0;
  let stale = 0;
  let suggestions = 0;
  let bundled = 0;
  let custom = 0;

  const tally = (
    membership: ResolvedModelMembership | undefined,
    isCustom: boolean | undefined,
  ): void => {
    if (isCustom === true || membership === 'custom') custom += 1;
    switch (membership) {
      case 'confirmed':
        confirmed += 1;
        break;
      case 'stale':
        stale += 1;
        break;
      case 'catalog-suggestion':
        suggestions += 1;
        break;
      case 'bundled-suggestion':
        bundled += 1;
        break;
      case 'custom':
      case undefined:
        break;
    }
  };

  for (const model of models) {
    if (model.variants === undefined || model.variants.length === 0) {
      tally(model.membership, model.isCustom);
      continue;
    }
    for (const variant of model.variants) {
      tally(variant.membership ?? model.membership, variant.isCustom);
    }
  }

  return { confirmed, stale, suggestions, bundled, custom };
}

/** True when the row is, or one of its provider variants is, the given full id. */
export function modelRowMatchesId(row: ModelOption, fullId: string): boolean {
  if (row.id === fullId) return true;
  return row.variants?.some((variant) => variant.fullId === fullId) ?? false;
}

function mergeModelOptions(custom: ModelOption[], known: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();

  for (const model of known) {
    byId.set(model.id, model);
  }

  for (const model of custom) {
    const existing = byId.get(model.id);
    byId.set(model.id, existing ? { ...existing, isCustom: true } : { ...model, isCustom: true });
  }

  return sortModelsByRecency([...byId.values()]);
}

function toModelOption(entry: ReturnType<typeof resolveModelCatalog>[number]): ModelOption {
  const displayName = resolveModelDisplayName(entry);
  return {
    id: entry.id,
    ...(displayName !== entry.id ? { displayName } : {}),
    isDefault: entry.isDefault,
    isDetected: entry.membership === 'confirmed',
    membership: entry.membership,
    ...(entry.isStale ? { isStale: true } : {}),
    ...(entry.nativeOrder === undefined ? {} : { nativeOrder: entry.nativeOrder }),
    ...(entry.source === 'configured-recovery' ? { isRecovery: true } : {}),
    contextLength: entry.contextLength,
    releaseDate: entry.releaseDate,
  };
}

function identityOf(entry: ResolvedModelCatalogEntry): ModelIdentity {
  return { id: entry.selectionId, owner: entry.sourceProviderId };
}

/** Candidates that share a last canonical segment — every match has one. */
function bucketOf(
  buckets: Map<string, ResolvedModelCatalogEntry[]>,
  identity: ModelIdentity,
): ResolvedModelCatalogEntry[] {
  const key = canonicalModelBucket(identity);
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created: ResolvedModelCatalogEntry[] = [];
  buckets.set(key, created);
  return created;
}

/**
 * Two runtime rows are two routes the tool really offers — `anthropic/x` and
 * `openrouter/anthropic/x` bill differently — so they collapse only on an exact
 * id, and `mergeProviderVariants` owns the multi-route row. Everything
 * speculative folds into whatever the runtime lane already names.
 */
function dedupeAgainstRuntime(
  entries: readonly ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const buckets = new Map<string, ResolvedModelCatalogEntry[]>();
  const runtimeIds = new Set<string>();
  const runtime: ResolvedModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.source !== 'runtime' || runtimeIds.has(entry.selectionId)) continue;
    runtimeIds.add(entry.selectionId);
    bucketOf(buckets, identityOf(entry)).push(entry);
    runtime.push(entry);
  }

  const rest: ResolvedModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.source === 'runtime') continue;
    const identity = identityOf(entry);
    const bucket = bucketOf(buckets, identity);
    if (bucket.some((earlier) => isSameCanonicalModel(identityOf(earlier), identity))) continue;
    bucket.push(entry);
    rest.push(entry);
  }
  return [...runtime, ...rest];
}

export function resolveAndSort(
  providerId: string,
  role: ActiveRunnerRole,
  cache: ModelCacheAccessor = NULL_CACHE,
  options: Readonly<{
    configuredSelectionId?: string | undefined;
    browseCatalog?: boolean | undefined;
  }> = {},
): ModelOption[] {
  const entries = resolveModelCatalog(providerId, {
    cache,
    role,
    configuredSelectionId: options.configuredSelectionId,
    browseCatalog: options.browseCatalog,
  });
  return sortModelsByRecency(dedupeAgainstRuntime(entries).map(toModelOption));
}

/**
 * A merged row spans several routes and each provider spells its own presets, so
 * the ladder hangs off the route rather than off the row's representative id.
 */
function withVariantChoices(row: ModelOption): ModelOption {
  const variants = row.variants;
  if (variants === undefined) return row;
  return {
    ...row,
    variants: variants.map((variant) => {
      const variantChoices = variantChoicesForModelId(variant.fullId);
      return variantChoices.length === 0 ? variant : { ...variant, variantChoices };
    }),
  };
}

export function buildRightModels(params: {
  role: ActiveRunnerRole;
  customModels: readonly string[];
  currentItem: PickerOption | undefined;
  cache?: ModelCacheAccessor;
  persistedModel?: string | undefined;
  providerAuth?: CliProviderAuth | undefined;
  browseCatalog?: boolean | undefined;
}): ModelOption[] {
  if (!params.currentItem) {
    return params.customModels.map(
      (id): ModelOption => ({ id, isCustom: true, membership: 'custom' }),
    );
  }

  const capability = params.currentItem.modelCapability;
  if (!capability.showsDiscovered && !capability.allowsCustom && !capability.allowsAutomatic) {
    return [];
  }

  const cache = params.cache ?? NULL_CACHE;
  // The seat's model belongs to the seat's tool: recovering it onto a tool the
  // cursor is merely visiting would offer, and then save, an id that tool cannot run.
  const configuredSelectionId =
    params.currentItem.isCurrent === true ? params.persistedModel : undefined;
  const knownModels = capability.showsDiscovered
    ? resolveAndSort(params.currentItem.id, params.role, cache, {
        configuredSelectionId,
        browseCatalog: params.browseCatalog,
      })
    : [];
  const customOptions: ModelOption[] = capability.allowsCustom
    ? params.customModels
        .filter((id) => !isAutomaticModel(id))
        .map((id): ModelOption => ({ id, isCustom: true, membership: 'custom' }))
    : [];

  const merged = mergeModelOptions(customOptions, knownModels);
  const families = mergeOptionFamilies(merged, {
    persistedModel: params.persistedModel,
    customModels: params.customModels,
  });
  const routed =
    params.currentItem.providerDependent === true
      ? mergeProviderVariants(families, {
          persistedModel: params.persistedModel,
          customModels: params.customModels,
          providerAuth: params.providerAuth,
        })
      : families;
  const rows =
    params.currentItem.effortChannel === 'variant' ? routed.map(withVariantChoices) : routed;
  // Automatic selection is structural, never a catalog row: cursor's native list
  // ships its own `auto` line, which would otherwise duplicate the synthesized
  // option — same id, same list key.
  const listed = rows.filter((row) => !isAutomaticModel(row.id));
  return capability.allowsAutomatic ? [AUTOMATIC_MODEL_OPTION, ...listed] : listed;
}

export function isCurrentConfig(
  item: PickerOption,
  config: Config,
  role: ActiveRunnerRole,
): boolean {
  const runnerConfig = readActiveRunner({ config, role });
  if (item.kind === 'custom-command') {
    return runnerConfig.kind === 'shell' || runnerConfig.kind === 'agent';
  }
  return item.id === getRunnerDisplayName(runnerConfig);
}
