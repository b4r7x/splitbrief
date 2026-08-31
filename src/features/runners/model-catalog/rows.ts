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
  optionDraftOf,
  parseOptionSelection,
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
      axis: OptionAxisName;
      value: string;
      /** Picks the tree glyph that closes the parent's child block. */
      last: boolean;
    }
  | { kind: 'notice'; lane: 'pending' | 'failed'; text: string; action?: 'refresh' };

/** Whether the catalog fetch that feeds suggestion rows has landed. */
export type CatalogLane = 'ready' | 'pending' | 'failed';

/** Below this many rows the list reads fine flat, so no section carries its weight. */
const SECTION_THRESHOLD = 12;

/** One wording for the pending catalog lane; the picker byline reuses it. */
export const CATALOG_LANE_PENDING = 'Loading models…';

/** One wording for the failed lane; the picker byline appends its retry key to it. */
export const CATALOG_FETCH_FAILED = 'Could not load models';

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

interface Placement {
  readonly model: ModelOption;
  readonly provenance: ProvenanceWord;
  readonly group: string;
}

function groupKeyFor(provenance: ProvenanceWord): string {
  return provenance === 'Custom' ? 'custom' : 'list';
}

function groupRank(key: string): number {
  return key === 'custom' ? 1 : 0;
}

function sectionLabel(key: string): string {
  return key === 'custom' ? 'Custom' : '';
}

function byReleaseDateDesc(a: Placement, b: Placement): number {
  return (b.model.releaseDate ?? '').localeCompare(a.model.releaseDate ?? '');
}

export function buildRightRows(input: {
  models: readonly ModelOption[];
  expandedModelId: string | null;
  providerAuth: CliProviderAuth | undefined;
  hasOracle: boolean;
  catalogLane: CatalogLane;
  persistedModel: string | undefined;
  customModels: readonly string[];
  optionDraftId?: string | null;
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
  if (hasLiveLane) {
    placements = placements.filter(
      (placement) =>
        placement.model.membership !== 'bundled-suggestion' ||
        placement.model.id === input.persistedModel ||
        placement.provenance === 'Custom',
    );
  }

  const order: string[] = [];
  for (const placement of placements) {
    if (!order.includes(placement.group)) order.push(placement.group);
  }
  order.sort((a, b) => groupRank(a) - groupRank(b));

  const rows: RightRow[] = [];
  const pushModel = (placement: Placement, section: string): void => {
    const expanded = placement.model.id === input.expandedModelId;
    rows.push({
      kind: 'model',
      model: placement.model,
      provenance: placement.provenance,
      section,
      expanded,
    });
    if (!expanded) return;
    const variants = placement.model.variants ?? [];
    if (isOptionFamily(placement.model)) {
      const selection = parseOptionSelection(optionDraftOf(placement.model, input.optionDraftId));
      const axes = optionAxesOf(variants);
      for (const [index, axis] of axes.entries()) {
        rows.push({
          kind: 'axis',
          model: placement.model,
          axis: axis.axis,
          value: formatAxisValue(axis.axis, selection),
          last: index === axes.length - 1,
        });
      }
      return;
    }
    const tagWidth = variants.reduce(
      (widest, variant) =>
        Math.max(widest, getTerminalCellWidth(sanitizeTerminalDisplayText(variant.tag))),
      0,
    );
    for (const variant of variants) {
      rows.push({
        kind: 'route',
        model: placement.model,
        variant,
        tagWidth,
        auth: routeAuthStateFor({
          hasOracle: input.hasOracle,
          variant,
          providerAuth: input.providerAuth,
        }),
      });
    }
  };

  for (const model of automatic) {
    rows.push({ kind: 'model', model, provenance: 'Default', section: '', expanded: false });
  }

  if (!sectioned) {
    for (const placement of placements) pushModel(placement, '');
  } else {
    for (const key of order) {
      const members = placements.filter((placement) => placement.group === key);
      const section = sectionLabel(key);
      const ordered = members.toSorted(byReleaseDateDesc);
      for (const placement of ordered) pushModel(placement, section);
    }
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
      return `axis:${row.model.id}:${row.axis}`;
    case 'notice':
      return `notice:${row.lane}`;
    default:
      return assertNever(row);
  }
}

/** The section header a row opens, or `undefined` when it opens none. */
export function sectionOf(row: RightRow): string | undefined {
  if (row.kind !== 'model') return undefined;
  return row.section === '' ? undefined : row.section;
}
