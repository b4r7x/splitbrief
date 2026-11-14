import type { CliEffortChannel } from '../../../core/runners/effort-channel.js';
import { EFFORT_LEVELS } from '../../../core/schemas/enums.js';
import { includes, assertNever } from '../../../utils/type-guards.js';
import type { ModelOption } from './recency.js';

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
 * altogether, while its unmerged neighbour above keeps one. The shared ladder is a floor only
 * when every member's is.
 */
function withRowEffortChoices(
  row: ModelOption,
  laddersById: ReadonlyMap<string, readonly string[]>,
  floorIds: ReadonlySet<string>,
): ModelOption {
  if (row.effortChoices !== undefined) return row;
  const variants = row.variants ?? [];
  const ladders = variants.map((variant) => laddersById.get(variant.fullId) ?? []);
  const first = ladders[0] ?? [];
  if (first.length === 0 || ladders.some((ladder) => ladder.length === 0)) return row;
  const shared = first.filter((token) => ladders.every((ladder) => ladder.includes(token)));
  if (shared.length === 0) return row;
  return {
    ...row,
    effortChoices: shared,
    ...(variants.every((variant) => floorIds.has(variant.fullId))
      ? { effortChoicesFromFloor: true }
      : {}),
  };
}

/**
 * An effort flag takes one of the effort levels and nothing else. A variant is the tool's own
 * string, not an effort level, so a variant seat's ladder stays as its listing spells it.
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
export function withSpendableLadders(
  rows: readonly ModelOption[],
  channel: CliEffortChannel | undefined,
  laddersById: ReadonlyMap<string, readonly string[]>,
  floorIds: ReadonlySet<string>,
): ModelOption[] {
  switch (channel) {
    case 'variant':
      return rows.map((row) => withRouteEffortChoices(row, laddersById));
    case 'effort-flag':
      return rows.map((row) =>
        withEffortLevelsOnly(withRowEffortChoices(row, laddersById, floorIds)),
      );
    case 'model-id':
    case 'none':
    case undefined:
      return rows.map(({ effortChoices: _unspendable, ...row }) => row);
    default:
      return assertNever(channel);
  }
}
