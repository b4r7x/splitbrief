import { EFFORT_AXIS_TOKENS, UNSET_EFFORT_WORD } from '../../../core/runners/effort-channel.js';
import { assertNever, includes } from '../../../utils/type-guards.js';
import { peelOptionSuffix } from './option-merge.js';
import type { ModelOption, ModelVariant } from './recency.js';

const EFFORT_ORDER = [UNSET_EFFORT_WORD, ...EFFORT_AXIS_TOKENS] as const;
const FAST_ORDER = ['off', 'on'] as const;
const THINKING_ORDER = ['off', 'on'] as const;

type OptionEffort = (typeof EFFORT_ORDER)[number];
type OptionFast = (typeof FAST_ORDER)[number];
type OptionThinking = (typeof THINKING_ORDER)[number];

export type OptionAxisName = 'effort' | 'fast' | 'thinking';

interface OptionSelection {
  readonly effort: OptionEffort;
  readonly fast: OptionFast;
  readonly thinking: OptionThinking;
}

type OptionAxis =
  | { readonly axis: 'effort'; readonly values: readonly OptionEffort[] }
  | { readonly axis: 'fast'; readonly values: readonly OptionFast[] }
  | { readonly axis: 'thinking'; readonly values: readonly OptionThinking[] };

const OPTION_SUMMARY_SEP = ' · ';

function effortOf(tokens: readonly string[]): OptionEffort {
  for (const token of tokens) {
    if (includes(EFFORT_ORDER, token)) return token;
  }
  return UNSET_EFFORT_WORD;
}

export function parseOptionSelection(id: string): OptionSelection {
  const tokens = peelOptionSuffix(id).tokens;
  return {
    effort: effortOf(tokens),
    fast: tokens.includes('fast') ? 'on' : 'off',
    thinking: tokens.includes('thinking') ? 'on' : 'off',
  };
}

function uniqueInOrder<T extends string>(present: ReadonlySet<string>, order: readonly T[]): T[] {
  return order.filter((value) => present.has(value));
}

export function isOptionFamily(model: Pick<ModelOption, 'variants'>): boolean {
  const variants = model.variants ?? [];
  return variants.length >= 2 && variants.every((variant) => variant.providerPrefix === '');
}

/** The distinct provider routes a merged row spans, in first-appearance order. */
export function routePrefixesOf(variants: readonly ModelVariant[]): readonly string[] {
  const prefixes: string[] = [];
  for (const variant of variants) {
    if (!prefixes.includes(variant.providerPrefix)) prefixes.push(variant.providerPrefix);
  }
  return prefixes;
}

export function optionAxesOf(
  variants: readonly ModelVariant[],
  providerPrefix = '',
): readonly OptionAxis[] {
  const efforts = new Set<string>();
  const fasts = new Set<string>();
  const thinkings = new Set<string>();
  for (const variant of variants) {
    if (variant.providerPrefix !== providerPrefix) continue;
    const selection = parseOptionSelection(variant.fullId);
    efforts.add(selection.effort);
    fasts.add(selection.fast);
    thinkings.add(selection.thinking);
  }
  const axes: OptionAxis[] = [];
  const effortValues = uniqueInOrder(efforts, EFFORT_ORDER);
  if (effortValues.length >= 2) axes.push({ axis: 'effort', values: effortValues });
  const fastValues = uniqueInOrder(fasts, FAST_ORDER);
  if (fastValues.length >= 2) axes.push({ axis: 'fast', values: fastValues });
  const thinkingValues = uniqueInOrder(thinkings, THINKING_ORDER);
  if (thinkingValues.length >= 2) axes.push({ axis: 'thinking', values: thinkingValues });
  return axes;
}

export function optionDraftOf(
  model: Pick<ModelOption, 'id' | 'variants'>,
  optionDraftId: string | null | undefined,
): string {
  const variants = model.variants ?? [];
  if (
    optionDraftId !== undefined &&
    optionDraftId !== null &&
    variants.some((variant) => variant.fullId === optionDraftId)
  ) {
    return optionDraftId;
  }
  if (variants.some((variant) => variant.fullId === model.id)) return model.id;
  return variants[0]?.fullId ?? model.id;
}

/**
 * The id one route's axes step inside: the drafted id when it belongs to that
 * route, and the route's own head otherwise, so every route of a merged row is
 * steppable rather than only the drafted one.
 */
export function routeDraftOf(
  model: Pick<ModelOption, 'id' | 'variants'>,
  providerPrefix: string,
  optionDraftId: string | null | undefined,
): string {
  const variants = model.variants ?? [];
  const drafted = optionDraftOf(model, optionDraftId);
  const draftedPrefix =
    variants.find((variant) => variant.fullId === drafted)?.providerPrefix ?? '';
  if (draftedPrefix === providerPrefix) return drafted;
  const route = variants.filter((variant) => variant.providerPrefix === providerPrefix);
  return (
    route.find((variant) => variant.fullId === model.id)?.fullId ?? route[0]?.fullId ?? drafted
  );
}

export function composeOptionId(
  variants: readonly ModelVariant[],
  selection: OptionSelection,
  providerPrefix = '',
): string | undefined {
  return variants.find((variant) => {
    if (variant.providerPrefix !== providerPrefix) return false;
    const parsed = parseOptionSelection(variant.fullId);
    return (
      parsed.effort === selection.effort &&
      parsed.fast === selection.fast &&
      parsed.thinking === selection.thinking
    );
  })?.fullId;
}

function nextValues<T extends string>(values: readonly T[], current: T): T[] {
  const start = values.indexOf(current);
  const from = start < 0 ? -1 : start;
  const ordered: T[] = [];
  for (let step = 1; step <= values.length; step++) {
    const value = values[(from + step) % values.length];
    if (value !== undefined) ordered.push(value);
  }
  return ordered;
}

export function cycleOptionAxis(
  variants: readonly ModelVariant[],
  currentId: string,
  axis: OptionAxisName,
  providerPrefix = '',
): string | undefined {
  const current = parseOptionSelection(currentId);
  const def = optionAxesOf(variants, providerPrefix).find((entry) => entry.axis === axis);
  if (def === undefined) return undefined;
  switch (def.axis) {
    case 'effort':
      for (const value of nextValues(def.values, current.effort)) {
        const id = composeOptionId(variants, { ...current, effort: value }, providerPrefix);
        if (id !== undefined) return id;
      }
      return undefined;
    case 'fast':
      for (const value of nextValues(def.values, current.fast)) {
        const id = composeOptionId(variants, { ...current, fast: value }, providerPrefix);
        if (id !== undefined) return id;
      }
      return undefined;
    case 'thinking':
      for (const value of nextValues(def.values, current.thinking)) {
        const id = composeOptionId(variants, { ...current, thinking: value }, providerPrefix);
        if (id !== undefined) return id;
      }
      return undefined;
    default:
      return assertNever(def);
  }
}

/** The id one step of `axis` lands on, or undefined where the ladder has nowhere to move. */
export function stepOptionAxis(
  model: Pick<ModelOption, 'id' | 'variants'>,
  axis: OptionAxisName,
  optionDraftId: string | null | undefined,
  providerPrefix = '',
): string | undefined {
  const current = optionDraftOf(model, optionDraftId);
  const next = cycleOptionAxis(model.variants ?? [], current, axis, providerPrefix);
  return next === current ? undefined : next;
}

export function formatAxisValue(axis: OptionAxisName, selection: OptionSelection): string {
  return selection[axis];
}

export function formatOptionSummary(
  id: string,
  variants: readonly ModelVariant[],
  providerPrefix = '',
): string {
  const selection = parseOptionSelection(id);
  return optionAxesOf(variants, providerPrefix)
    .map((axis) => formatAxisValue(axis.axis, selection))
    .join(OPTION_SUMMARY_SEP);
}
