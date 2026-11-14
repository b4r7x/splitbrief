import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import type { ProvenanceWord } from '../../../core/providers/provenance.js';
import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection/auth.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { routeAuthState } from '../../../core/runners/route-auth.js';
import { CATALOG_SUGGESTION_MEMBERSHIP } from '../../../engine/providers/model/catalog.js';
import { assertNever } from '../../../utils/type-guards.js';
import { isOptionFamily, routePrefixesOf } from './option-axis.js';
import type { ModelOption } from './recency.js';
import type { AxisRow, CatalogLane, RightRow } from './types.js';
import { axisRowsFor } from './axis-rows.js';

/** Below this many rows the list reads fine flat, so no section carries its weight. */
const SECTION_THRESHOLD = 12;

/** One wording for the pending catalog lane; the picker byline reuses it. */
export const CATALOG_LANE_PENDING = 'Loading models…';

/** One wording for the failed lane; the picker byline appends its retry key to it. */
export const CATALOG_FETCH_FAILED = 'Could not load models';

/** One wording for the Auto row's metadata cell; the row model carries no size. */
export const AUTO_ROW_METADATA = 'tool decides';

/** One wording for the escape row that opens the unfiltered catalog. */
export const BROWSE_CATALOG_TEXT = 'Browse the full catalog…';

function provenanceFor(model: ModelOption, customModels: readonly string[]): ProvenanceWord {
  if (model.isCustom === true || customModels.includes(model.id)) return 'Custom';
  switch (model.membership) {
    case 'confirmed':
      return 'Detected';
    case 'stale':
      return 'Stale';
    case CATALOG_SUGGESTION_MEMBERSHIP:
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
  /** The tool's own model listing, read against the route like its credential listing. */
  catalog: SavedCatalog | null | undefined;
  tool: CliToolId | undefined;
  catalogLane: CatalogLane;
  persistedModel: string | undefined;
  customModels: readonly string[];
  browseCatalog: boolean;
  optionDraftId?: string | null;
  effortDraft?: string | null;
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
      placement.model.membership === CATALOG_SUGGESTION_MEMBERSHIP,
  );
  // Browsing widens the list. For claude-code and copilot the authoritative list
  // is itself bundled, so subtracting it here would delete what the escape was
  // opened from.
  let widenable = false;
  if (hasLiveLane && !input.browseCatalog) {
    const kept = placements.filter(
      (placement) =>
        placement.model.membership !== 'bundled-suggestion' ||
        placement.model.id === input.persistedModel ||
        placement.provenance === 'Custom',
    );
    widenable = kept.length < placements.length;
    placements = kept;
  }

  const order: PlacementGroup[] = [];
  for (const placement of placements) {
    if (!order.includes(placement.group)) order.push(placement.group);
  }
  order.sort((a, b) => groupRank(a) - groupRank(b));

  const childRowsOf = (model: ModelOption): RightRow[] => {
    const variants = model.variants ?? [];
    const axesOf = (providerPrefix: string): AxisRow[] =>
      axisRowsFor({
        model,
        providerPrefix,
        optionDraftId: input.optionDraftId,
        effortDraft: input.effortDraft,
      });
    // An option family and a variant-less row both hold one route: their axes hang
    // off the model itself rather than off a route row.
    if (isOptionFamily(model) || variants.length === 0) {
      return axesOf('').map((row) => ({
        ...row,
        tree: { depth: 1, parentContinues: false } as const,
      }));
    }
    // Each route carries its own axes: a row that spans two providers offers
    // every spelling of both, not just the drafted one's.
    const children: RightRow[] = [];
    const routes = routePrefixesOf(variants);
    for (const prefix of routes) {
      const variant = variants.find((entry) => entry.providerPrefix === prefix);
      if (variant === undefined) continue;
      const isLastRoute = prefix === routes[routes.length - 1];
      children.push({
        kind: 'route',
        model,
        variant,
        last: isLastRoute,
        tree: { depth: 1, parentContinues: false } as const,
        auth: routeAuthState({
          tool: input.tool,
          model: variant.fullId,
          providerAuth: input.providerAuth,
          catalog: input.catalog,
        }),
      });
      children.push(
        ...axesOf(prefix).map((row) => ({
          ...row,
          tree: { depth: 2, parentContinues: !isLastRoute } as const,
        })),
      );
    }
    return children;
  };

  const rows: RightRow[] = [];
  const pushModel = (placement: Placement, section: string): void => {
    const model = placement.model;
    const children = model.id === input.expandedModelId ? childRowsOf(model) : [];
    // A row with nothing under it confirms like any closed row, whatever id the store drafted.
    rows.push({
      kind: 'model',
      model,
      provenance: placement.provenance,
      section,
      expanded: children.length > 0,
    });
    rows.push(...children);
  };

  for (const model of automatic) {
    rows.push({
      kind: 'model',
      model,
      provenance: provenanceFor(model, input.customModels),
      section: '',
      expanded: false,
    });
  }

  for (const key of order) {
    const members = placements.filter((placement) => placement.group === key);
    const section = key === 'custom' && sectioned ? 'Custom' : '';
    for (const placement of members) pushModel(placement, section);
  }

  // The escape is offered only where it delivers: rows this pass subtracted. A
  // configured id no lane lists is a recovery row, not a wider catalog.
  if (widenable) {
    rows.push({ kind: 'action', action: 'browse-catalog', text: BROWSE_CATALOG_TEXT });
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
