import type { ActiveRunnerRole, PickerSlot } from '../../../core/runners/seat-roles.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { fallbackRunner, seatFallback } from '../../../core/crew/fallback.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  getRunnerDisplayName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection/auth.js';
import type { Config } from '../../../core/schemas/config.js';
import { CATALOG_SUGGESTION_MEMBERSHIP } from '../../../engine/providers/model/suggestions.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { NULL_CACHE } from '../../../engine/providers/model/runtime-snapshot.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/runtime-snapshot.js';
import type { PickerOption } from './options.js';
import { mergeOptionFamilies } from './option-merge.js';
import { mergeProviderVariants } from './provider-merge.js';
import { sortModelsByRecency, type ModelOption } from './recency.js';
import { resolveAndSort } from './runtime-dedupe.js';
import { withSpendableLadders } from './effort-ladders.js';

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
  const floorIds = new Set(
    merged.flatMap((row) => (row.effortChoicesFromFloor === true ? [row.id] : [])),
  );
  const rows = withSpendableLadders(
    routed,
    params.currentItem.effortChannel,
    laddersById,
    floorIds,
  );
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
  if (runner === undefined || (item.kind !== 'cli' && item.kind !== 'api')) return false;
  // The kind is part of the identity: a CLI row must never stand in for an API
  // seat that merely reuses its id, or Enter would silently change the kind.
  return item.kind === runner.kind && item.id === getRunnerDisplayName(runner);
}
