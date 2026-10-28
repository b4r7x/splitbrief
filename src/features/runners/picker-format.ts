import { SOFT_SEP } from '../../core/separators.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { countNoun } from '../../utils/pluralize.js';
import type { ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import { isCliToolId, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { billingWord, type RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import type { PickerModelCounts } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RunnerPermissionPosture } from './model-catalog/posture.js';
import type { PickerOptionStatus } from './model-catalog/status.js';
import {
  CATALOG_FETCH_FAILED,
  CATALOG_LANE_PENDING,
  effortLadderFor,
  type CatalogLane,
  type RightRow,
} from './model-catalog/rows.js';
import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import {
  ROUTE_NEEDS_SIGN_IN,
  routeNoCredential,
  routeSignInCommand,
  type RouteAuthState,
} from '../../core/runners/route-auth.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import type { ResolvedModelMembership } from '../../engine/providers/model/catalog.js';
import { assertNever } from '../../utils/type-guards.js';
import { formatContextLength } from '../../core/formatting.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { UNSET_EFFORT_WORD } from '../../core/runners/effort-channel.js';
import type { PickerSlot, SeatPickerRole } from '../../core/runners/seat-roles.js';
import {
  formatAxisValue,
  optionAxesOf,
  parseOptionSelection,
} from './model-catalog/option-axis.js';
import type { ModelOption } from './model-catalog/recency.js';

const DETECTING_MODELS_COPY = 'Detecting models…';
// Detection has not run yet, whichever path noticed it: one state, one sentence, naming the key
// that runs it rather than asking for a selection the user has already made.
const DETECTION_NOT_RUN = 'Model detection has not run yet';
// Detection has not run *and* the panel beside the byline is listing rows: those rows are the
// bundled list, so the byline names which list the user is reading instead of denying it exists.
const BUNDLED_LIST = 'Bundled model list';

/** Why a native CLI catalog probe produced no confirmed models. */
export type ModelCatalogDiagnostic =
  | Readonly<{ kind: 'not-probed' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'probe-failed';
      failure: Exclude<ProbeOutcomeKind, 'success' | 'command-failed'>;
    }>
  | Readonly<{ kind: 'probe-failed'; failure: 'command-failed'; cause: string }>;

/**
 * The launcher's card is a fixed-height read-only pane, so a line written to its narrowest draw
 * never takes a second row: at 60 columns the overlay is 56 cells wide, the
 * Models box takes 27 of them and its padding and border spend 4, leaving these.
 */
export const CUSTOM_COMMAND_PANE_CELLS = 23;

/**
 * What the launcher row promises: the action, the two contracts it chooses between, the two steps
 * Enter opens and the fact that neither of them has written anything yet. The seat is not repeated
 * here — the picker's title names it one row above the card — and neither is the configured
 * command, which the row under the cursor already spells.
 */
export const CUSTOM_COMMAND_PANE_LINES: readonly string[] = [
  'Run your own command.',
  '',
  `output${SOFT_SEP}reads stdout`,
  `direct${SOFT_SEP}writes files`,
  '',
  '⏎ picks the contract,',
  'then the command.',
  'Nothing is saved yet.',
];

export function fallbackInheritanceNotice(
  input: Readonly<{ slot: PickerSlot; role: SeatPickerRole; inherited: boolean }>,
): string | undefined {
  return input.slot === 'fallback' && input.role === 'reviewer' && input.inherited
    ? `${CREW_SEAT_LABELS.review} ${PLANNER_INHERITANCE.mark}${SOFT_SEP}saving here gives REVIEW its own seat`
    : undefined;
}

export function isPickerItemDisabled(item: PickerOption): boolean {
  if (item.kind === 'custom-command' || item.kind === 'no-fallback') return false;
  return !item.available;
}

export function formatPickerStatusLabel(status: PickerOptionStatus): string | undefined {
  switch (status.state) {
    case 'ready':
      return undefined;
    case 'unavailable':
      return 'Unavailable';
    case 'unauthenticated':
      return 'Auth required';
    case 'incompatible':
      return 'Incompatible';
    case 'untrusted':
      return 'Untrusted';
    case 'unverified':
      return 'Unverified';
    case 'disabled':
      return 'Disabled';
    default:
      return assertNever(status);
  }
}

/** The sandbox posture leads: it is the one label that differs between tools, and a byline sheds from the end. */
export function formatPermissionLabels(permissions: RunnerPermissionPosture): string[] {
  const labels: string[] = [];
  if (permissions.sandbox === 'cli-managed') labels.push('cli sandbox');
  else if (permissions.sandbox === 'mode-dependent') labels.push('sandbox varies');
  if (permissions.directWrite) labels.push('direct write');
  if (permissions.network) labels.push('network');
  if (permissions.shell) labels.push('shell');
  if (permissions.automaticApproval) labels.push('auto approval');
  return labels;
}

function isDetectionNotRun(diagnostic: ModelCatalogDiagnostic): boolean {
  if (diagnostic.kind === 'not-probed') return true;
  return diagnostic.kind === 'probe-failed' && diagnostic.failure === 'not-run';
}

function noListingSentence(toolName: string): string {
  return `${toolName} does not support model listing`;
}

/**
 * A tool the picker cannot run states its remediation on the row above the catalog line. A retry
 * alone cannot sign the tool in or install it, and a CLI remediation that a recheck settles ends on
 * ctrl+r itself, so the catalog line names no retry of its own.
 */
function withRetry(failure: string, retry: string, remedied: boolean): string {
  return remedied ? failure : `${failure}${retry}`;
}

function detectionNotRunCopy(remedied: boolean): string {
  return withRetry(DETECTION_NOT_RUN, '. Press ctrl+r to refresh', remedied);
}

function commandFailedCopy(toolName: string, cause: string, remedied: boolean): string {
  return withRetry(
    `${toolName} could not list models: ${cause}`,
    `${SOFT_SEP}ctrl+r to retry`,
    remedied,
  );
}

export function formatCatalogDiagnostic(
  diagnostic: ModelCatalogDiagnostic,
  toolName: string,
  remedied: boolean,
): string {
  if (diagnostic.kind === 'not-probed') return detectionNotRunCopy(remedied);
  if (diagnostic.kind === 'unsupported') return noListingSentence(toolName);
  switch (diagnostic.failure) {
    case 'unsupported':
      return noListingSentence(toolName);
    case 'missing-credential':
      return `Sign in to ${toolName} to detect its models`;
    case 'invalid-credential':
      return `${toolName} sign-in was rejected. Sign in again`;
    case 'policy-denied':
      return `${toolName} denied model catalog access`;
    // Unreachable is not unauthenticated: the network is what failed, so the remedy is the retry
    // every other reachability failure offers, never a sign-in the tool never asked for.
    case 'offline':
      return withRetry(
        'Model detection could not reach the network',
        '. Press ctrl+r to retry',
        remedied,
      );
    case 'timeout':
      return withRetry('Model detection timed out', '. Press ctrl+r to retry', remedied);
    case 'malformed':
      return `Unreadable model list${SOFT_SEP}${remedied ? '' : 'ctrl+r will not help; '}add a custom model or report the output`;
    case 'command-failed':
      return commandFailedCopy(toolName, diagnostic.cause, remedied);
    case 'cancelled':
      return withRetry('Model detection was cancelled', '. Press ctrl+r to retry', remedied);
    case 'not-run':
      return detectionNotRunCopy(remedied);
  }
}

function formatConfiguredProviderSummary(status: PickerOptionStatus): string | undefined {
  if (status.state !== 'ready' || status.configuredProviders === undefined) return undefined;
  return `${countNoun(status.configuredProviders.length, 'provider')} configured`;
}

export function formatModelCatalogGuidance(
  item: PickerOption,
  counts: PickerModelCounts,
  diagnostic?: ModelCatalogDiagnostic,
  refreshing = false,
): { headline: string; detail: string | undefined } {
  if (item.status.state !== 'ready') {
    return {
      headline: formatPickerStatusLabel(item.status) ?? item.status.state,
      detail: item.status.remediation,
    };
  }

  const guidance = readyModelGuidance(item, counts, diagnostic, refreshing);
  const providerSummary = formatConfiguredProviderSummary(item.status);
  if (providerSummary === undefined) return guidance;
  return {
    headline: `${guidance.headline}${SOFT_SEP}${providerSummary}`,
    detail: guidance.detail,
  };
}

function readyModelGuidance(
  item: PickerOption,
  counts: PickerModelCounts,
  diagnostic?: ModelCatalogDiagnostic,
  refreshing = false,
): { headline: string; detail: string | undefined } {
  const { modelCapability } = item;
  if (
    !modelCapability.showsDiscovered &&
    !modelCapability.allowsCustom &&
    (modelCapability.policy === 'auto-only' || modelCapability.policy === 'backend-default')
  ) {
    return { headline: 'Model chosen by the tool', detail: undefined };
  }

  if (counts.confirmed > 0) {
    const noun = counts.confirmed === 1 ? 'model' : 'models';
    const headlineParts = [`${counts.confirmed} ${noun} detected`];
    if (modelCapability.allowsCustom) headlineParts.push('custom models allowed');
    return { headline: headlineParts.join(SOFT_SEP), detail: undefined };
  }

  if (refreshing) {
    return { headline: DETECTING_MODELS_COPY, detail: undefined };
  }

  const liveLane = hasLiveCatalogLane(counts);
  return zeroConfirmedGuidance({
    diagnostic,
    toolName: item.displayName,
    offersRows:
      counts.suggestions + counts.stale + counts.custom + (liveLane ? 0 : counts.bundled) > 0,
  });
}

function hasLiveCatalogLane(counts: PickerModelCounts): boolean {
  return counts.confirmed > 0 || counts.stale > 0 || counts.suggestions > 0;
}

/** No confirmed model: the byline owns the diagnostic, so the placeholder never repeats it. */
function zeroConfirmedGuidance(input: {
  diagnostic: ModelCatalogDiagnostic | undefined;
  toolName: string;
  offersRows: boolean;
}): { headline: string; detail: string | undefined } {
  if (input.diagnostic === undefined) {
    return input.offersRows
      ? { headline: 'No models confirmed', detail: undefined }
      : { headline: 'No models detected', detail: 'Press ctrl+r to refresh detection' };
  }
  if (input.diagnostic.kind === 'unsupported') {
    return { headline: noListingSentence(input.toolName), detail: undefined };
  }
  return { headline: 'No models listed', detail: undefined };
}

/** The route's own sign-in fact: words only, and whether it reads as a dim state. */
export function formatRouteAuth(input: { auth: RouteAuthState }): {
  word: string | undefined;
  dim: boolean;
} {
  const { auth } = input;
  switch (auth.kind) {
    case 'unchecked':
      return { word: undefined, dim: false };
    case 'configured':
      return auth.source === 'listed'
        ? { word: 'available', dim: false }
        : {
            word: `signed in${SOFT_SEP}${credentialSourceWord(auth.source, auth.envVar)}`,
            dim: false,
          };
    case 'needs-sign-in':
      return { word: ROUTE_NEEDS_SIGN_IN, dim: true };
    case 'unknown':
      return auth.reason === 'empty'
        ? { word: ROUTE_NEEDS_SIGN_IN, dim: true }
        : { word: 'sign-in unknown', dim: true };
    default:
      return assertNever(auth);
  }
}

function credentialSourceWord(
  source: CliProviderAuthFact['source'],
  envVar: string | undefined,
): string {
  switch (source) {
    case 'oauth':
      return 'oauth';
    case 'api':
      return 'api key';
    case 'stored':
      return 'stored credential';
    case 'env':
      return envVar === undefined ? 'env' : `$${envVar}`;
    default:
      return assertNever(source);
  }
}

/**
 * The preview truncates right, so the command that fixes the route leads —
 * except a parse failure, where no command helps and saying so is the remedy.
 */
export function formatRouteRemedy(input: {
  auth: RouteAuthState;
  toolName: string;
  oracleCommand: string;
  versions: { observed: string; required: string } | undefined;
}): string | undefined {
  const { auth } = input;
  if (auth.kind === 'configured') return undefined;
  if (auth.kind === 'unchecked') {
    return `sign-in state is not readable for ${input.toolName}${SOFT_SEP}pick the route you have set up`;
  }
  const [binary = input.oracleCommand] = input.oracleCommand.split(' ');
  if (auth.kind === 'needs-sign-in') {
    return `sign in: ${routeSignInCommand(auth.tool, auth.provider)}${SOFT_SEP}then ctrl+r`;
  }
  switch (auth.reason) {
    case 'empty':
      return `signed in to no providers yet: ${routeSignInCommand(auth.tool, auth.provider)}${SOFT_SEP}then ctrl+r`;
    case 'catalog-not-read':
      return `ctrl+r to read the model list${SOFT_SEP}no credential listed for this provider`;
    case 'timeout':
      return `ctrl+r to re-check${SOFT_SEP}${binary} took too long listing providers`;
    case 'exit-failure':
      return `ctrl+r to re-check${SOFT_SEP}${input.oracleCommand} exited with an error`;
    case 'parse-failure':
      return 'Unreadable provider list. ctrl+r will not help; report the output';
    case 'version-mismatch': {
      const { versions } = input;
      const gap = versions === undefined ? '' : ` (${versions.observed} < ${versions.required})`;
      return `upgrade ${binary}${gap}${SOFT_SEP}sign-in state not read`;
    }
    case 'not-probed':
      return 'ctrl+r to check provider sign-in';
    default:
      return assertNever(auth);
  }
}

export interface ListingSource {
  readonly source: string;
  /** The noun the tool's own list uses for one row. */
  readonly rowNoun: string;
  /** The same noun for more than one row; `alias` does not take a bare `s`. */
  readonly rowNounPlural: string;
  readonly unverifiedForPlan: boolean;
}

/**
 * Where each tool's rows really come from, in the tool's own words. Checked against
 * `declaredCatalogProbe` (`engine/runners/cli-tools/registry.ts`) and the tools themselves on
 * 2026-09-09: claude-code 2.1.265 prints no alias table, copilot 1.0.77 prints its 25-id enum,
 * cursor-agent 2026.09.08-6caf4ff prints 223 model rows.
 */
const LISTING_SOURCES: Readonly<Record<CliToolId, ListingSource>> = {
  'claude-code': {
    source: "from Claude's documented aliases",
    rowNoun: 'alias',
    rowNounPlural: 'aliases',
    unverifiedForPlan: false,
  },
  copilot: {
    source: 'from copilot help config',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: true,
  },
  cursor: {
    source: 'from cursor-agent --list-models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  opencode: {
    source: 'from opencode api GET /api/model --standalone',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  'kilo-code': {
    source: 'from kilo models --verbose',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  codex: {
    source: 'from codex debug models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  'command-code': {
    source: 'from cmd --list-models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
  antigravity: {
    source: 'from agy models',
    rowNoun: 'model',
    rowNounPlural: 'models',
    unverifiedForPlan: false,
  },
};

/** A provider that is not a CLI tool lists through the shared catalog, which knows no account. */
const CATALOG_LISTING_SOURCE: ListingSource = {
  source: 'from models.dev',
  rowNoun: 'model',
  rowNounPlural: 'models',
  unverifiedForPlan: true,
};

/** A sentence broken on words into at most `maxLines` lines of `cells`; `cut` when words are left over. */
export function wrapOnWords(
  sentence: string,
  cells: number,
  maxLines: number,
): Readonly<{ lines: string[]; cut: boolean }> {
  const lines: string[] = [];
  let line = '';
  for (const word of sentence.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && getTerminalCellWidth(next) > cells) {
      lines.push(line);
      if (lines.length === maxLines) return { lines, cut: true };
      line = word;
      continue;
    }
    line = next;
  }
  return { lines: line === '' ? lines : [...lines, line], cut: false };
}

export function pickerListingSource(toolId: string | undefined): ListingSource {
  if (toolId !== undefined && isCliToolId(toolId)) return LISTING_SOURCES[toolId];
  return CATALOG_LISTING_SOURCE;
}

const CUSTOM_MODEL_EXAMPLE_COUNT = 3;
/** Rows the tool itself listed or ships as its floor; models.dev suggestions and custom rows are not its spelling. */
const TOOL_OWN_MEMBERSHIPS: ReadonlySet<ResolvedModelMembership> = new Set([
  'confirmed',
  'stale',
  'bundled-suggestion',
]);

/**
 * The custom-model entry's examples come from the highlighted tool's own listing, spelled as that
 * tool takes them: Claude Code `claude-opus-5-5`, Codex a slug, OpenCode and Kilo `provider/model`.
 * An alias row gives the id it resolves to, because the alias is already a row. The examples teach
 * the id's form, so each names a different provider. A tool whose listing has not landed names the
 * command that lists its ids instead.
 */
export function customModelEntryCopy(
  input: Readonly<{ rows: readonly RightRow[]; toolId: string }>,
): Readonly<{ placeholder: string; examples: string[] }> {
  const ids: string[] = [];
  const providers = new Set<string>();
  for (const row of input.rows) {
    if (ids.length === CUSTOM_MODEL_EXAMPLE_COUNT) break;
    if (row.kind !== 'model' || isAutomaticModel(row.model.id)) continue;
    const { membership } = row.model;
    if (membership === undefined || !TOOL_OWN_MEMBERSHIPS.has(membership)) continue;
    const id = row.model.catalogModelId ?? row.model.id;
    const provider = id.includes('/') ? id.slice(0, id.indexOf('/')) : id;
    if (providers.has(provider)) continue;
    providers.add(provider);
    ids.push(id);
  }
  const [first, ...rest] = ids;
  return first === undefined
    ? { placeholder: `an id ${pickerListingSource(input.toolId).source}`, examples: [] }
    : { placeholder: `e.g. ${first}`, examples: rest };
}

function laneStatus(lane: CatalogLane, remedied: boolean): string | undefined {
  if (lane === 'pending') return CATALOG_LANE_PENDING;
  if (lane === 'failed') return withRetry(CATALOG_FETCH_FAILED, `${SOFT_SEP}ctrl+r`, remedied);
  return undefined;
}

/**
 * The byline sheds its least useful fact first so the billing word is the last segment standing:
 * capability words, then the version the tool row already prints, then the clause that qualifies
 * the source, then the provenance itself.
 */
function fitToolsByline(input: {
  toolName: string;
  version: string | undefined;
  count: string;
  provenance: string | undefined;
  trust: string | undefined;
  capabilities: readonly string[];
  billing: string | undefined;
  budget: number;
}): string {
  const compose = (kept: number, version: boolean, trust: boolean, provenance: boolean): string =>
    [
      input.toolName,
      version ? input.version : undefined,
      input.count,
      provenance ? input.provenance : undefined,
      provenance && trust ? input.trust : undefined,
      ...input.capabilities.slice(0, kept),
      input.billing,
    ]
      .filter((part): part is string => part !== undefined)
      .join(SOFT_SEP);
  const rungs: string[] = [];
  for (let kept = input.capabilities.length; kept >= 0; kept--) {
    rungs.push(compose(kept, true, true, true));
  }
  rungs.push(compose(0, false, true, true));
  rungs.push(compose(0, false, false, true));
  const floor = compose(0, false, false, false);
  return rungs.find((line) => getTerminalCellWidth(line) <= input.budget) ?? floor;
}

/** The catalog status the byline must show whichever column has focus, or undefined when there is none. */
export function bylineDiagnostic(input: {
  diagnostic: ModelCatalogDiagnostic | undefined;
  modelCount: number;
  toolName: string;
  status: PickerOptionStatus;
  budget: number;
}): string | undefined {
  const { diagnostic } = input;
  if (diagnostic === undefined) return undefined;
  // A signed-out tool's remediation is already the sign-in step: the tool's facts take the row.
  if (
    input.status.state === 'unauthenticated' &&
    diagnostic.kind === 'probe-failed' &&
    (diagnostic.failure === 'missing-credential' || diagnostic.failure === 'invalid-credential')
  ) {
    return undefined;
  }
  const remedied = input.status.remediation !== null;
  // An alias lane by design is not a failure: claude-code lists rows and still reports `unsupported`.
  if (input.modelCount > 0 && diagnostic.kind === 'unsupported') return undefined;
  // Rows are listed and detection has not run: they are the bundled list. Saying detection has not
  // run would contradict the column beside it, so name the list the user is reading instead.
  if (input.modelCount > 0 && isDetectionNotRun(diagnostic)) {
    return withRetry(BUNDLED_LIST, `${SOFT_SEP}ctrl+r detects this tool's models`, remedied);
  }
  if (diagnostic.kind !== 'probe-failed' || diagnostic.failure !== 'command-failed') {
    return formatCatalogDiagnostic(diagnostic, input.toolName, remedied);
  }
  let causeCells = getTerminalCellWidth(diagnostic.cause);
  let fitted = commandFailedCopy(input.toolName, diagnostic.cause, remedied);
  while (causeCells > 0 && wrapOnWords(fitted, input.budget, 2).cut) {
    causeCells -= 1;
    fitted = commandFailedCopy(
      input.toolName,
      truncateTerminalDisplayText(diagnostic.cause, causeCells),
      remedied,
    );
  }
  return fitted;
}

/**
 * The Tools column answers for the tool. A catalog diagnostic is the whole line: it measures more
 * than the panel is wide, so there is nothing it could be joined to.
 */
export function formatToolsByline(input: {
  toolName: string;
  version: string | undefined;
  modelCount: number;
  rowNoun: string;
  rowNounPlural: string;
  source: string | undefined;
  unverifiedForPlan: boolean;
  diagnostic: ModelCatalogDiagnostic | undefined;
  status: PickerOptionStatus;
  lane: CatalogLane;
  capabilities: readonly string[];
  billing: RunnerBillingPosture;
  budget: number;
}): string {
  const status = bylineDiagnostic({
    diagnostic: input.diagnostic,
    modelCount: input.modelCount,
    toolName: input.toolName,
    status: input.status,
    budget: input.budget,
  });
  if (status !== undefined) return status;

  const lane = laneStatus(input.lane, input.status.remediation !== null);
  const provenance = lane ?? input.source;
  // The lane status replaces the source, so a lane that is not ready carries no trust clause.
  const trust =
    lane === undefined && input.unverifiedForPlan ? 'not verified for your plan' : undefined;
  return fitToolsByline({
    toolName: input.toolName,
    version: input.version,
    count: countNoun(input.modelCount, input.rowNoun, input.rowNounPlural),
    provenance,
    trust,
    capabilities: input.capabilities,
    billing: billingWord(input.billing),
    budget: input.budget,
  });
}

/**
 * The Models column answers for the highlighted row: its label, its exact id, what it has chosen,
 * its size — and, where its listing says so, that it takes no tool calls, which a seat's agent
 * loop runs on.
 */
export function formatModelsByline(input: {
  label: string;
  id: string;
  axes: readonly string[];
  contextLength: number | undefined;
  supportsToolCalls?: boolean | undefined;
  autoRow?: { toolName: string } | undefined;
}): string {
  if (input.autoRow !== undefined) {
    return [input.label, 'no --model flag', `${input.autoRow.toolName} runs its own default`].join(
      SOFT_SEP,
    );
  }
  const parts = [input.label];
  if (input.id !== '' && input.id !== input.label) parts.push(input.id);
  parts.push(...input.axes);
  const size = formatContextLength(input.contextLength);
  if (size !== '') parts.push(size);
  if (input.supportsToolCalls === false) parts.push('no tool calls');
  return parts.join(SOFT_SEP);
}

/**
 * The ladder is the authoritative effort where a route publishes one; the id's tokens are not a
 * second one, and an axis the row has not moved from its default states nothing. The words are the
 * ones `formatSeatIdentity` states — bare, unlabelled — so the byline and the seat identity spell
 * one selection one way.
 */
export function modelBylineAxes(input: {
  model: ModelOption;
  id: string;
  effortDraft: string | null;
}): string[] {
  const variants = input.model.variants ?? [];
  const providerPrefix =
    variants.find((variant) => variant.fullId === input.id)?.providerPrefix ?? '';
  const ladder = effortLadderFor(input.model, input.id);
  const selection = parseOptionSelection(input.id);
  const words: string[] = [];
  const draft = input.effortDraft ?? '';
  if (ladder.length > 0 && ladder.includes(draft)) words.push(draft);
  for (const axis of optionAxesOf(variants, providerPrefix)) {
    if (axis.axis === 'effort') {
      if (ladder.length > 0) continue;
      if (selection.effort !== UNSET_EFFORT_WORD) words.push(selection.effort);
      continue;
    }
    if (formatAxisValue(axis.axis, selection) === 'on') words.push(axis.axis);
  }
  return words;
}

/** The note a saved route with no credential adds to the save message, in doctor's and the halt's words. */
export function formatNeedsSignInSaveFeedback(input: {
  tool: CliToolId;
  provider: string;
}): string {
  return `${routeNoCredential(input.tool, input.provider)} — run ${routeSignInCommand(input.tool, input.provider)} before start`;
}
