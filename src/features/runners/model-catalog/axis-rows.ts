import { UNSET_EFFORT_WORD } from '../../../core/runners/effort-channel.js';
import {
  routeDraftOf,
  parseOptionSelection,
  optionAxesOf,
  formatAxisValue,
  stepOptionAxis,
} from './option-axis.js';
import type { ModelOption } from './recency.js';
import type { AxisRow } from './types.js';

/** True when any route of the row, or the row itself, carries the tool's own preset ladder. */
export function offersEffortLadder(model: ModelOption): boolean {
  return (
    (model.variants ?? []).some((variant) => (variant.variantChoices ?? []).length > 0) ||
    (model.effortChoices ?? []).length > 0
  );
}

/**
 * The preset ladder one route spells: the route's own, else the row's, else none. The
 * offer and the commit both read it here, so a level the row lists is a level the save
 * can spend. `catalog.ts` has already dropped the ladders the seat's channel cannot.
 */
export function effortLadderFor(
  model: Pick<ModelOption, 'variants' | 'effortChoices'>,
  fullId: string,
): readonly string[] {
  const route = model.variants?.find((variant) => variant.fullId === fullId);
  const routeChoices = route?.variantChoices ?? [];
  return routeChoices.length > 0 ? routeChoices : (model.effortChoices ?? []);
}

/**
 * The steppable dimensions of one route: the ladder its model publishes in the
 * `effort` slot, then the axes the id spells. A single draft serves every route, so
 * it reads as set only under the route whose vocabulary contains it.
 */
export function axisRowsFor(input: {
  model: ModelOption;
  providerPrefix: string;
  optionDraftId: string | null | undefined;
  effortDraft: string | null | undefined;
}): AxisRow[] {
  const { model, providerPrefix } = input;
  const variants = model.variants ?? [];
  const drafted = routeDraftOf(model, providerPrefix, input.optionDraftId);
  const selection = parseOptionSelection(drafted);
  const choices = effortLadderFor(model, drafted);
  const rows: AxisRow[] = [];
  // The ladder replaces the route's id-spelled effort rather than trailing its other
  // axes, so `effort · fast · thinking` reads the same whichever channel spelled it.
  if (choices.length > 0) {
    const draft = input.effortDraft ?? '';
    rows.push({
      kind: 'axis',
      model,
      axis: 'effort',
      providerPrefix,
      value: choices.includes(draft) ? draft : UNSET_EFFORT_WORD,
      choices,
      // The ladder the picker walks is `[null, ...choices]`, so even a lone preset
      // steps — between unset and itself.
      steps: true,
      last: false,
    });
  }
  for (const axis of optionAxesOf(variants, providerPrefix)) {
    // The ladder is the authoritative effort for this route; the id's tokens are not a second one.
    if (axis.axis === 'effort' && choices.length > 0) continue;
    rows.push({
      kind: 'axis',
      model,
      axis: axis.axis,
      providerPrefix,
      value: formatAxisValue(axis.axis, selection),
      choices: [],
      steps: stepOptionAxis(model, axis.axis, drafted, providerPrefix) !== undefined,
      last: false,
    });
  }
  return rows.map((row, index) => ({ ...row, last: index === rows.length - 1 }));
}
