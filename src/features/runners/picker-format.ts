import { SOFT_SEP } from '../../components/separators.js';
import { countNoun } from '../../utils/pluralize.js';
import type { ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { DataUsePosture } from '../../core/providers/api-provider-catalog.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import type { PickerModelCounts } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RunnerPermissionPosture } from './model-catalog/posture.js';
import type { PickerOptionStatus } from './model-catalog/status.js';
import { MODELS_DEV_FETCH_FAILED, type RouteAuthState } from './model-catalog/rows.js';
import type { ProviderAuthAction } from './provider-auth.js';
import { assertNever } from '../../utils/type-guards.js';

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

export function formatBillingLabel(billing: RunnerBillingPosture): string {
  switch (billing) {
    case 'local':
      return 'Local billing';
    case 'subscription-included':
      return 'Subscription included';
    case 'api-metered':
      return 'API metered';
    case 'provider-dependent':
      return 'Provider dependent';
    case 'unknown':
      return 'Billing unknown';
  }
}

export function formatDataUseLabel(dataUse: DataUsePosture): string {
  switch (dataUse) {
    case 'local':
      return 'Local data';
    case 'non-retention':
      return 'No retention';
    case 'no-training':
      return 'No training';
    case 'opt-out':
      return 'Training opt-out';
    case 'region-sensitive':
      return 'Region sensitive';
    case 'provider-routed':
      return 'Provider routed';
    case 'allowed-training':
      return 'Training allowed';
    case 'unreviewed':
      return 'Data use unreviewed';
  }
}

export function formatPermissionLabels(permissions: RunnerPermissionPosture): string[] {
  const labels: string[] = [];
  if (permissions.directWrite) labels.push('Direct write');
  if (permissions.network) labels.push('Network');
  if (permissions.shell) labels.push('Shell');
  if (permissions.automaticApproval) labels.push('Auto approval');
  if (permissions.sandbox === 'cli-managed') labels.push('CLI sandbox');
  else if (permissions.sandbox === 'mode-dependent') labels.push('Sandbox varies');
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

export function formatConfiguredProviderSummary(status: PickerOptionStatus): string | undefined {
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

  return zeroConfirmedGuidance({
    diagnostic,
    toolName: item.displayName,
    offersRows: counts.suggestions + counts.bundled + counts.custom > 0,
  });
}

/** No confirmed model: the real diagnostic leads, and its remedy never over-promises. */
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
    return {
      headline: noListingSentence(input.toolName),
      detail: input.offersRows ? 'aliases and models.dev ids are offered' : undefined,
    };
  }
  return {
    headline: 'No models listed',
    detail: formatCatalogDiagnostic(input.diagnostic, input.toolName),
  };
}

export function formatAuthActionAffordance(action: ProviderAuthAction): string {
  return action === 'replace-key' ? '⏎ replace key' : '⏎ add API key';
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

/** The route's own sign-in fact: a word every reader can act on, glyph optional. */
export function formatRouteAuth(input: { auth: RouteAuthState; floor: boolean }): {
  word: string | undefined;
  glyph: 'configured' | 'missing' | 'unknown' | undefined;
} {
  const { auth } = input;
  switch (auth.kind) {
    case 'unchecked':
      return { word: undefined, glyph: undefined };
    case 'configured':
      return {
        word: `signed in${SOFT_SEP}${credentialSourceWord(auth)}`,
        glyph: input.floor ? undefined : 'configured',
      };
    case 'needs-sign-in':
      return { word: 'needs sign-in', glyph: input.floor ? undefined : 'missing' };
    case 'unknown':
      return auth.reason === 'empty'
        ? { word: 'needs sign-in', glyph: input.floor ? undefined : 'missing' }
        : { word: 'state unknown', glyph: input.floor ? undefined : 'unknown' };
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

/** Counts by provenance lead; the capability strip is the part truncation may cut. */
export function formatPickerByline(input: {
  toolName: string;
  version: string | undefined;
  counts: PickerModelCounts;
  lane: 'ready' | 'pending' | 'failed';
  diagnostic?: ModelCatalogDiagnostic | undefined;
  capabilities: readonly string[];
}): string {
  const parts = [input.toolName];
  if (input.version !== undefined) parts.push(input.version);
  if (input.diagnostic?.kind === 'unsupported') parts.push('no listing command');
  if (input.counts.bundled > 0) {
    parts.push(countNoun(input.counts.bundled, 'known alias', 'known aliases'));
  }
  if (input.counts.suggestions > 0) parts.push(`${input.counts.suggestions} from models.dev`);
  if (input.counts.confirmed > 0) parts.push(`${input.counts.confirmed} detected`);
  if (input.lane === 'pending') parts.push('models.dev catalog loading');
  if (input.lane === 'failed') parts.push(`${MODELS_DEV_FETCH_FAILED}${SOFT_SEP}ctrl+r`);
  parts.push(...input.capabilities);
  return parts.join(SOFT_SEP);
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
