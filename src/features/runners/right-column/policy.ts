import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection/auth.js';
import { formatModelName } from '../../../core/providers/model-display.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { routeAuthState } from '../../../core/runners/route-auth.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { assertNever } from '../../../utils/type-guards.js';
import { isOptionFamily, optionDraftOf, routeDraftOf } from '../model-catalog/option-axis.js';
import type { PickerOption } from '../model-catalog/options.js';
import type { ModelVariant, ModelOption } from '../model-catalog/recency.js';
import { offersEffortLadder, effortLadderFor } from '../model-catalog/axis-rows.js';
import type { RightRow } from '../model-catalog/types.js';
import type { PickerActions } from '../picker/use-actions.js';
import type { RightActivation } from '../two-column-picker/types.js';
import { expansionDrafts } from './drafts.js';

/** What the tool's credential and model listings are read against when a route's auth is judged. */
export interface RouteAuthContext {
  tool: CliToolId | undefined;
  providerAuth: CliProviderAuth | undefined;
  catalog: SavedCatalog | null | undefined;
}

export function rightRowActivation(
  row: RightRow,
  soleConfigured: ModelVariant | undefined,
): RightActivation {
  switch (row.kind) {
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
      // An effort ladder is reachable only through the expansion, so a model that
      // offers one opens even where its single route would otherwise just confirm.
      return offersEffortLadder(row.model) ? 'expand' : 'confirm';
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
      routeAuthState({
        tool: auth.tool,
        model: variant.fullId,
        providerAuth: auth.providerAuth,
        catalog: auth.catalog,
      }).kind === 'configured',
  );
  return configured.length === 1 ? configured[0] : undefined;
}

/**
 * What Enter on a model row saves, and so the id its byline names: the drafted spelling while
 * its expansion drafts one, else the one signed-in route, else the model itself, named by the
 * spelling its chooser opens on.
 */
export function modelRowSave(
  row: Extract<RightRow, { kind: 'model' }>,
  auth: RouteAuthContext,
  optionDraftId: string | null | undefined,
): { via: 'draft' | 'route' | 'model'; fullId: string } {
  const drafted = optionDraftOf(row.model, optionDraftId);
  if (row.expanded && expansionDrafts(row.model)) return { via: 'draft', fullId: drafted };
  const sole = soleConfiguredRoute(row, auth);
  if (sole !== undefined) return { via: 'route', fullId: sole.fullId };
  return { via: 'model', fullId: drafted };
}

export function activationOfRightRow(row: RightRow, auth: RouteAuthContext): RightActivation {
  return rightRowActivation(row, soleConfiguredRoute(row, auth));
}

/** A row the Enter key opens: the chevron and the verb are then the same fact. */
export function isExpandableRow(row: RightRow, auth: RouteAuthContext): boolean {
  return activationOfRightRow(row, auth) === 'expand' || (row.kind === 'model' && row.expanded);
}

/**
 * The Enter verb belongs to the highlighted row, with or without an open expansion:
 * a collapsed row expands, space steps an axis in place, and a row outside the
 * expansion still confirms or expands there. Only a provider expansion's own rows
 * keep the column-wide `⏎ choose route`.
 */
export function rowEnterHint(
  row: RightRow | undefined,
  auth: RouteAuthContext,
): string | undefined {
  if (row === undefined || row.kind === 'route') return undefined;
  if (row.kind === 'action') return '⏎ browse';
  // A sparse variant grid leaves an axis with nowhere to step, and the byline
  // must not promise a key that cannot move; the row already carries that answer.
  if (row.kind === 'axis') return row.steps ? `space cycle${SOFT_SEP}⏎ confirm` : '⏎ confirm';
  if (row.expanded) return expansionDrafts(row.model) ? '⏎ confirm' : '⏎ collapse';
  return activationOfRightRow(row, auth) === 'expand' ? '⏎ expand' : '⏎ confirm';
}

/**
 * The drafted level rides with the drafted id: both are in flight until Enter, so both are
 * saved by it. Three states, not two: the token when this route's ladder spells it; `null` when
 * the route has a ladder and the row is showing the unset word — nothing drafted, or a draft
 * this ladder does not spell, the same condition `axisRowsFor` renders it by; `undefined` when
 * the route has no ladder at all, so the field is left alone. Which field spends the token is
 * the seat channel's answer, given once at the commit.
 */
function confirmDraft(model: ModelOption, fullId: string, actions: PickerActions) {
  const draft = pickerViewStore.get().effortDraft;
  const choices = effortLadderFor(model, fullId);
  const effort =
    choices.length === 0 ? undefined : draft !== null && choices.includes(draft) ? draft : null;
  void actions.confirmProviderSelection(fullId, effort);
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
  const save = modelRowSave(row, deps.auth, draftId);
  if (save.via === 'draft') confirmDraft(row.model, save.fullId, actions);
  else if (save.via === 'route') void actions.confirmProviderSelection(save.fullId);
  else void actions.confirm(left, row.model);
}

/**
 * A merged row answers for every spelling it folded — provider prefixes and option
 * tags — so typing "openrouter" or "luna" still finds it. It answers for the name it
 * shows too, which a row with no display name takes from its id under `providerId`.
 */
export function rightRowMatches(
  row: RightRow,
  query: string,
  providerId: string | undefined,
): boolean {
  const q = query.toLowerCase();
  const hits = (value: string | undefined): boolean => value?.toLowerCase().includes(q) === true;
  const hitsModel = (model: ModelOption): boolean =>
    hits(model.id) ||
    hits(model.displayName ?? formatModelName(model.id, providerId)) ||
    (model.variants?.some(
      (variant) => hits(variant.fullId) || hits(variant.tag) || hits(variant.displayName),
    ) ??
      false);
  switch (row.kind) {
    // The escape from an empty result cannot be the thing a query hides.
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
