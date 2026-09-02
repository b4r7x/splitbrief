import { formatModelName } from '../../../core/model-display.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { EFFORT_AXIS_TOKENS } from '../../../core/runners/effort-channel.js';
import { bestMembership } from './membership.js';
import { modelBareId, modelProviderPrefix } from './provider-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

interface PeeledOptionSuffix {
  readonly familyId: string;
  readonly tokens: readonly string[];
}

interface OptionMergeContext {
  readonly persistedModel?: string | undefined;
  readonly customModels?: readonly string[];
}

const EFFORT_TOKENS = new Set<string>(EFFORT_AXIS_TOKENS);
const DISPLAY_OPTION_WORDS = new Set(['fast', 'thinking', 'none', 'low', 'medium', 'high', 'max']);
const DISPLAY_CONTEXT_WORDS = new Set(['1m', '1.0m', '1.1m']);
const TRAILING_PARENS_RE = /(\s*\([^()]*\))$/;

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

function peelBareOptionSuffix(id: string): PeeledOptionSuffix {
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

/** Closed option tokens, right-to-left. A provider route peels its bare id and keeps the prefix. */
export function peelOptionSuffix(id: string): PeeledOptionSuffix {
  const prefix = modelProviderPrefix(id);
  if (prefix === undefined) return peelBareOptionSuffix(id);
  const bare = peelBareOptionSuffix(modelBareId(id));
  return { familyId: `${prefix}/${bare.familyId}`, tokens: bare.tokens };
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

export function prettyOptionTokens(tokens: readonly string[]): string {
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
  if (row.isCustom === true) return true;
  if (row.membership === 'custom') return true;
  return false;
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
 * Groups of size 1 stay flat; a family never spans two provider routes.
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
