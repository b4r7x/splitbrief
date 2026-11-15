import type { ProviderDetection } from '../../../core/discovery/detection/tool.js';
import type { ApiProviderDescriptor } from '../../../core/providers/api-catalog.js';
import { hasApiKey } from '../../../core/providers/catalog.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type SeatPickerRole,
} from '../../../core/runners/seat-roles.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';
import type { PickerDetectionSnapshot, PickerOptionStatus } from './status.js';

function resolveHasApiKey(detections: PickerDetectionSnapshot, provider: string): boolean {
  const override = detections.hasApiKeyOverride ?? hasApiKey;
  return override(provider);
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

/**
 * A catalog qualification is an admission verdict, so it outranks a live
 * availability probe: a reachable endpoint and a present credential never
 * admit a provider whose qualification is not `verified`.
 *
 * An admitted local `beta` profile is the one qualification that does not gate:
 * it runs on the shared transport against a server the operator owns, so it
 * reaches its own connection and catalog facts. The descriptor still reads
 * `beta` — nothing here rewrites a qualification to verified, and a remote or
 * `unknown` beta stays gated.
 */
function compatibilityStatus(descriptor: ApiProviderDescriptor): PickerOptionStatus | null {
  if (descriptor.compatibility === 'verified') return null;
  if (descriptor.compatibility === 'beta' && descriptor.locality === 'local') return null;
  return {
    state: 'incompatible',
    remediation: `${descriptor.service} is not compatible with SPLITBRIEF. Select a supported provider.`,
  };
}

/**
 * A loopback server publishes no content policy of its own, so its 403 is the
 * key the operator configured on it being refused, exactly as its 401 is.
 * Remote providers keep policy denials on the availability axis.
 */
function isCredentialRejection(
  descriptor: Pick<ApiProviderDescriptor, 'locality'>,
  failure: ProviderDetection['failure'],
): boolean {
  if (failure === 'invalid-credential') return true;
  return failure === 'policy-denied' && descriptor.locality === 'local';
}

function rejectedCredentialRemediation(
  descriptor: Pick<ApiProviderDescriptor, 'service' | 'credentialEnv'>,
): string {
  return descriptor.credentialEnv
    ? `Key found in ${descriptor.credentialEnv} but ${descriptor.service} rejected it.`
    : `${descriptor.service} rejected the configured key.`;
}

/**
 * Only a provider that demands a key can be unauthenticated for lacking one.
 * On a no-auth or optional-key server an offline, timed-out, malformed or
 * failed request is a server problem, and inventing a credential would not
 * repair it.
 */
function requiresCredential(descriptor: Pick<ApiProviderDescriptor, 'authDiscoveryMode'>): boolean {
  return descriptor.authDiscoveryMode === 'api-key-unverified';
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

  // A rejected credential is an auth problem, not reachability: the picker must
  // say "replace the key". This outranks the local fallback below, which would
  // otherwise tell an operator whose running server refused the key to start it.
  if (isCredentialRejection(descriptor, providerDetection?.failure)) {
    return {
      state: 'unauthenticated',
      remediation: rejectedCredentialRemediation(descriptor),
    };
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

function credentialRemediation(descriptor: Pick<ApiProviderDescriptor, 'credentialEnv'>): string {
  return descriptor.credentialEnv
    ? `Set ${descriptor.credentialEnv} or configure an inline apiKey, then refresh detection.`
    : 'Configure credentials and refresh detection.';
}

function configuredProviderStatus(
  input: Readonly<{
    descriptor: Pick<
      ApiProviderDescriptor,
      'service' | 'credentialEnv' | 'locality' | 'authDiscoveryMode'
    >;
    runtime: ConfiguredProviderRuntime;
    fallbackCredential: () => boolean;
  }>,
): PickerOptionStatus {
  const { descriptor, runtime } = input;
  if (runtime.state === 'fresh') {
    // A server that answered with nothing installed is reachable, and the
    // parent reads that from the connection facts. It still holds no model to
    // select, so the picker must not offer the row as ready.
    if (runtime.catalog === 'empty') {
      return {
        state: 'unavailable',
        remediation: `${descriptor.service} is reachable but lists no models. Install or load one, then refresh detection.`,
      };
    }
    return { state: 'ready', remediation: null };
  }
  if (runtime.state === 'stale') {
    return {
      state: 'unavailable',
      remediation: `Last confirmed ${descriptor.service} catalog is stale. Refresh detection.`,
    };
  }

  switch (runtime.failure) {
    case 'missing-credential':
      return { state: 'unauthenticated', remediation: credentialRemediation(descriptor) };
    case 'invalid-credential':
      return { state: 'unauthenticated', remediation: rejectedCredentialRemediation(descriptor) };
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
      if (isCredentialRejection(descriptor, 'policy-denied')) {
        return {
          state: 'unauthenticated',
          remediation: rejectedCredentialRemediation(descriptor),
        };
      }
      return {
        state: 'unavailable',
        remediation: `${descriptor.service} policy denied catalog access. Review provider policy and refresh detection.`,
      };
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'request-failed':
    case undefined:
      if (requiresCredential(descriptor) && !input.fallbackCredential()) {
        return { state: 'unauthenticated', remediation: credentialRemediation(descriptor) };
      }
      return {
        state: 'unavailable',
        remediation: runtime.diagnostic ?? `${descriptor.service} is not currently reachable.`,
      };
  }
}
