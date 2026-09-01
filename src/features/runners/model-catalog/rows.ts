import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import type { ProvenanceWord } from '../../../core/providers/provenance.js';
import type {
  CliProviderAuth,
  CliProviderAuthUnreadableReason,
} from '../../../core/discovery/detection.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  formatAxisValue,
  isOptionFamily,
  optionAxesOf,
  parseOptionSelection,
  routeDraftOf,
  routePrefixesOf,
  stepOptionAxis,
  type OptionAxisName,
} from './option-axis.js';
import { findProviderCredentialFact, modelProviderAuthKey } from './provider-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

/** What the tool's own credential listing says about one route's provider. */
export type RouteAuthState =
  | { kind: 'configured'; source: 'oauth' | 'api' | 'env'; envVar?: string }
  | { kind: 'needs-sign-in' }
  | { kind: 'unknown'; reason: CliProviderAuthUnreadableReason | 'empty' }
  | { kind: 'unchecked' };

/** A steppable dimension of an expanded model: spelled by the id, or by the tool's variant flag. */
export type RightAxisName = OptionAxisName | 'variant';

export type RightRow =
  | {
      kind: 'model';
      model: ModelOption;
      provenance: ProvenanceWord;
      section: string;
      expanded: boolean;
    }
  | {
      kind: 'route';
      model: ModelOption;
      variant: ModelVariant;
      auth: RouteAuthState;
      /** Widest tag among the sibling routes, so their auth words share one column. */
      tagWidth: number;
    }
  | {
      kind: 'axis';
      model: ModelOption;
      axis: RightAxisName;
      /** The provider route the axis steps inside; empty on an option family. */
      providerPrefix: string;
      value: string;
      /** The presets a variant axis cycles through; empty on an id-spelled axis. */
      choices: readonly string[];
      /** Whether the ladder has anywhere to step; the cycle mark and the byline read this one value. */
      steps: boolean;
      /** Picks the tree glyph that closes the parent's child block. */
      last: boolean;
    }
  | { kind: 'notice'; lane: 'pending' | 'failed'; text: string; action?: 'refresh' }
  | { kind: 'action'; action: 'browse-catalog'; text: string };

type AxisRow = Extract<RightRow, { kind: 'axis' }>;

/** Whether the catalog fetch that feeds suggestion rows has landed. */
export type CatalogLane = 'ready' | 'pending' | 'failed';

/** Below this many rows the list reads fine flat, so no section carries its weight. */
const SECTION_THRESHOLD = 12;

/** One wording for the pending catalog lane; the picker byline reuses it. */
export const CATALOG_LANE_PENDING = 'Loading models…';

/** One wording for the failed lane; the picker byline appends its retry key to it. */
export const CATALOG_FETCH_FAILED = 'Could not load models';

/** One wording for the escape row that opens the unfiltered catalog. */
export const BROWSE_CATALOG_TEXT = 'Browse the full catalog';

/** One wording for a variant axis nobody has drafted yet. */
export const UNSET_VARIANT_WORD = '—';

const NOTICE_TEXT: Readonly<Record<'pending' | 'failed', string>> = {
  pending: CATALOG_LANE_PENDING,
  failed: CATALOG_FETCH_FAILED,
};

export function routeAuthStateFor(input: {
  hasOracle: boolean;
  variant: ModelVariant;
  providerAuth: CliProviderAuth | undefined;
}): RouteAuthState {
  if (!input.hasOracle) return { kind: 'unchecked' };
  if (input.providerAuth === undefined) return { kind: 'unchecked' };
  switch (input.providerAuth.kind) {
    case 'empty':
      return { kind: 'unknown', reason: 'empty' };
    case 'unreadable':
      return { kind: 'unknown', reason: input.providerAuth.reason };
    case 'read': {
      const authKey = modelProviderAuthKey(input.variant.fullId) ?? input.variant.providerPrefix;
      const fact = findProviderCredentialFact(authKey, input.providerAuth.facts);
      if (fact === undefined) return { kind: 'needs-sign-in' };
      return {
        kind: 'configured',
        source: fact.source,
        ...(fact.envVar === undefined ? {} : { envVar: fact.envVar }),
      };
    }
    default:
      return assertNever(input.providerAuth);
  }
}

/** True when any route of the row carries the tool's own preset ladder. */
export function offersVariantLadder(model: ModelOption): boolean {
  return (model.variants ?? []).some((variant) => (variant.variantChoices ?? []).length > 0);
}

/**
 * The steppable dimensions of one route, closing with the tool's preset ladder
 * where that route spells one. A single draft serves every route, so it reads as
 * set only under the route whose vocabulary contains it.
 */
function axisRowsFor(input: {
  model: ModelOption;
  providerPrefix: string;
  optionDraftId: string | null | undefined;
  variantDraft: string | null | undefined;
}): AxisRow[] {
  const { model, providerPrefix } = input;
  const variants = model.variants ?? [];
  const drafted = routeDraftOf(model, providerPrefix, input.optionDraftId);
  const selection = parseOptionSelection(drafted);
  const axisRows: AxisRow[] = [];
  for (const axis of optionAxesOf(variants, providerPrefix)) {
    axisRows.push({
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
  const choices = variants.find((variant) => variant.fullId === drafted)?.variantChoices ?? [];
  if (choices.length > 0) {
    const draft = input.variantDraft ?? '';
    axisRows.push({
      kind: 'axis',
      model,
      axis: 'variant',
      providerPrefix,
      value: choices.includes(draft) ? draft : UNSET_VARIANT_WORD,
      choices,
      // The ladder the picker walks is `[null, ...choices]`, so even a lone preset
      // steps — between unset and itself.
      steps: true,
      last: false,
    });
  }
  return axisRows.map((row, index) => ({ ...row, last: index === axisRows.length - 1 }));
}

function provenanceFor(model: ModelOption, customModels: readonly string[]): ProvenanceWord {
  if (model.isCustom === true || customModels.includes(model.id)) return 'Custom';
  switch (model.membership) {
    case 'confirmed':
      return 'Detected';
    case 'stale':
      return 'Stale';
    case 'catalog-suggestion':
      return 'Catalog';
    case 'bundled-suggestion':
      return 'Known';
    case 'custom':
      return 'Custom';
    case undefined:
      if (model.isStale === true) return 'Stale';
      if (model.isDetected === true) return 'Detected';
      return 'Known';
    default:
      return assertNever(model.membership);
  }
}

type PlacementGroup = 'list' | 'custom';

interface Placement {
  readonly model: ModelOption;
  readonly provenance: ProvenanceWord;
  readonly group: PlacementGroup;
}

function groupKeyFor(provenance: ProvenanceWord): PlacementGroup {
  return provenance === 'Custom' ? 'custom' : 'list';
}

function groupRank(key: PlacementGroup): number {
  switch (key) {
    case 'list':
      return 0;
    case 'custom':
      return 1;
    default:
      return assertNever(key);
  }
}

export function buildRightRows(input: {
  models: readonly ModelOption[];
  expandedModelId: string | null;
  providerAuth: CliProviderAuth | undefined;
  hasOracle: boolean;
  catalogLane: CatalogLane;
  persistedModel: string | undefined;
  customModels: readonly string[];
  browseCatalog: boolean;
  optionDraftId?: string | null;
  variantDraft?: string | null;
}): RightRow[] {
  const sectioned = input.models.length > SECTION_THRESHOLD;
  const automatic: ModelOption[] = [];
  let placements: Placement[] = [];
  for (const model of input.models) {
    if (isAutomaticModel(model.id)) {
      automatic.push(model);
      continue;
    }
    const provenance = provenanceFor(model, input.customModels);
    placements.push({
      model,
      provenance,
      group: groupKeyFor(provenance),
    });
  }

  const hasLiveLane = placements.some(
    (placement) =>
      placement.model.membership === 'confirmed' ||
      placement.model.membership === 'stale' ||
      placement.model.membership === 'catalog-suggestion',
  );
  // Browsing widens the list. For claude-code and copilot the authoritative list
  // is itself bundled, so subtracting it here would delete what the escape was
  // opened from.
  if (hasLiveLane && !input.browseCatalog) {
    placements = placements.filter(
      (placement) =>
        placement.model.membership !== 'bundled-suggestion' ||
        placement.model.id === input.persistedModel ||
        placement.provenance === 'Custom',
    );
  }

  const order: PlacementGroup[] = [];
  for (const placement of placements) {
    if (!order.includes(placement.group)) order.push(placement.group);
  }
  order.sort((a, b) => groupRank(a) - groupRank(b));

  const rows: RightRow[] = [];
  const pushModel = (placement: Placement, section: string): void => {
    const model = placement.model;
    const expanded = model.id === input.expandedModelId;
    rows.push({
      kind: 'model',
      model,
      provenance: placement.provenance,
      section,
      expanded,
    });
    if (!expanded) return;
    const variants = model.variants ?? [];
    const axesOf = (providerPrefix: string): AxisRow[] =>
      axisRowsFor({
        model,
        providerPrefix,
        optionDraftId: input.optionDraftId,
        variantDraft: input.variantDraft,
      });
    if (isOptionFamily(model)) {
      rows.push(...axesOf(''));
      return;
    }
    if (variants.length === 0) return;
    const tagWidth = variants.reduce(
      (widest, variant) =>
        Math.max(widest, getTerminalCellWidth(sanitizeTerminalDisplayText(variant.tag))),
      0,
    );
    // Each route carries its own axes: a row that spans two providers offers
    // every spelling of both, not just the drafted one's.
    for (const prefix of routePrefixesOf(variants)) {
      const variant = variants.find((entry) => entry.providerPrefix === prefix);
      if (variant === undefined) continue;
      rows.push({
        kind: 'route',
        model,
        variant,
        tagWidth,
        auth: routeAuthStateFor({
          hasOracle: input.hasOracle,
          variant,
          providerAuth: input.providerAuth,
        }),
      });
      rows.push(...axesOf(prefix));
    }
  };

  for (const model of automatic) {
    rows.push({ kind: 'model', model, provenance: 'Default', section: '', expanded: false });
  }

  for (const key of order) {
    const members = placements.filter((placement) => placement.group === key);
    const section = key === 'custom' && sectioned ? 'Custom' : '';
    for (const placement of members) pushModel(placement, section);
  }

  if (!input.browseCatalog && placements.some((placement) => placement.model.isRecovery === true)) {
    rows.push({ kind: 'action', action: 'browse-catalog', text: BROWSE_CATALOG_TEXT });
  }

  if (input.catalogLane !== 'ready') {
    rows.push({
      kind: 'notice',
      lane: input.catalogLane,
      text: NOTICE_TEXT[input.catalogLane],
      ...(input.catalogLane === 'failed' ? { action: 'refresh' as const } : {}),
    });
  }

  return rows;
}

export function rightRowKey(row: RightRow): string {
  switch (row.kind) {
    case 'model':
      return `model:${row.model.id}`;
    case 'route':
      return `route:${row.model.id}:${row.variant.fullId}`;
    case 'axis':
      return `axis:${row.model.id}:${row.providerPrefix}:${row.axis}`;
    case 'notice':
      return `notice:${row.lane}`;
    case 'action':
      return 'action:browse-catalog';
    default:
      return assertNever(row);
  }
}

/** The section header a row opens, or `undefined` when it opens none. */
export function sectionOf(row: RightRow): string | undefined {
  if (row.kind !== 'model') return undefined;
  return row.section === '' ? undefined : row.section;
}
