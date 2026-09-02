import type { CliProviderAuth } from '../../core/discovery/detection.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { seatPickerLane, type SeatPickerRole } from '../../core/runners/seat-roles.js';
import { configStore } from '../../stores/project/config.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { SOFT_SEP } from '../../components/separators.js';
import { assertNever } from '../../utils/type-guards.js';
import type { PickerOption } from './model-catalog/options.js';
import {
  isOptionFamily,
  optionAxesOf,
  optionDraftOf,
  routeDraftOf,
  routePrefixesOf,
  stepOptionAxis,
} from './model-catalog/option-axis.js';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import { offersVariantLadder, routeAuthStateFor, type RightRow } from './model-catalog/rows.js';
import type { CycleOutcome, RightActivation } from './two-column-picker/types.js';
import type { PickerActions } from './use-picker-actions.js';

/** What the tool's credential listing is read against when a route's auth is judged. */
export interface RouteAuthContext {
  hasOracle: boolean;
  providerAuth: CliProviderAuth | undefined;
}

/**
 * An expansion that steps a draft is confirmed from its parent; one that only lists
 * provider routes holds no draft, so its parent closes it instead.
 */
function expansionDrafts(model: ModelOption): boolean {
  if (isOptionFamily(model)) return true;
  if (offersVariantLadder(model)) return true;
  const variants = model.variants ?? [];
  return routePrefixesOf(variants).some((prefix) => optionAxesOf(variants, prefix).length > 0);
}

/** Unset heads the ladder, so a drafted preset can always be taken back. */
function nextVariantDraft(choices: readonly string[], current: string | null): string | null {
  const ladder: readonly (string | null)[] = [null, ...choices];
  return ladder[(ladder.indexOf(current) + 1) % ladder.length] ?? null;
}

/** The presets one route of a merged row spells; another route's ladder is not it. */
function routeVariantChoices(model: ModelOption, fullId: string): readonly string[] {
  return model.variants?.find((variant) => variant.fullId === fullId)?.variantChoices ?? [];
}

/** The variant the seat already runs; the ladder opens on it rather than on unset. */
function configuredVariant(role: SeatPickerRole): string | null {
  const config = configStore.get().config;
  if (config === null) return null;
  return readActiveRunner({ config, role: seatPickerLane(role) }).variant ?? null;
}

/** The seat's own preset opens the ladder, but only on a route whose vocabulary spells it. */
export function seatVariantDraft(
  model: ModelOption,
  optionDraftId: string | undefined,
  role: SeatPickerRole,
): string | null {
  const configured = configuredVariant(role);
  if (configured === null) return null;
  const choices = routeVariantChoices(model, optionDraftOf(model, optionDraftId));
  return choices.includes(configured) ? configured : null;
}

export function rightRowActivation(
  row: RightRow,
  soleConfigured: ModelVariant | undefined,
): RightActivation {
  switch (row.kind) {
    case 'notice':
      return row.action === 'refresh' ? 'refresh' : 'none';
    case 'action':
    case 'route':
    case 'axis':
      return 'confirm';
    case 'model': {
      if (row.expanded) return expansionDrafts(row.model) ? 'confirm' : 'collapse';
      // An option family's children are spellings of one route, never routes to
      // choose between, so it always opens.
      if (isOptionFamily(row.model)) return 'expand';
      const routes = row.model.variants?.length ?? 0;
      // One signed-in route among several needs no chooser, whichever of them
      // happens to spell a preset ladder.
      if (routes > 1) return soleConfigured === undefined ? 'expand' : 'confirm';
      // A variant ladder is reachable only through the expansion, so a model that
      // offers one opens even where its single route would otherwise just confirm.
      return offersVariantLadder(row.model) ? 'expand' : 'confirm';
    }
    default:
      return assertNever(row);
  }
}

/**
 * One signed-in route needs no chooser: Enter saves it. Two or more, or none,
 * is a decision the user has to see, so the row expands instead.
 */
function soleConfiguredRoute(row: RightRow, auth: RouteAuthContext): ModelVariant | undefined {
  if (row.kind !== 'model') return undefined;
  const variants = row.model.variants ?? [];
  if (variants.length <= 1) return variants[0];
  const configured = variants.filter(
    (variant) =>
      routeAuthStateFor({
        hasOracle: auth.hasOracle,
        variant,
        providerAuth: auth.providerAuth,
      }).kind === 'configured',
  );
  return configured.length === 1 ? configured[0] : undefined;
}

export function activationOfRightRow(row: RightRow, auth: RouteAuthContext): RightActivation {
  return rightRowActivation(row, soleConfiguredRoute(row, auth));
}

/**
 * The expanded column's Enter verb belongs to the highlighted row: space steps an
 * axis in place, and a row outside the expansion still confirms or expands there.
 * Only a provider expansion's own rows keep the column-wide `⏎ choose route`.
 */
export function expandedRowHint(
  row: RightRow | undefined,
  auth: RouteAuthContext,
): string | undefined {
  if (row === undefined || row.kind === 'route') return undefined;
  // A notice sits outside the expansion and must not borrow its verb: a picker of
  // option families holds no route to choose. The failed lane retries on Enter; the
  // pending one has no key at all, and repeating the row's own text in the key slot
  // would read as an affordance, so it contributes nothing.
  if (row.kind === 'notice') return row.action === 'refresh' ? '⏎ retry' : '';
  if (row.kind === 'action') return '⏎ browse';
  // A sparse variant grid leaves an axis with nowhere to step, and the byline
  // must not promise a key that cannot move; the row already carries that answer.
  if (row.kind === 'axis') return row.steps ? `space cycle${SOFT_SEP}⏎ confirm` : '⏎ confirm';
  if (row.expanded) return expansionDrafts(row.model) ? '⏎ confirm' : '⏎ collapse';
  return activationOfRightRow(row, auth) === 'expand' ? '⏎ expand' : '⏎ confirm';
}

/**
 * The drafted variant is part of the same selection as the drafted id: both are
 * in flight until Enter, so both are saved by it — but a preset reaches the save
 * only on the route that spells it.
 */
function confirmDraft(model: ModelOption, fullId: string, actions: PickerActions) {
  const draft = pickerViewStore.get().variantDraft;
  const carries = draft !== null && routeVariantChoices(model, fullId).includes(draft);
  void actions.confirmProviderVariant(fullId, carries ? draft : undefined);
}

export function confirmRow(
  left: PickerOption,
  row: RightRow | null,
  deps: { actions: PickerActions; auth: RouteAuthContext },
) {
  const { actions } = deps;
  if (row === null) {
    void actions.confirm(left, null);
    return;
  }
  // Browsing widens the rows on screen; nothing is chosen, so nothing is saved.
  if (row.kind === 'action') {
    actions.browseCatalog();
    return;
  }
  if (row.kind === 'notice') return;
  const draftId = pickerViewStore.get().optionDraftId;
  // A route confirms as it is drafted, and an axis row confirms its route's
  // drafted id rather than its own axis value.
  if (row.kind === 'route') {
    confirmDraft(row.model, routeDraftOf(row.model, row.variant.providerPrefix, draftId), actions);
    return;
  }
  if (row.kind === 'axis') {
    confirmDraft(row.model, routeDraftOf(row.model, row.providerPrefix, draftId), actions);
    return;
  }
  if (row.expanded && expansionDrafts(row.model)) {
    confirmDraft(row.model, optionDraftOf(row.model, draftId), actions);
    return;
  }
  const sole = soleConfiguredRoute(row, deps.auth);
  if (sole !== undefined) {
    void actions.confirmProviderVariant(sole.fullId);
    return;
  }
  void actions.confirm(left, row.model);
}

/**
 * A merged row answers for every spelling it folded — provider prefixes and option
 * tags — so typing "openrouter" or "luna" still finds it.
 */
export function rightRowMatches(row: RightRow, query: string): boolean {
  const q = query.toLowerCase();
  const hits = (value: string | undefined): boolean => value?.toLowerCase().includes(q) === true;
  const hitsModel = (model: ModelOption): boolean =>
    hits(model.id) ||
    hits(model.displayName) ||
    (model.variants?.some(
      (variant) => hits(variant.fullId) || hits(variant.tag) || hits(variant.displayName),
    ) ??
      false);
  switch (row.kind) {
    // The escape from an empty result cannot be the thing a query hides.
    case 'notice':
    case 'action':
      return true;
    case 'route':
      return hits(row.variant.fullId) || hits(row.variant.tag) || hits(row.variant.displayName);
    // An axis row is a child of its model row, so it follows the parent
    // through the filter; a lone child would draw a tree that hangs off nothing.
    case 'axis':
    case 'model':
      return hitsModel(row.model);
    default:
      return assertNever(row);
  }
}

/**
 * Space belongs to the expanded family: an axis row steps it, and takes the key
 * even where its ladder has nowhere to go — but only a row that moved owns the
 * click, so a dead axis confirms under the mouse the way its byline says. The
 * parent holds the key rather than collapsing the family the user is steering.
 */
export function cycleRightRow(row: RightRow): CycleOutcome {
  if (row.kind !== 'axis') {
    return row.kind === 'model' && row.expanded && expansionDrafts(row.model) ? 'held' : 'none';
  }
  if (!row.steps) return 'held';
  if (row.axis === 'variant') {
    // A preset drafted on another route is not a rung of this ladder, so the
    // step starts from unset the way the row already reads.
    const draft = pickerViewStore.get().variantDraft;
    const current = draft !== null && row.choices.includes(draft) ? draft : null;
    pickerViewStore.setVariantDraft(nextVariantDraft(row.choices, current));
    return 'stepped';
  }
  // Stepping inside a route moves the draft onto it, so every route of a
  // merged row is reachable from its own axis.
  const current = routeDraftOf(row.model, row.providerPrefix, pickerViewStore.get().optionDraftId);
  const next = stepOptionAxis(row.model, row.axis, current, row.providerPrefix);
  if (next === undefined) return 'held';
  pickerViewStore.setOptionDraftId(next);
  return 'stepped';
}
