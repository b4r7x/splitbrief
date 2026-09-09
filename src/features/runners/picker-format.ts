import { SOFT_SEP } from '../../components/separators.js';
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
  type RouteAuthState,
} from './model-catalog/rows.js';
import { assertNever } from '../../utils/type-guards.js';
import { formatContextLength } from '../../core/formatting.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { UNSET_EFFORT_WORD } from '../../core/runners/effort-channel.js';
import {
  formatAxisValue,
  optionAxesOf,
  parseOptionSelection,
} from './model-catalog/option-axis.js';
import type { ModelOption } from './model-catalog/recency.js';

const DETECTING_MODELS_COPY = 'Detecting models…';

/** Why a native CLI catalog probe produced no confirmed models. */
export type ModelCatalogDiagnostic =
  | Readonly<{ kind: 'not-probed' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'probe-failed'; failure: Exclude<ProbeOutcomeKind, 'success'> }>;

export function isPickerItemDisabled(item: PickerOption): boolean {
  if (item.kind === 'custom-command') return false;
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

export function formatPermissionLabels(permissions: RunnerPermissionPosture): string[] {
  const labels: string[] = [];
  if (permissions.directWrite) labels.push('direct write');
  if (permissions.network) labels.push('network');
  if (permissions.shell) labels.push('shell');
  if (permissions.automaticApproval) labels.push('auto approval');
  if (permissions.sandbox === 'cli-managed') labels.push('cli sandbox');
  else if (permissions.sandbox === 'mode-dependent') labels.push('sandbox varies');
  return labels;
}

function noListingSentence(toolName: string): string {
  return `${toolName} does not support model listing`;
}

export function formatCatalogDiagnostic(
  diagnostic: ModelCatalogDiagnostic,
  toolName: string,
): string {
  if (diagnostic.kind === 'not-probed') return 'Select this tool to detect its models';
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
    case 'offline':
      return 'Model catalog request could not reach the network';
    case 'timeout':
      return 'Model detection timed out. Press ctrl+r to retry';
    case 'malformed':
      return `${toolName} printed output SplitBrief could not read — the format changed${SOFT_SEP}ctrl+r will not help, add a custom model or report the output`;
    case 'cancelled':
      return 'Model detection was cancelled. Press ctrl+r to retry';
    case 'not-run':
      return 'Model detection has not run yet. Press ctrl+r to refresh';
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

const GATEWAY_ACCOUNT_NAMES: Record<string, string> = {
  'kilo-code': 'Kilo',
  opencode: 'OpenCode',
};

/**
 * Gateway-gated model families (a tool's own free tier) need the distinct
 * "account" vocabulary: listing them does not imply they are callable.
 */
export function gatewayAccountName(toolId: string): string | undefined {
  return GATEWAY_ACCOUNT_NAMES[toolId];
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
      return {
        word: `signed in${SOFT_SEP}${credentialSourceWord(auth)}`,
        dim: false,
      };
    case 'needs-sign-in':
      return { word: 'needs sign-in', dim: true };
    case 'unknown':
      return auth.reason === 'empty'
        ? { word: 'needs sign-in', dim: true }
        : { word: 'sign-in unknown', dim: true };
    default:
      return assertNever(auth);
  }
}

function credentialSourceWord(auth: Extract<RouteAuthState, { kind: 'configured' }>): string {
  switch (auth.source) {
    case 'oauth':
      return 'oauth';
    case 'api':
      return 'api key';
    case 'env':
      return auth.envVar === undefined ? 'env' : `$${auth.envVar}`;
    default:
      return assertNever(auth.source);
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
  provider: string;
  versions: { observed: string; required: string } | undefined;
}): string | undefined {
  const { auth } = input;
  if (auth.kind === 'configured') return undefined;
  if (auth.kind === 'unchecked') {
    return `sign-in state is not readable for ${input.toolName}${SOFT_SEP}pick the route you have set up`;
  }
  const [binary = input.oracleCommand] = input.oracleCommand.split(' ');
  const signIn = `${binary} auth login ${input.provider}`;
  if (auth.kind === 'needs-sign-in') return `sign in: ${signIn}${SOFT_SEP}then ctrl+r`;
  switch (auth.reason) {
    case 'empty':
      return `signed in to no providers yet: ${signIn}${SOFT_SEP}then ctrl+r`;
    case 'timeout':
      return `ctrl+r to re-check${SOFT_SEP}${binary} took too long listing providers`;
    case 'exit-failure':
      return `ctrl+r to re-check${SOFT_SEP}${input.oracleCommand} exited with an error`;
    case 'parse-failure':
      return `SplitBrief could not read ${binary}'s provider list (format changed) — ctrl+r will not help; report the output`;
    case 'version-mismatch': {
      const { versions } = input;
      const gap = versions === undefined ? '' : ` (${versions.observed} < ${versions.required})`;
      return `upgrade ${binary}${gap}${SOFT_SEP}sign-in state not read`;
    }
    case 'not-probed':
      return 'ctrl+r to check provider sign-in';
    default:
      return assertNever(auth.reason);
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
    source: 'from opencode models --verbose',
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
    source: 'from codex debug models --bundled',
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
};

/** A provider that is not a CLI tool lists through the shared catalog, which knows no account. */
const CATALOG_LISTING_SOURCE: ListingSource = {
  source: 'from models.dev',
  rowNoun: 'model',
  rowNounPlural: 'models',
  unverifiedForPlan: true,
};

export function pickerListingSource(toolId: string | undefined): ListingSource {
  if (toolId !== undefined && isCliToolId(toolId)) return LISTING_SOURCES[toolId];
  return CATALOG_LISTING_SOURCE;
}

function laneStatus(lane: CatalogLane): string | undefined {
  if (lane === 'pending') return CATALOG_LANE_PENDING;
  if (lane === 'failed') return `${CATALOG_FETCH_FAILED}${SOFT_SEP}ctrl+r`;
  return undefined;
}

/**
 * The byline sheds its cheapest fact first so the billing word is the last segment standing:
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
}): string | undefined {
  const { diagnostic } = input;
  if (diagnostic === undefined) return undefined;
  // An alias lane by design is not a failure: claude-code lists rows and still reports `unsupported`.
  if (input.modelCount > 0 && diagnostic.kind === 'unsupported') return undefined;
  return formatCatalogDiagnostic(diagnostic, input.toolName);
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
  lane: CatalogLane;
  capabilities: readonly string[];
  billing: RunnerBillingPosture;
  budget: number;
}): string {
  const status = bylineDiagnostic({
    diagnostic: input.diagnostic,
    modelCount: input.modelCount,
    toolName: input.toolName,
  });
  if (status !== undefined) return status;

  const lane = laneStatus(input.lane);
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

/** The Models column answers for the highlighted row: its label, its exact id, what it has chosen, its size. */
export function formatModelsByline(input: {
  label: string;
  id: string;
  axes: readonly string[];
  contextLength: number | undefined;
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
  return parts.join(SOFT_SEP);
}

/**
 * The ladder is the authoritative effort where a route publishes one; the id's tokens are not a
 * second one, and an axis the row has not moved from its default states nothing.
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
  if (ladder.length > 0 && ladder.includes(draft)) words.push(`effort ${draft}`);
  for (const axis of optionAxesOf(variants, providerPrefix)) {
    if (axis.axis === 'effort') {
      if (ladder.length > 0) continue;
      if (selection.effort !== UNSET_EFFORT_WORD) words.push(`effort ${selection.effort}`);
      continue;
    }
    if (formatAxisValue(axis.axis, selection) === 'on') words.push(axis.axis);
  }
  return words;
}

export function formatNeedsSignInSaveFeedback(input: {
  modelId: string;
  tag: string;
  authKey: string;
  loginCommand: string;
  gatewayAccount?: string | undefined;
}): string {
  if (input.gatewayAccount !== undefined) {
    return `Saved ${input.modelId}${SOFT_SEP}requires a ${input.gatewayAccount} account — run ${input.loginCommand} before start`;
  }
  return `Saved ${input.modelId}${SOFT_SEP}${input.tag} not signed in — run ${input.loginCommand} ${input.authKey} before start`;
}
