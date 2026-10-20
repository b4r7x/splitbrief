import type { ActiveRunnerRole, PickerSlot } from '../../../core/runners/seat-roles.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { fallbackRunner, seatFallback } from '../../../core/crew/fallback.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  getRunnerDisplayName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  CATALOG_SUGGESTION_MEMBERSHIP,
  resolveModelCatalog,
  type ResolvedModelCatalogEntry,
} from '../../../engine/providers/model/catalog.js';
import {
  canonicalModelBucket,
  isSameCanonicalModel,
  type ModelIdentity,
} from '../../../core/providers/canonical-model-id.js';
import { resolveModelDisplayName } from '../../../core/discovery/model-catalog.js';
import { isCliToolId, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliEffortChannel } from '../../../core/runners/effort-channel.js';
import { EFFORT_LEVELS } from '../../../core/schemas/enums.js';
import { assertNever, includes } from '../../../utils/type-guards.js';
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
 * One tally per row, never per id: a row is one model, and the ids it folds are its options or
 * its routes, which its own chip counts. Every count the picker states is therefore a count of rows
 * the list shows — Cursor's 240 ids are 37 models, and no line may call them 240.
 */
export function countModelOptions(models: readonly ModelOption[]): PickerModelCounts {
  let confirmed = 0;
  let stale = 0;
  let suggestions = 0;
  let bundled = 0;
  let custom = 0;

  for (const model of models) {
    if (model.isCustom === true || model.membership === 'custom') custom += 1;
    switch (model.membership) {
      case 'confirmed':
        confirmed += 1;
        break;
      case 'stale':
        stale += 1;
        break;
      case CATALOG_SUGGESTION_MEMBERSHIP:
        suggestions += 1;
        break;
      case 'bundled-suggestion':
        // An account-cache option is one operator's saved selection, not a documented alias.
        if (model.isAccountOption !== true) bundled += 1;
        break;
      case 'custom':
      case undefined:
        break;
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

/**
 * A row no catalog knows anything about says so, rather than leaving its metadata column blank —
 * where a catalog is what the row is looked up in. A CLI tool's own listing is its catalog, so a row
 * it lists without a size lacks nothing a lookup could have found.
 */
const NO_CATALOG_ENTRY_DETAIL = 'no catalog entry';

function toModelOption(entry: ReturnType<typeof resolveModelCatalog>[number]): ModelOption {
  const displayName = resolveModelDisplayName(entry);
  const isNamed = displayName !== entry.id;
  const knowsNothing =
    !isCliToolId(entry.runnerId) &&
    !isNamed &&
    entry.contextLength === undefined &&
    entry.releaseDate === undefined;
  const detail = entry.detail ?? (knowsNothing ? NO_CATALOG_ENTRY_DETAIL : undefined);
  return {
    id: entry.id,
    ...(isNamed ? { displayName } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(entry.supportsToolCalls === undefined
      ? {}
      : { supportsToolCalls: entry.supportsToolCalls }),
    ...(entry.catalogModelId === undefined ? {} : { catalogModelId: entry.catalogModelId }),
    isDefault: entry.isDefault,
    isDetected: entry.membership === 'confirmed',
    membership: entry.membership,
    ...(entry.isStale ? { isStale: true } : {}),
    ...(entry.nativeOrder === undefined ? {} : { nativeOrder: entry.nativeOrder }),
    ...(entry.source === 'account-options' ? { isAccountOption: true } : {}),
    contextLength: entry.contextLength,
    releaseDate: entry.releaseDate,
    ...(entry.nativeReasoningEfforts === undefined
      ? {}
      : { effortChoices: [...entry.nativeReasoningEfforts] }),
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
 * id, and `mergeProviderVariants` decides which routes are one model. Everything
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
  // A model no seat can run never reaches here — `isChatCapable` drops it at the engine. A hidden
  // one can run, so it leaves only this picker, and a seat already on one keeps its row. codex
  // still runs a hidden slug through `-m`.
  const offered = entries.filter(
    (entry) => entry.nativeHidden !== true || entry.selectionId === options.configuredSelectionId,
  );
  // Two lanes may spell one id with different owners; the picker lists a selection once.
  const byId = new Map<string, ModelOption>();
  for (const row of dedupeAgainstRuntime(offered).map(toModelOption)) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return sortModelsByRecency([...byId.values()]);
}

/**
 * A merged row spans several routes and each route is a different model with its own
 * published ladder, so the ladder is looked up by the route's own id in the pre-merge
 * rows rather than derived from the representative id or from a provider table.
 */
function withRouteEffortChoices(
  row: ModelOption,
  laddersById: ReadonlyMap<string, readonly string[]>,
): ModelOption {
  const variants = row.variants;
  if (variants === undefined) return row;
  return {
    ...row,
    variants: variants.map((variant) => {
      const choices = laddersById.get(variant.fullId) ?? [];
      return choices.length === 0 ? variant : { ...variant, variantChoices: [...choices] };
    }),
  };
}

/**
 * Neither merge pass carries the ladder, so a row merged from several members arrives
 * without one even though its members published it. The row offers the rungs *every* member
 * accepts — the intersection, in the first member's published order — because whichever member
 * the selection resolves to must accept the rung. Demanding identical ladders instead would
 * silence real rows: a Copilot family whose one sibling is enriched by models.dev (5 rungs) and
 * whose other is filled from copilot's tool floor (7 rungs) would lose its effort control
 * altogether, while its unmerged neighbour above keeps one.
 */
function withRowEffortChoices(
  row: ModelOption,
  laddersById: ReadonlyMap<string, readonly string[]>,
): ModelOption {
  if (row.effortChoices !== undefined) return row;
  const ladders = (row.variants ?? []).map((variant) => laddersById.get(variant.fullId) ?? []);
  const first = ladders[0] ?? [];
  if (first.length === 0 || ladders.some((ladder) => ladder.length === 0)) return row;
  const shared = first.filter((token) => ladders.every((ladder) => ladder.includes(token)));
  if (shared.length === 0) return row;
  return { ...row, effortChoices: shared };
}

/**
 * An effort flag takes one of the effort levels and nothing else. codex 0.154.0 lists `ultra` on
 * five models, which the save path refuses, so the ladder does not offer it. A variant is the tool's
 * own string, not an effort level, so a variant seat's ladder stays as its listing spells it.
 */
function withEffortLevelsOnly(row: ModelOption): ModelOption {
  if (row.effortChoices === undefined) return row;
  return {
    ...row,
    effortChoices: row.effortChoices.filter((choice) => includes(EFFORT_LEVELS, choice)),
  };
}

/**
 * A published ladder is an offer only where the seat can spend the rung it drafts:
 * `variant` writes it to the seat's `variant`, per route; `effort-flag` to its `effort`,
 * per row. A `model-id` seat spells its effort inside the model id and an api, shell or
 * agent seat has no field for one, so their rows carry none. The answer is given here,
 * where the ladder is attached, so no builder of picker rows can inherit one the save
 * would drop.
 */
function withSpendableLadders(
  rows: readonly ModelOption[],
  channel: CliEffortChannel | undefined,
  laddersById: ReadonlyMap<string, readonly string[]>,
): ModelOption[] {
  switch (channel) {
    case 'variant':
      return rows.map((row) => withRouteEffortChoices(row, laddersById));
    case 'effort-flag':
      return rows.map((row) => withEffortLevelsOnly(withRowEffortChoices(row, laddersById)));
    case 'model-id':
    case 'none':
    case undefined:
      return rows.map(({ effortChoices: _unspendable, ...row }) => row);
    default:
      return assertNever(channel);
  }
}

export function buildRightModels(params: {
  role: ActiveRunnerRole;
  customModels: readonly string[];
  currentItem: PickerOption | undefined;
  cache?: ModelCacheAccessor;
  persistedModel?: string | undefined;
  tool?: CliToolId | undefined;
  providerAuth?: CliProviderAuth | undefined;
  catalog?: SavedCatalog | null | undefined;
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
          tool: params.tool,
          providerAuth: params.providerAuth,
          catalog: params.catalog,
        })
      : families;
  const laddersById = new Map(merged.map((row) => [row.id, row.effortChoices ?? []]));
  const rows = withSpendableLadders(routed, params.currentItem.effortChannel, laddersById);
  // Automatic selection is structural, never a catalog row: cursor's native list
  // ships its own `auto` line, which would otherwise duplicate the synthesized
  // option — same id, same list key.
  const listed = rows.filter((row) => !isAutomaticModel(row.id));
  const automatic = capability.allowsAutomatic ? [AUTOMATIC_MODEL_OPTION] : [];
  return [...automatic, ...listed];
}

export function readPickerRunner(
  config: Config,
  role: ActiveRunnerRole,
  slot: PickerSlot,
  profile: string | undefined,
): RunnerConfig | undefined {
  if (slot === 'seat') return readActiveRunner({ config, role, profile });
  const fallback = seatFallback(config, role);
  return fallback === undefined ? undefined : fallbackRunner(fallback);
}

export function isCurrentRunner(item: PickerOption, runner: RunnerConfig | undefined): boolean {
  if (item.kind === 'no-fallback') return runner === undefined;
  if (runner === undefined) return false;
  if (item.kind === 'custom-command') {
    return runner.kind === 'shell' || runner.kind === 'agent';
  }
  if (item.kind === 'inherit-planner') return false;
  // The kind is part of the identity: a CLI row must never stand in for an API
  // seat that merely reuses its id, or Enter would silently change the kind.
  return item.kind === runner.kind && item.id === getRunnerDisplayName(runner);
}
