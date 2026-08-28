import { formatModelName } from '../../../core/model-display.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import type { ResolvedModelMembership } from '../../../engine/providers/model/catalog.js';
import { assertNever, includes } from '../../../utils/type-guards.js';
import { modelProviderPrefix } from './provider-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

interface PeeledOptionSuffix {
  readonly familyId: string;
  readonly tokens: readonly string[];
}

interface OptionMergeContext {
  readonly persistedModel?: string | undefined;
  readonly customModels?: readonly string[];
}

const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const SPEED_ORDER = ['standard', 'fast'] as const;
const THINKING_ORDER = ['off', 'on'] as const;

type OptionEffort = (typeof EFFORT_ORDER)[number];
type OptionSpeed = (typeof SPEED_ORDER)[number];
type OptionThinking = (typeof THINKING_ORDER)[number];

const EFFORT_TOKENS = new Set<string>(EFFORT_ORDER);
const DISPLAY_OPTION_WORDS = new Set(['fast', 'thinking', 'none', 'low', 'medium', 'high', 'max']);
const DISPLAY_CONTEXT_WORDS = new Set(['1m', '1.0m', '1.1m']);
const TRAILING_PARENS_RE = /(\s*\([^()]*\))$/;

const MEMBERSHIP_RANK = {
  confirmed: 0,
  stale: 1,
  'catalog-suggestion': 2,
  'bundled-suggestion': 3,
  custom: 4,
} as const satisfies Record<ResolvedModelMembership, number>;

function lastHyphenToken(id: string): { rest: string; token: string } | undefined {
  const idx = id.lastIndexOf('-');
  if (idx <= 0) return undefined;
  const token = id.slice(idx + 1);
  if (token === '') return undefined;
  return { rest: id.slice(0, idx), token };
}

function peelEffort(id: string): { rest: string; token: string } | undefined {
  const last = lastHyphenToken(id);
  if (last === undefined) return undefined;
  const lower = last.token.toLowerCase();
  if (lower === 'high') {
    const prev = lastHyphenToken(last.rest);
    if (prev !== undefined && prev.token.toLowerCase() === 'extra') {
      return { rest: prev.rest, token: 'xhigh' };
    }
  }
  if (EFFORT_TOKENS.has(lower)) return { rest: last.rest, token: lower };
  return undefined;
}

/** Closed option tokens, right-to-left. Prefixed ids are provider routes and do not peel. */
export function peelOptionSuffix(id: string): PeeledOptionSuffix {
  if (modelProviderPrefix(id) !== undefined) return { familyId: id, tokens: [] };
  const peeled: string[] = [];
  let rest = id;
  for (;;) {
    let progressed = false;
    const fast = lastHyphenToken(rest);
    if (fast !== undefined && fast.token.toLowerCase() === 'fast') {
      peeled.push('fast');
      rest = fast.rest;
      progressed = true;
    }
    const effort = peelEffort(rest);
    if (effort !== undefined) {
      peeled.push(effort.token);
      rest = effort.rest;
      progressed = true;
    }
    const thinking = lastHyphenToken(rest);
    if (thinking !== undefined && thinking.token.toLowerCase() === 'thinking') {
      peeled.push('thinking');
      rest = thinking.rest;
      progressed = true;
    }
    if (!progressed) break;
  }
  return { familyId: rest, tokens: peeled.toReversed() };
}

function splitTrailingParens(value: string): { core: string; parens: string } {
  let core = value.trimEnd();
  let parens = '';
  for (;;) {
    const match = TRAILING_PARENS_RE.exec(core);
    const captured = match?.[1];
    if (captured === undefined) break;
    parens = captured + parens;
    core = core.slice(0, core.length - captured.length).trimEnd();
  }
  return { core, parens };
}

function peelDisplayLabel(displayName: string): string {
  const { core, parens } = splitTrailingParens(displayName.trim());
  const words = core.split(/\s+/).filter((word) => word.length > 0);
  for (;;) {
    const last = words[words.length - 1];
    if (last === undefined) break;
    const lower = last.toLowerCase();
    const prev = words[words.length - 2];
    if (lower === 'high' && prev?.toLowerCase() === 'extra') {
      words.splice(words.length - 2, 2);
      continue;
    }
    if (DISPLAY_OPTION_WORDS.has(lower) || DISPLAY_CONTEXT_WORDS.has(lower)) {
      words.pop();
      continue;
    }
    break;
  }
  const peeled = words.join(' ');
  return parens === '' ? peeled : `${peeled}${parens}`.trim();
}

function familyDisplayName(rows: readonly ModelOption[], familyId: string): string {
  for (const row of rows) {
    if (row.displayName === undefined || row.displayName === '') continue;
    const peeled = peelDisplayLabel(row.displayName);
    if (peeled !== '') return peeled;
  }
  return formatModelName(familyId);
}

function prettyOptionTokens(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      switch (token) {
        case 'fast':
          return 'Fast';
        case 'thinking':
          return 'Thinking';
        case 'none':
          return 'None';
        case 'low':
          return 'Low';
        case 'medium':
          return 'Medium';
        case 'high':
          return 'High';
        case 'xhigh':
          return 'Extra High';
        case 'max':
          return 'Max';
        default:
          return token;
      }
    })
    .join(' ');
}

function displayRemainder(displayName: string, familyDisplay: string): string {
  const familyCore = splitTrailingParens(familyDisplay).core;
  const nameCore = splitTrailingParens(displayName).core;
  if (nameCore.toLowerCase().startsWith(familyCore.toLowerCase())) {
    return nameCore.slice(familyCore.length).trim();
  }
  return '';
}

function optionTag(
  row: ModelOption,
  familyDisplay: string,
  tokens: readonly string[] = peelOptionSuffix(row.id).tokens,
): string {
  if (row.displayName !== undefined && row.displayName !== '') {
    const remainder = displayRemainder(row.displayName, familyDisplay);
    if (remainder !== '') return remainder;
  }
  return prettyOptionTokens(tokens);
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

function toOptionVariant(row: ModelOption, familyDisplay: string): ModelVariant {
  return {
    fullId: row.id,
    providerPrefix: '',
    tag: optionTag(row, familyDisplay),
    ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
    ...(row.membership === undefined ? {} : { membership: row.membership }),
    ...(row.isCustom ? { isCustom: true } : {}),
  };
}

function skipOptionMerge(row: ModelOption): boolean {
  if (isAutomaticModel(row.id)) return true;
  if (modelProviderPrefix(row.id) !== undefined) return true;
  if (row.isCustom === true) return true;
  if (row.membership === 'custom') return true;
  return row.variants?.some((variant) => variant.providerPrefix !== '') ?? false;
}

function mergeOptionGroup(
  first: ModelOption,
  rest: readonly ModelOption[],
  ctx: OptionMergeContext,
): ModelOption {
  const members = [first, ...rest];
  const customModels = ctx.customModels ?? [];
  const representative =
    members.find((row) => row.id === ctx.persistedModel) ??
    members.find((row) => customModels.includes(row.id)) ??
    first;
  const familyId = peelOptionSuffix(first.id).familyId;
  const displayName = familyDisplayName(members, familyId);
  const variants = members.map((row) => toOptionVariant(row, displayName));
  const membership = bestMembership(members);
  let contextLength: number | undefined;
  let releaseDate: string | undefined;
  for (const row of members) {
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

  return {
    id: representative.id,
    displayName,
    ...(members.some((row) => row.isDefault) ? { isDefault: true } : {}),
    ...(membership === undefined ? {} : { membership }),
    ...(membership !== undefined && membership !== 'custom'
      ? { isDetected: membership === 'confirmed' }
      : {}),
    ...(membership === 'stale' ? { isStale: true } : {}),
    ...(members.some((row) => row.isCustom) ? { isCustom: true } : {}),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    variants,
  };
}

interface OptionFamilyGroup {
  readonly kind: 'group';
  readonly first: ModelOption;
  readonly rest: ModelOption[];
}

type MergeSlot = Readonly<{ kind: 'row'; row: ModelOption }> | OptionFamilyGroup;

/**
 * Collapses combinatorial effort/speed/thinking ids into one row per family.
 * Groups of size 1 stay flat. Provider-prefix rows are left for mergeProviderVariants.
 */
export function mergeOptionFamilies(
  models: readonly ModelOption[],
  ctx: OptionMergeContext = {},
): ModelOption[] {
  const groups = new Map<string, OptionFamilyGroup>();
  const slots: MergeSlot[] = [];
  for (const row of models) {
    if (skipOptionMerge(row)) {
      slots.push({ kind: 'row', row });
      continue;
    }
    const familyId = peelOptionSuffix(row.id).familyId;
    const existing = groups.get(familyId);
    if (existing !== undefined) {
      existing.rest.push(row);
      continue;
    }
    const slot: OptionFamilyGroup = { kind: 'group', first: row, rest: [] };
    groups.set(familyId, slot);
    slots.push(slot);
  }
  return slots.map((slot) =>
    slot.kind === 'row'
      ? slot.row
      : slot.rest.length === 0
        ? slot.first
        : mergeOptionGroup(slot.first, slot.rest, ctx),
  );
}

export type OptionAxisName = 'effort' | 'speed' | 'thinking';

interface OptionSelection {
  readonly effort: OptionEffort;
  readonly speed: OptionSpeed;
  readonly thinking: OptionThinking;
}

type OptionAxis =
  | { readonly axis: 'effort'; readonly values: readonly OptionEffort[] }
  | { readonly axis: 'speed'; readonly values: readonly OptionSpeed[] }
  | { readonly axis: 'thinking'; readonly values: readonly OptionThinking[] };

const OPTION_SUMMARY_SEP = ' · ';

function effortOf(tokens: readonly string[]): OptionEffort {
  for (const token of tokens) {
    if (includes(EFFORT_ORDER, token)) return token;
  }
  return 'medium';
}

export function parseOptionSelection(id: string): OptionSelection {
  const tokens = peelOptionSuffix(id).tokens;
  return {
    effort: effortOf(tokens),
    speed: tokens.includes('fast') ? 'fast' : 'standard',
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

export function optionAxesOf(variants: readonly ModelVariant[]): readonly OptionAxis[] {
  const efforts = new Set<string>();
  const speeds = new Set<string>();
  const thinkings = new Set<string>();
  for (const variant of variants) {
    const selection = parseOptionSelection(variant.fullId);
    efforts.add(selection.effort);
    speeds.add(selection.speed);
    thinkings.add(selection.thinking);
  }
  const axes: OptionAxis[] = [];
  const effortValues = uniqueInOrder(efforts, EFFORT_ORDER);
  if (effortValues.length >= 2) axes.push({ axis: 'effort', values: effortValues });
  const speedValues = uniqueInOrder(speeds, SPEED_ORDER);
  if (speedValues.length >= 2) axes.push({ axis: 'speed', values: speedValues });
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

export function composeOptionId(
  variants: readonly ModelVariant[],
  selection: OptionSelection,
): string | undefined {
  return variants.find((variant) => {
    const parsed = parseOptionSelection(variant.fullId);
    return (
      parsed.effort === selection.effort &&
      parsed.speed === selection.speed &&
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
): string | undefined {
  const current = parseOptionSelection(currentId);
  const def = optionAxesOf(variants).find((entry) => entry.axis === axis);
  if (def === undefined) return undefined;
  switch (def.axis) {
    case 'effort':
      for (const value of nextValues(def.values, current.effort)) {
        const id = composeOptionId(variants, { ...current, effort: value });
        if (id !== undefined) return id;
      }
      return undefined;
    case 'speed':
      for (const value of nextValues(def.values, current.speed)) {
        const id = composeOptionId(variants, { ...current, speed: value });
        if (id !== undefined) return id;
      }
      return undefined;
    case 'thinking':
      for (const value of nextValues(def.values, current.thinking)) {
        const id = composeOptionId(variants, { ...current, thinking: value });
        if (id !== undefined) return id;
      }
      return undefined;
    default:
      return assertNever(def);
  }
}

export function formatAxisValue(axis: OptionAxisName, selection: OptionSelection): string {
  switch (axis) {
    case 'effort':
      return prettyOptionTokens([selection.effort]);
    case 'speed':
      return selection.speed === 'fast' ? 'Fast' : 'Standard';
    case 'thinking':
      return selection.thinking === 'on' ? 'On' : 'Off';
    default:
      return assertNever(axis);
  }
}

export function formatOptionSummary(id: string, variants: readonly ModelVariant[]): string {
  const selection = parseOptionSelection(id);
  return optionAxesOf(variants)
    .map((axis) => formatAxisValue(axis.axis, selection))
    .join(OPTION_SUMMARY_SEP);
}
