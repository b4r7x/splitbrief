import type { ActiveRunnerRole } from '../../../core/runners/cli-tool-catalog.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  resolveModelCatalog,
  type ResolvedModelMembership,
} from '../../../engine/providers/model/catalog.js';
import { resolveModelDisplayName } from '../../../core/discovery/model-catalog.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import type { PickerOption } from './options.js';
import { mergeOptionFamilies } from './option-axis.js';
import {
  compactProviderTag,
  modelBareId,
  modelProviderAuthKey,
  modelProviderPrefix,
  resolveProviderAuthState,
} from './provider-axis.js';
import { sortModelsByRecency, type ModelOption, type ModelVariant } from './recency.js';

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

const MEMBERSHIP_RANK = {
  confirmed: 0,
  stale: 1,
  'catalog-suggestion': 2,
  'bundled-suggestion': 3,
  custom: 4,
} as const satisfies Record<ResolvedModelMembership, number>;

interface ProviderVariantSource {
  readonly row: ModelOption;
  readonly prefix: string;
}

interface ProviderMergeContext {
  readonly persistedModel: string | undefined;
  readonly customModels: readonly string[];
  readonly providerAuth: CliProviderAuth | undefined;
}

function toVariant(source: ProviderVariantSource): ModelVariant {
  return {
    fullId: source.row.id,
    providerPrefix: source.prefix,
    tag: compactProviderTag(source.prefix),
    ...(source.row.displayName !== undefined ? { displayName: source.row.displayName } : {}),
    ...(source.row.membership === undefined ? {} : { membership: source.row.membership }),
    ...(source.row.isCustom ? { isCustom: true } : {}),
  };
}

function sortVariantsConfiguredFirst(
  variants: readonly ModelVariant[],
  providerAuth: CliProviderAuth | undefined,
): readonly ModelVariant[] {
  // Only a read listing names configured providers; an empty or unreadable one
  // claims no auth state, so the recency order stands.
  if (providerAuth?.kind !== 'read') return variants;
  const facts = providerAuth.facts;
  const needsSignIn = (variant: ModelVariant): number => {
    const authKey = modelProviderAuthKey(variant.fullId);
    if (authKey === undefined) return 1;
    return resolveProviderAuthState(authKey, facts) === 'configured' ? 0 : 1;
  };
  return variants.toSorted((a, b) => needsSignIn(a) - needsSignIn(b));
}

function bestMembership(rows: readonly ModelOption[]): ResolvedModelMembership | undefined {
  let best: ResolvedModelMembership | undefined;
  for (const row of rows) {
    if (row.membership === undefined) continue;
    if (best === undefined || MEMBERSHIP_RANK[row.membership] < MEMBERSHIP_RANK[best]) {
      best = row.membership;
    }
  }
  return best;
}

function mergeGroupRows(
  first: ProviderVariantSource,
  rest: readonly ProviderVariantSource[],
  ctx: ProviderMergeContext,
): ModelOption {
  const sources = [first, ...rest];
  const variants = sortVariantsConfiguredFirst(sources.map(toVariant), ctx.providerAuth);
  if (rest.length === 0) return { ...first.row, variants };

  const rows = sources.map((source) => source.row);
  const representative =
    sources.find((source) => source.row.id === ctx.persistedModel)?.row ??
    sources.find((source) => ctx.customModels.includes(source.row.id))?.row ??
    first.row;
  const membership = bestMembership(rows);
  let contextLength: number | undefined;
  let releaseDate: string | undefined;
  for (const row of rows) {
    if (
      row.contextLength !== undefined &&
      (contextLength === undefined || row.contextLength > contextLength)
    ) {
      contextLength = row.contextLength;
    }
    if (
      row.releaseDate !== undefined &&
      (releaseDate === undefined || row.releaseDate > releaseDate)
    ) {
      releaseDate = row.releaseDate;
    }
  }

  const displayName =
    representative.displayName ?? rows.find((row) => row.displayName !== undefined)?.displayName;

  return {
    id: representative.id,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(rows.some((row) => row.isDefault) ? { isDefault: true } : {}),
    ...(membership === undefined ? {} : { membership }),
    ...(membership !== undefined && membership !== 'custom'
      ? { isDetected: membership === 'confirmed' }
      : {}),
    ...(membership === 'stale' ? { isStale: true } : {}),
    ...(rows.some((row) => row.isCustom) ? { isCustom: true } : {}),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    variants,
  };
}

interface ProviderVariantGroup {
  readonly kind: 'group';
  readonly first: ProviderVariantSource;
  readonly rest: ProviderVariantSource[];
}

type MergeSlot = Readonly<{ kind: 'row'; row: ModelOption }> | ProviderVariantGroup;

/**
 * Collapses same-bare-id rows of a provider-dependent tool into one row per
 * model, keeping each group at its most-recent member's position. Unprefixed
 * ids never join a group.
 */
function mergeProviderVariants(
  models: readonly ModelOption[],
  ctx: ProviderMergeContext,
): ModelOption[] {
  const groups = new Map<string, ProviderVariantGroup>();
  const slots: MergeSlot[] = [];
  for (const row of models) {
    const prefix = modelProviderPrefix(row.id);
    if (prefix === undefined) {
      slots.push({ kind: 'row', row });
      continue;
    }
    const bareId = modelBareId(row.id);
    const existing = groups.get(bareId);
    if (existing !== undefined) {
      existing.rest.push({ row, prefix });
      continue;
    }
    const slot: ProviderVariantGroup = { kind: 'group', first: { row, prefix }, rest: [] };
    groups.set(bareId, slot);
    slots.push(slot);
  }
  return slots.map((slot) =>
    slot.kind === 'row' ? slot.row : mergeGroupRows(slot.first, slot.rest, ctx),
  );
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
    contextLength: entry.contextLength,
    releaseDate: entry.releaseDate,
  };
}

export function resolveAndSort(
  providerId: string,
  role: ActiveRunnerRole,
  cache: ModelCacheAccessor = NULL_CACHE,
): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const entry of resolveModelCatalog(providerId, { cache, role })) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(toModelOption(entry));
  }
  return sortModelsByRecency(models);
}

export function buildRightModels(params: {
  role: ActiveRunnerRole;
  customModels: readonly string[];
  currentItem: PickerOption | undefined;
  cache?: ModelCacheAccessor;
  persistedModel?: string | undefined;
  providerAuth?: CliProviderAuth | undefined;
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
  const knownModels = capability.showsDiscovered
    ? resolveAndSort(params.currentItem.id, params.role, cache)
    : [];
  const customOptions: ModelOption[] = capability.allowsCustom
    ? params.customModels
        .filter((id) => !isAutomaticModel(id))
        .map((id): ModelOption => ({ id, isCustom: true, membership: 'custom' }))
    : [];

  const merged = mergeModelOptions(customOptions, knownModels);
  const afterProviders =
    params.currentItem.providerDependent === true
      ? mergeProviderVariants(merged, {
          persistedModel: params.persistedModel,
          customModels: params.customModels,
          providerAuth: params.providerAuth,
        })
      : merged;
  const rows = mergeOptionFamilies(afterProviders, {
    persistedModel: params.persistedModel,
    customModels: params.customModels,
  });
  return capability.allowsAutomatic ? [AUTOMATIC_MODEL_OPTION, ...rows] : rows;
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
