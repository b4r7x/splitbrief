import type { ProbeOutcomeKind } from '../../../core/discovery/runner-evidence.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { countNoun } from '../../../utils/pluralize.js';
import type { PickerModelCounts } from '../model-catalog/catalog.js';
import type { PickerOption } from '../model-catalog/options.js';
import type { PickerOptionStatus } from '../model-catalog/status.js';

const DETECTING_MODELS_COPY = 'Detecting models…';
// Detection has not run yet, whichever path noticed it: one state, one sentence, naming the key
// that runs it rather than asking for a selection the user has already made.
const DETECTION_NOT_RUN = 'Model detection has not run yet';
// Detection did not run and the rows beside the byline came from an earlier listing: name that list.
const EARLIER_LIST = 'Models from an earlier check';
export const DETECT_RETRY = `${SOFT_SEP}ctrl+r detects this tool's models`;

/** Why a native CLI catalog probe produced no confirmed models. */
export type ModelCatalogDiagnostic =
  | Readonly<{ kind: 'not-probed' }>
  | Readonly<{ kind: 'not-run-retained' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'probe-failed';
      failure: Exclude<ProbeOutcomeKind, 'success' | 'command-failed'>;
    }>
  | Readonly<{ kind: 'probe-failed'; failure: 'command-failed'; cause: string }>;

export function isDetectionNotRun(diagnostic: ModelCatalogDiagnostic): boolean {
  if (diagnostic.kind === 'not-probed') return true;
  return diagnostic.kind === 'probe-failed' && diagnostic.failure === 'not-run';
}

function noListingSentence(toolName: string): string {
  return `${toolName} does not support model listing`;
}

function detectionNotRunCopy(): string {
  return `${DETECTION_NOT_RUN}. Press ctrl+r to refresh`;
}

export function commandFailedCopy(toolName: string, cause: string): string {
  return `${toolName} could not list models: ${cause}${SOFT_SEP}ctrl+r to retry`;
}

export function formatCatalogDiagnostic(
  diagnostic: ModelCatalogDiagnostic,
  toolName: string,
): string {
  if (diagnostic.kind === 'not-probed') return detectionNotRunCopy();
  if (diagnostic.kind === 'not-run-retained') return `${EARLIER_LIST}${DETECT_RETRY}`;
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
      return 'Model detection could not reach the network. Press ctrl+r to retry';
    case 'timeout':
      return 'Model detection timed out. Press ctrl+r to retry';
    case 'malformed':
      return `Unreadable model list${SOFT_SEP}ctrl+r will not help; add a custom model or report the output`;
    case 'command-failed':
      return commandFailedCopy(toolName, diagnostic.cause);
    case 'cancelled':
      return 'Model detection was cancelled. Press ctrl+r to retry';
    case 'not-run':
      return detectionNotRunCopy();
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
