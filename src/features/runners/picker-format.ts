import { SOFT_SEP } from '../../components/separators.js';
import { countNoun } from '../../utils/pluralize.js';
import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import type { ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { DataUsePosture } from '../../core/providers/api-provider-catalog.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import type { PickerModelCounts } from './model-catalog/catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RunnerPermissionPosture } from './model-catalog/posture.js';
import type { PickerOptionStatus } from './model-catalog/status.js';
import type { ProviderAuthAction } from './provider-auth.js';

/** Why a native CLI catalog probe produced no confirmed models. */
export type ModelCatalogDiagnostic =
  | Readonly<{ kind: 'not-probed' }>
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

export function formatToolPostureSummary(item: PickerOption): string {
  const parts = [...formatPermissionLabels(item.permissions), formatBillingLabel(item.billing)];
  if (item.dataUse) parts.push(formatDataUseLabel(item.dataUse));
  if (item.version) parts.push(item.version);
  return parts.filter(Boolean).join(SOFT_SEP);
}

export function formatCatalogDiagnostic(
  diagnostic: ModelCatalogDiagnostic,
  toolName: string,
): string {
  if (diagnostic.kind === 'not-probed') return 'Select this tool to detect its models';
  switch (diagnostic.failure) {
    case 'unsupported':
      return `${toolName} does not support model listing`;
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
      return 'Model catalog output was malformed';
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
): { headline: string; detail: string | undefined } {
  if (item.status.state !== 'ready') {
    return {
      headline: formatPickerStatusLabel(item.status) ?? item.status.state,
      detail: item.status.remediation,
    };
  }

  const guidance = readyModelGuidance(item, counts, diagnostic);
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
): { headline: string; detail: string | undefined } {
  const { modelCapability } = item;
  if (!modelCapability.showsDiscovered && !modelCapability.allowsCustom) {
    if (modelCapability.policy === 'auto-only' || modelCapability.policy === 'backend-default') {
      return { headline: 'Model chosen by the tool', detail: undefined };
    }
    if (modelCapability.policy === 'none') {
      return { headline: 'No model selection', detail: undefined };
    }
  }

  if (counts.confirmed > 0) {
    const noun = counts.confirmed === 1 ? 'model' : 'models';
    const headlineParts = [`${counts.confirmed} ${noun} detected`];
    if (modelCapability.allowsCustom) headlineParts.push('custom models allowed');
    return { headline: headlineParts.join(SOFT_SEP), detail: undefined };
  }

  const suggested = counts.suggestions + counts.bundled;
  if (suggested > 0) {
    return {
      headline: `No models confirmed${SOFT_SEP}${suggested} suggested from catalog`,
      detail:
        diagnostic === undefined
          ? undefined
          : formatCatalogDiagnostic(diagnostic, item.displayName),
    };
  }

  return {
    headline: 'No models detected',
    detail: 'Press ctrl+r to refresh detection',
  };
}

export function formatCustomCommandPreview(
  role: 'planner' | 'implementer',
  configured?: { command: string; kind: 'shell' | 'agent' } | undefined,
): string {
  if (configured) {
    // Truth first, unbounded command last: the preview truncates right, so the
    // permission digest must never be the part that gets cut.
    const tier = configured.kind === 'shell' ? 'output' : 'direct';
    const digest =
      configured.kind === 'shell' ? 'reads stdout, never writes' : 'writes files into your tree';
    return [tier, digest, configured.command, '⏎ edit'].join(SOFT_SEP);
  }
  return [`custom ${role} command`, 'OUTPUT reads stdout', 'DIRECT writes your files'].join(
    SOFT_SEP,
  );
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

/** One glyph per provider, but the preview lists every backing source. */
export function formatProviderConfiguredClause(
  tag: string,
  facts: readonly CliProviderAuthFact[],
): string {
  const sources = facts.map((fact) =>
    fact.source === 'env' ? `env ${fact.envVar ?? ''}`.trimEnd() : fact.source,
  );
  return `${tag} signed in (${[...new Set(sources)].join(', ')})`;
}

export function formatProviderSignInClause(input: {
  tag: string;
  authKey: string;
  loginCommand: string;
  gatewayAccount?: string | undefined;
}): string {
  if (input.gatewayAccount !== undefined) {
    return `requires a ${input.gatewayAccount} account: ${input.loginCommand}`;
  }
  return `${input.tag} needs sign-in${SOFT_SEP}${input.loginCommand} ${input.authKey}`;
}

/** Absence of claim, never a false "Auth required": the oracle could not be read. */
export function formatAuthFactsUnavailableNotice(oracleCommand: string): string {
  return `auth state unknown — could not read ${oracleCommand}${SOFT_SEP}ctrl+r retry`;
}

export function formatStoredCredentialNote(count: number): string {
  return `${countNoun(count, 'credential')} stored`;
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

export function formatToolPreview(
  item: PickerOption,
  counts: PickerModelCounts,
  authAction?: ProviderAuthAction | null,
  diagnostic?: ModelCatalogDiagnostic,
  credentialNote?: string,
): string {
  if (item.kind === 'custom-command') {
    return [item.displayName, 'OUTPUT reads stdout', 'DIRECT writes your files'].join(SOFT_SEP);
  }

  const guidance = formatModelCatalogGuidance(item, counts, diagnostic);
  const parts = [item.displayName, item.kind, formatToolPostureSummary(item), guidance.headline];
  // The actionable key hint precedes the unbounded remediation: the preview
  // truncates right, so the affordance must never be the part that gets cut.
  if (authAction !== undefined && authAction !== null) {
    parts.push(formatAuthActionAffordance(authAction));
  }
  if (guidance.detail) parts.push(guidance.detail);
  // Bounded credential truth (stored-count or oracle-unavailable notice) must
  // survive ahead of the unbounded provider-name strip below.
  if (credentialNote !== undefined) parts.push(credentialNote);
  // The provider-name strip is unbounded, so it truncates before anything else.
  if (item.status.state === 'ready' && item.status.configuredProviders !== undefined) {
    parts.push(item.status.configuredProviders.join(', '));
  }
  return parts.filter(Boolean).join(SOFT_SEP);
}
