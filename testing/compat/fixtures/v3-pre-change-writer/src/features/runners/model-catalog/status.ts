import type { CliToolDetection, ProviderDetection } from '../../../core/discovery/detection.js';
import type { ApiProviderDescriptor } from '../../../core/providers/api-provider-catalog.js';
import { hasApiKey } from '../../../core/providers/catalog.js';
import type { CliToolDescriptor } from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';

export type PickerStatusState =
  | 'ready'
  | 'unavailable'
  | 'untrusted'
  | 'unauthenticated'
  | 'incompatible'
  | 'unverified'
  | 'disabled';

export type PickerOptionStatus =
  | { state: 'ready'; remediation: null }
  | { state: Exclude<PickerStatusState, 'ready'>; remediation: string };

/**
 * `cliTools` is required: an absent snapshot degrades every CLI row to
 * `unavailable`, so a caller that stops supplying detections must say so in the
 * type rather than silently emptying the picker.
 */
export type PickerDetectionSnapshot = Readonly<{
  cliTools: readonly CliToolDetection[];
  providers: readonly ProviderDetection[];
  hasApiKeyOverride?: (provider: string) => boolean;
}>;

function resolveHasApiKey(detections: PickerDetectionSnapshot, provider: string): boolean {
  const override = detections.hasApiKeyOverride ?? hasApiKey;
  return override(provider);
}

function findCliDetection(
  detections: PickerDetectionSnapshot,
  tool: string,
): CliToolDetection | undefined {
  return detections.cliTools.find((item) => item.tool === tool);
}

function findProviderDetection(
  detections: PickerDetectionSnapshot,
  provider: string,
): ProviderDetection | undefined {
  return detections.providers.find((item) => item.provider === provider);
}

export function deriveCliStatus(
  descriptor: CliToolDescriptor,
  detections: PickerDetectionSnapshot,
): PickerOptionStatus {
  const cliDetection = findCliDetection(detections, descriptor.id);
  if (!cliDetection) {
    return {
      state: 'unavailable',
      remediation: `Install ${descriptor.displayName}, then run runner readiness.`,
    };
  }
  if (cliDetection.diagnostic.state === 'ready') {
    return { state: 'ready', remediation: null };
  }
  return {
    state: cliDetection.diagnostic.state,
    remediation: cliDetection.diagnostic.remediation,
  };
}

export function resolveCliVersion(
  tool: string,
  detections: PickerDetectionSnapshot,
): string | undefined {
  return findCliDetection(detections, tool)?.installedVersion ?? undefined;
}

/**
 * A catalog qualification is an admission verdict, so it outranks a live
 * availability probe: a reachable endpoint and a present credential never
 * upgrade a provider that conformance left unverified or incompatible.
 */
function compatibilityStatus(descriptor: ApiProviderDescriptor): PickerOptionStatus | null {
  switch (descriptor.compatibility) {
    case 'verified':
      return null;
    case 'incompatible':
      return {
        state: 'incompatible',
        remediation: `${descriptor.service} failed provider conformance as of ${descriptor.asOf}. Select a verified provider.`,
      };
    default:
      return {
        state: 'unverified',
        remediation: `${descriptor.service} has no passing provider conformance evidence as of ${descriptor.asOf}. Select a verified provider, or re-run \`scripts/provider-conformance.ts\` with a credential to qualify it.`,
      };
  }
}

export function deriveApiStatus(
  descriptor: ApiProviderDescriptor,
  detections: PickerDetectionSnapshot,
): PickerOptionStatus {
  const qualification = compatibilityStatus(descriptor);
  if (qualification) return qualification;

  const providerDetection = findProviderDetection(detections, descriptor.id);
  if (providerDetection?.available) {
    return { state: 'ready', remediation: null };
  }

  if (descriptor.offering === 'local') {
    return {
      state: 'unavailable',
      remediation: providerDetection?.error ?? `Start ${descriptor.service} and refresh detection.`,
    };
  }

  const keyPresent = providerDetection?.hasKey ?? resolveHasApiKey(detections, descriptor.id);
  if (!keyPresent) {
    const env = descriptor.credentialEnv;
    return {
      state: 'unauthenticated',
      remediation: env
        ? `Set ${env} or configure an inline apiKey, then refresh detection.`
        : 'Configure credentials and refresh detection.',
    };
  }

  return {
    state: 'unavailable',
    remediation: providerDetection?.error ?? `${descriptor.service} is not currently reachable.`,
  };
}

export function deriveMetaStatus(
  kind: 'shell' | 'agent' | 'agent-sdk',
  detections: PickerDetectionSnapshot,
): PickerOptionStatus {
  if (kind === 'shell' || kind === 'agent') {
    return { state: 'ready', remediation: null };
  }
  if (resolveHasApiKey(detections, 'agent-sdk')) {
    return { state: 'ready', remediation: null };
  }
  return {
    state: 'unauthenticated',
    remediation: 'Set ANTHROPIC_API_KEY or configure an inline apiKey for Agent SDK.',
  };
}

export function isSelectable(status: PickerOptionStatus, kind: RunnerKind): boolean {
  if (kind === 'shell' || kind === 'agent') return true;
  return status.state === 'ready';
}
