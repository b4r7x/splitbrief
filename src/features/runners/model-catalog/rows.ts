import type { ActiveRunnerConfig } from '../../../core/config/accessors/active-runner.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import type { ProvenanceWord } from '../../../core/providers/provenance.js';
import type {
  CliProviderAuth,
  CliProviderAuthFact,
  CliProviderAuthUnreadableReason,
} from '../../../core/discovery/detection.js';
import { deriveCliAuthSelection } from '../../../core/runners/cli-auth-selection.js';
import type {
  CliAuthEnforcementEvidence,
  CliAuthMethod,
} from '../../../core/runners/cli-tool-catalog.js';
import { UNSET_EFFORT_WORD } from '../../../core/runners/effort-channel.js';
import { CATALOG_SUGGESTION_MEMBERSHIP } from '../../../engine/providers/model/catalog.js';
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
import type { PickerOption } from './options.js';
import { findProviderCredentialFact, modelProviderAuthKey } from './provider-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

/** What the tool's own credential listing says about one route's provider. */
export type RouteAuthState =
  | { kind: 'configured'; source: CliProviderAuthFact['source']; envVar?: string }
  | { kind: 'needs-sign-in' }
  | { kind: 'unknown'; reason: CliProviderAuthUnreadableReason | 'empty' }
  | { kind: 'unchecked' };

/**
 * A steppable dimension of an expanded model: spelled by the model id, or by the
 * ladder the tool publishes for it. One vocabulary answers both, so the row model
 * borrows the id parser's names rather than adding one of its own.
 */
export type RightAxisName = OptionAxisName;

export interface TreeLead {
  /** Level 1 = a route, or the axes of a flat option family. Level 2 = the axes under a route. */
  readonly depth: 1 | 2;
  /** Depth 2 only: the level-1 parent above is not last, so its spine continues. */
  readonly parentContinues: boolean;
}

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
      /** Picks the tree glyph that closes the model's route block. */
      last: boolean;
      tree: TreeLead;
    }
  | {
      kind: 'axis';
      model: ModelOption;
      axis: RightAxisName;
      /** The provider route the axis steps inside; empty on an option family. */
      providerPrefix: string;
      value: string;
      /** The ladder this axis steps through; empty when the axis is spelled by the model id. */
      choices: readonly string[];
      /** Whether the ladder has anywhere to step, so no surface promises a key that cannot move. */
      steps: boolean;
      /** Picks the tree glyph that closes the parent's child block. */
      last: boolean;
      tree: TreeLead;
    }
  | {
      kind: 'auth';
      model: ModelOption;
      /** The method the row reads: the drafted one, else the one the seat runs today. */
      method: CliAuthMethod | 'host-configured';
      /** The ladder space steps through; empty where there is nothing to choose. */
      choices: readonly AuthMethodChoice[];
      /** Whether the ladder has anywhere to step, so no surface promises a key that cannot move. */
      steps: boolean;
      /** The seat carries a method no adapter can enforce, so dispatch would refuse the run. */
      unproven: boolean;
      /** Picks the tree glyph that closes the model's child block. */
      last: boolean;
      tree: TreeLead;
    }
  | { kind: 'action'; action: 'browse-catalog'; text: string };

type AxisRow = Omit<Extract<RightRow, { kind: 'axis' }>, 'tree'>;
type AuthRow = Omit<Extract<RightRow, { kind: 'auth' }>, 'tree'>;

/** A method the seat can be bound to, or the tool's own login and configuration. */
export type AuthMethodChoice = CliAuthMethod | 'host-configured';

/**
 * Whether this seat may choose an authentication method for one invocation, and
 * what it runs today. `methods` is empty unless the matrix proves this exact
 * adapter, platform and installed version forces the method it is handed.
 */
export type AuthMethodOffer = Readonly<{
  methods: readonly CliAuthMethod[];
  selected: AuthMethodChoice;
}>;

/**
 * The offer belongs to the runner the seat actually runs: a tool the cursor is
 * merely visiting has no seat to bind a method to, and an API or custom-command
 * seat authenticates through its own connection rather than a CLI's login.
 */
export function authMethodOffer(input: {
  item: PickerOption | undefined;
  runner: ActiveRunnerConfig;
  platform?: NodeJS.Platform;
  /** The matrix to read; production's is the default, so no fixture can label a tool supported. */
  evidence?: readonly CliAuthEnforcementEvidence[];
}): AuthMethodOffer | undefined {
  const { item, runner } = input;
  if (item?.kind !== 'cli' || item.isCurrent !== true) return undefined;
  if (runner.kind !== 'cli' || runner.tool !== item.id) return undefined;
  const selection = deriveCliAuthSelection({
    tool: runner.tool,
    platform: input.platform ?? process.platform,
    installedVersion: item.version,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const channel = runner.authChannel;
  return {
    methods: selection.kind === 'enforceable' ? selection.channels : [],
    // A configured `provider-dependent` names a route, not a method, and an
    // omitted channel is the tool's own login — neither is a user's choice.
    selected:
      channel === undefined || channel === 'provider-dependent' ? 'host-configured' : channel,
  };
}

/** Whether the catalog fetch that feeds suggestion rows has landed. */
export type CatalogLane = 'ready' | 'pending' | 'failed';

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

/** The label the authentication row carries; the method itself is its value. */
export const AUTH_ROW_LABEL = 'auth';

/**
 * The words the row spells. A method is how the call authenticates, never what it
 * costs, so no billing posture is spoken here. `host-configured` keeps one wording
 * whether it is the only answer or one rung of a ladder, and it is short enough to
 * survive the Models column — a cut sentence would leave the one row that answers
 * this question saying nothing.
 */
export const AUTH_METHOD_WORDS: Readonly<Record<AuthMethodChoice, string>> = {
  session: 'session',
  'api-key': 'api key',
  'host-configured': 'CLI decides',
};

/** What a configured method no adapter can enforce reads as: the run would be refused. */
export const AUTH_UNPROVEN_WORD = 'unproven';

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
function axisRowsFor(input: {
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

/**
 * The ladder the row steps: the enforceable methods, then the host configuration
 * that unsets them. Where nothing is enforceable there is nothing to choose — except
 * for a seat that already carries a method, whose only rung is the way back out,
 * because dispatch refuses that run and this row is where the field is removed.
 */
function authMethodChoices(offer: AuthMethodOffer): readonly AuthMethodChoice[] {
  if (offer.methods.length > 0) return [...offer.methods, 'host-configured'];
  return offer.selected === 'host-configured' ? [] : ['host-configured'];
}

/**
 * The one row that answers how the seat's calls authenticate. A method drafted
 * before this ladder existed is not a rung of it, so the row reads what the seat
 * runs until the draft lands on something this ladder spells.
 */
function authRowFor(
  model: ModelOption,
  offer: AuthMethodOffer,
  draft: AuthMethodChoice | null | undefined,
): AuthRow {
  const choices = authMethodChoices(offer);
  const method = draft != null && choices.includes(draft) ? draft : offer.selected;
  return {
    kind: 'auth',
    model,
    method,
    choices,
    // The one rung the row already reads is not a step; the byline must not promise it.
    steps: choices.some((choice) => choice !== method),
    // A method outside the proven set is refused at dispatch, whether the matrix
    // proves nothing at all or proves a different method for this adapter.
    unproven: method !== 'host-configured' && !offer.methods.includes(method),
    last: false,
  };
}

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
  hasOracle: boolean;
  catalogLane: CatalogLane;
  persistedModel: string | undefined;
  customModels: readonly string[];
  browseCatalog: boolean;
  optionDraftId?: string | null;
  effortDraft?: string | null;
  /** The seat's own method offer; absent where no CLI invocation is being configured. */
  authMethod?: AuthMethodOffer | undefined;
  authDraft?: AuthMethodChoice | null;
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
        effortDraft: input.effortDraft,
      });
    // An option family and a variant-less row both hold one route: their axes hang
    // off the model itself rather than off a route row.
    const flat = isOptionFamily(model) || variants.length === 0;
    // Each route carries its own axes: a row that spans two providers offers
    // every spelling of both, not just the drafted one's.
    const routes = flat ? [] : routePrefixesOf(variants);
    const flatAxes = flat ? axesOf('') : [];
    // How the call authenticates is answered once, above the routes and axes it
    // applies to, so each of those keeps the glyph it already draws.
    if (input.authMethod !== undefined) {
      rows.push({
        ...authRowFor(model, input.authMethod, input.authDraft),
        last: routes.length === 0 && flatAxes.length === 0,
        tree: { depth: 1, parentContinues: false },
      });
    }
    if (flat) {
      rows.push(
        ...flatAxes.map((row) => ({
          ...row,
          tree: { depth: 1, parentContinues: false } as const,
        })),
      );
      return;
    }
    for (const prefix of routes) {
      const variant = variants.find((entry) => entry.providerPrefix === prefix);
      if (variant === undefined) continue;
      const isLastRoute = prefix === routes[routes.length - 1];
      rows.push({
        kind: 'route',
        model,
        variant,
        last: isLastRoute,
        tree: { depth: 1, parentContinues: false } as const,
        auth: routeAuthStateFor({
          hasOracle: input.hasOracle,
          variant,
          providerAuth: input.providerAuth,
        }),
      });
      rows.push(
        ...axesOf(prefix).map((row) => ({
          ...row,
          tree: { depth: 2, parentContinues: !isLastRoute } as const,
        })),
      );
    }
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
    case 'auth':
      return 'auth';
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
