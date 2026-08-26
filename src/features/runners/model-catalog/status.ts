import {
  cliProviderAuthFacts,
  type CliToolDetection,
  type ProviderDetection,
} from '../../../core/discovery/detection.js';
import type { CliReadinessState } from '../../../core/discovery/detection.js';
import type { ApiProviderDescriptor } from '../../../core/providers/api-provider-catalog.js';
import { hasApiKey } from '../../../core/providers/catalog.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type CliToolDescriptor,
  type SeatPickerRole,
} from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';

export type PickerStatusState = CliReadinessState;

export type PickerOptionStatus =
  | {
      state: 'ready';
      remediation: null;
      /**
       * Deduplicated provider names from the tool's own credential listing.
       * Present only when a provider oracle ran; absent for presence-derived
       * readiness.
       */
      configuredProviders?: readonly string[] | undefined;
    }
  | { state: Exclude<PickerStatusState, 'ready'>; remediation: string };

/**
 * `cliTools` is required: an absent snapshot degrades every CLI row to
 * `unavailable`, so a caller that stops supplying detections must say so in the
 * type rather than silently emptying the picker.
 */
export type PickerDetectionSnapshot = Readonly<{
  cliTools: readonly CliToolDetection[];
  providers: readonly ProviderDetection[];
  /** Memory-only role/provider outcomes for the active configured connections. */
  providerOutcomes?: readonly ConfiguredProviderRuntime[] | undefined;
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

/**
 * Scoped outcomes are authoritative only for the seat that produced them. A
 * seat with none of its own was never probed, so it resolves through ambient
 * provider detection instead of borrowing another seat's credential verdict.
 */
function findConfiguredProviderRuntime(
  detections: PickerDetectionSnapshot,
  input: Readonly<{ role: ActiveRunnerRole; provider: string }>,
): ConfiguredProviderRuntime | null | undefined {
  const scoped = (detections.providerOutcomes ?? []).filter(
    (entry) => entry.connection.role === input.role,
  );
  if (scoped.length === 0) return undefined;
  return scoped.find((entry) => entry.connection.provider === input.provider) ?? null;
}

const PROVIDER_SIGN_IN_REMEDIATION =
  'Sign in or configure a provider - free models require sign-in.';

/**
 * A provider-dependent CLI's own credential listing outranks presence-derived
 * auth, but only on the auth axis: trust, compatibility, and availability
 * blockers stand. Absent facts (legacy cache, oracle fallback) resolve nothing
 * so the presence-derived diagnostic keeps governing.
 */
function providerFactStatus(
  descriptor: CliToolDescriptor,
  detection: CliToolDetection,
): PickerOptionStatus | undefined {
  if (descriptor.auth.kind !== 'provider-dependent') return undefined;
  const facts = cliProviderAuthFacts(detection.providerAuth);
  if (facts === undefined) return undefined;
  if (detection.diagnostic.state !== 'ready' && detection.diagnostic.state !== 'unauthenticated') {
    return undefined;
  }
  const providers = [...new Set(facts.map((fact) => fact.provider))];
  if (providers.length === 0) {
    return { state: 'unauthenticated', remediation: PROVIDER_SIGN_IN_REMEDIATION };
  }
  return { state: 'ready', remediation: null, configuredProviders: providers };
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
  const factStatus = providerFactStatus(descriptor, cliDetection);
  if (factStatus !== undefined) return factStatus;
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
  role?: SeatPickerRole,
): PickerOptionStatus {
  const qualification = compatibilityStatus(descriptor);
  if (qualification) return qualification;

  const configured =
    role === undefined
      ? undefined
      : findConfiguredProviderRuntime(detections, {
          role: seatPickerLane(role),
          provider: descriptor.id,
        });
  if (configured !== undefined && configured !== null) {
    return configuredProviderStatus({
      descriptor,
      runtime: configured,
      fallbackCredential: () => resolveHasApiKey(detections, descriptor.id),
    });
  }

  const providerDetection =
    configured === null ? undefined : findProviderDetection(detections, descriptor.id);
  if (providerDetection?.available) {
    return { state: 'ready', remediation: null };
  }

  if (descriptor.offering === 'local') {
    return {
      state: 'unavailable',
      remediation: providerDetection?.error ?? `Start ${descriptor.service} and refresh detection.`,
    };
  }

  // A rejected credential is an auth problem, not reachability: the picker must
  // say "replace the key", while offline/timeout stay unavailable below.
  if (providerDetection?.failure === 'invalid-credential') {
    return {
      state: 'unauthenticated',
      remediation: descriptor.credentialEnv
        ? `Key found in ${descriptor.credentialEnv} but ${descriptor.service} rejected it.`
        : `${descriptor.service} rejected the configured key.`,
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

function credentialRemediation(descriptor: Pick<ApiProviderDescriptor, 'credentialEnv'>): string {
  return descriptor.credentialEnv
    ? `Set ${descriptor.credentialEnv} or configure an inline apiKey, then refresh detection.`
    : 'Configure credentials and refresh detection.';
}

function configuredProviderStatus(
  input: Readonly<{
    descriptor: Pick<ApiProviderDescriptor, 'service' | 'credentialEnv'>;
    runtime: ConfiguredProviderRuntime;
    fallbackCredential: () => boolean;
  }>,
): PickerOptionStatus {
  const { descriptor, runtime } = input;
  if (runtime.state === 'fresh') return { state: 'ready', remediation: null };
  if (runtime.state === 'stale') {
    return {
      state: 'unavailable',
      remediation: `Last confirmed ${descriptor.service} catalog is stale. Refresh detection.`,
    };
  }

  switch (runtime.failure) {
    case 'missing-credential':
    case 'invalid-credential':
      return { state: 'unauthenticated', remediation: credentialRemediation(descriptor) };
    case 'privacy-filtered':
      return {
        state: 'unavailable',
        remediation: `${descriptor.service} privacy policy filtered catalog access. Review privacy settings and refresh detection.`,
      };
    case 'guardrail-filtered':
      return {
        state: 'unavailable',
        remediation: `${descriptor.service} guardrails filtered catalog access. Review provider policy and refresh detection.`,
      };
    case 'endpoint-invalid':
      return {
        state: 'unavailable',
        remediation: `Configure a valid ${descriptor.service} endpoint, then refresh detection.`,
      };
    case 'policy-denied':
      return {
        state: 'unavailable',
        remediation: `${descriptor.service} policy denied catalog access. Review provider policy and refresh detection.`,
      };
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'request-failed':
    case undefined:
      if (!input.fallbackCredential()) {
        return { state: 'unauthenticated', remediation: credentialRemediation(descriptor) };
      }
      return {
        state: 'unavailable',
        remediation: runtime.diagnostic ?? `${descriptor.service} is not currently reachable.`,
      };
  }
}

export function deriveMetaStatus(
  input: Readonly<{
    kind: 'custom-command' | 'agent-sdk';
    detections: PickerDetectionSnapshot;
    role?: SeatPickerRole | undefined;
    useConfiguredProviderOutcome: boolean;
  }>,
): PickerOptionStatus {
  const { kind, detections, role } = input;
  if (kind === 'custom-command') {
    return { state: 'ready', remediation: null };
  }
  const configured =
    !input.useConfiguredProviderOutcome || role === undefined
      ? undefined
      : findConfiguredProviderRuntime(detections, {
          role: seatPickerLane(role),
          provider: 'anthropic',
        });
  if (configured !== undefined && configured !== null) {
    return configuredProviderStatus({
      descriptor: { service: 'Agent SDK', credentialEnv: 'ANTHROPIC_API_KEY' },
      runtime: configured,
      fallbackCredential: () => resolveHasApiKey(detections, 'agent-sdk'),
    });
  }
  if (resolveHasApiKey(detections, 'agent-sdk')) return { state: 'ready', remediation: null };
  return {
    state: 'unauthenticated',
    remediation: 'Set ANTHROPIC_API_KEY or configure an inline apiKey for Agent SDK.',
  };
}

export function isSelectable(
  status: PickerOptionStatus,
  kind: RunnerKind | 'custom-command',
): boolean {
  if (kind === 'custom-command') return true;
  return status.state === 'ready';
}
