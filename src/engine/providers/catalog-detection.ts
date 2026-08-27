import type {
  ProviderCatalogCredentialState,
  ProviderCatalogFailureKind,
  ProviderCatalogOutcome,
  ProviderDef,
  ProviderOverrides,
} from './types.js';
import type { DetectedModel, ProviderDetection } from '../../core/discovery/detection.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import { getProvider } from './registry.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { matches } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import { sanitizeProviderDiagnostic } from './client/request.js';

function credentialState(
  input: Readonly<{ provider: ApiProviderId; apiKey: string }>,
): ProviderCatalogCredentialState {
  if (API_PROVIDER_CATALOG[input.provider].authDiscoveryMode === 'not-required') {
    return 'not-required';
  }
  return input.apiKey.length > 0 ? 'present' : 'absent';
}

function fallbackCredentialState(provider: ApiProviderId): ProviderCatalogCredentialState {
  return API_PROVIDER_CATALOG[provider].authDiscoveryMode === 'not-required'
    ? 'not-required'
    : 'absent';
}

function fallbackDiagnostic(failure: ProviderCatalogFailureKind): string {
  switch (failure) {
    case 'endpoint-invalid':
      return 'Provider endpoint is invalid.';
    case 'missing-credential':
      return 'Provider credential is not configured.';
    case 'invalid-credential':
      return 'Provider credential is invalid.';
    case 'policy-denied':
      return 'Provider policy denied model discovery.';
    case 'privacy-filtered':
      return 'Provider privacy policy filtered model discovery.';
    case 'guardrail-filtered':
      return 'Provider guardrail filtered model discovery.';
    case 'offline':
      return 'Provider is unreachable.';
    case 'timeout':
      return 'Provider model discovery timed out.';
    case 'malformed':
      return 'Provider returned an invalid model response.';
    case 'request-failed':
      return 'Provider model discovery failed.';
  }
}

function failureKind(
  input: Readonly<{ cause: unknown; diagnostic: string }>,
): ProviderCatalogFailureKind {
  if (
    matches('provider-endpoint-invalid')(input.cause) ||
    matches('provider-endpoint-policy-unsupported')(input.cause)
  ) {
    return 'endpoint-invalid';
  }
  if (matches('provider-api-key-env-missing')(input.cause)) return 'missing-credential';
  if (
    matches('provider-credential-prefix-mismatch')(input.cause) ||
    matches('provider-invalid-api-key-env-reference')(input.cause)
  ) {
    return 'invalid-credential';
  }
  if (input.diagnostic === 'catalog-privacy-filtered') return 'privacy-filtered';
  if (input.diagnostic === 'catalog-guardrail-filtered') return 'guardrail-filtered';
  if (input.diagnostic === 'HTTP 403' || input.diagnostic === 'catalog-policy-denied') {
    return 'policy-denied';
  }
  if (input.diagnostic === 'HTTP 401' || input.diagnostic === 'catalog-authentication-rejected') {
    return 'invalid-credential';
  }
  if (input.diagnostic === 'Invalid response payload') return 'malformed';
  if (/\btimeout\b|timed out|operation was aborted due to timeout/i.test(input.diagnostic)) {
    return 'timeout';
  }
  if (
    /connection refused|network|fetch failed|econn(?:refused|reset)|enotfound/i.test(
      input.diagnostic,
    )
  ) {
    return 'offline';
  }
  return 'request-failed';
}

function sanitizedCatalogDiagnostic(
  input: Readonly<{
    cause: unknown;
    apiKey?: string | undefined;
    configOverrides?: ProviderOverrides | undefined;
  }>,
): string {
  const diagnostic = sanitizeProviderDiagnostic(input.cause, {
    credentialValues: [input.apiKey, input.configOverrides?.apiKey],
  });
  return diagnostic.length > 0 ? diagnostic : 'Provider model discovery failed.';
}

function failedCatalogOutcome(
  input: Readonly<{
    provider: ApiProviderId;
    isLocal: boolean;
    credential: ProviderCatalogCredentialState;
    cause: unknown;
    apiKey?: string | undefined;
    configOverrides?: ProviderOverrides | undefined;
  }>,
): ProviderCatalogOutcome {
  const diagnostic = sanitizedCatalogDiagnostic(input);
  const failure = failureKind({ cause: input.cause, diagnostic });
  return {
    kind: 'failed',
    source: 'provider-runtime',
    provider: input.provider,
    isLocal: input.isLocal,
    credential: input.credential,
    failure,
    diagnostic: diagnostic.length > 0 ? diagnostic : fallbackDiagnostic(failure),
  };
}

export function providerDetectionFromOutcome(outcome: ProviderCatalogOutcome): ProviderDetection {
  switch (outcome.kind) {
    case 'success':
      return {
        provider: outcome.provider,
        available: true,
        models: [...outcome.models],
        isLocal: outcome.isLocal,
        ...(!outcome.isLocal ? { hasKey: outcome.credential === 'present' } : {}),
        ...(outcome.warning === undefined ? {} : { error: outcome.warning }),
      };
    case 'failed':
      return {
        provider: outcome.provider,
        available: false,
        isLocal: outcome.isLocal,
        ...(!outcome.isLocal ? { hasKey: outcome.credential === 'present' } : {}),
        failure: outcome.failure,
        error: outcome.diagnostic,
      };
  }
}

export interface DetectProviderCatalogOptions {
  readonly provider: ApiProviderId;
  /** Applies only to this provider's current config, never to another source. */
  readonly configOverrides?: ProviderOverrides | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function detectProviderCatalog(
  options: DetectProviderCatalogOptions,
): Promise<ProviderCatalogOutcome> {
  throwIfAborted(options.signal);
  const descriptor = API_PROVIDER_CATALOG[options.provider];
  const isLocal = descriptor.locality === 'local';
  let provider: ProviderDef;
  try {
    provider = getProvider(options.provider, options.configOverrides);
  } catch (cause) {
    throwIfAborted(options.signal);
    return failedCatalogOutcome({
      provider: options.provider,
      isLocal,
      credential: fallbackCredentialState(options.provider),
      cause,
      configOverrides: options.configOverrides,
    });
  }

  let apiKey: string;
  try {
    apiKey = provider.apiKey();
  } catch (cause) {
    throwIfAborted(options.signal);
    return failedCatalogOutcome({
      provider: options.provider,
      isLocal,
      credential: fallbackCredentialState(options.provider),
      cause,
      configOverrides: options.configOverrides,
    });
  }

  const credential = credentialState({ provider: options.provider, apiKey });
  if (!provider.isLocal && credential === 'absent') {
    return {
      kind: 'failed',
      source: 'provider-runtime',
      provider: options.provider,
      isLocal,
      credential,
      failure: 'missing-credential',
      diagnostic: fallbackDiagnostic('missing-credential'),
    };
  }

  try {
    const models: DetectedModel[] = provider.listModelsWithMetadata
      ? await withTimeout(
          provider.listModelsWithMetadata({ signal: options.signal }),
          DETECTION_TIMEOUT_MS,
        )
      : (
          await withTimeout(provider.listModels({ signal: options.signal }), DETECTION_TIMEOUT_MS)
        ).map((id) => ({ id }));
    throwIfAborted(options.signal);
    const warning = provider.getLastError?.();
    if (models.length === 0 && warning !== undefined) {
      return failedCatalogOutcome({
        provider: options.provider,
        isLocal,
        credential,
        cause: warning,
        apiKey,
        configOverrides: options.configOverrides,
      });
    }
    return {
      kind: 'success',
      source: 'provider-runtime',
      provider: options.provider,
      isLocal,
      credential,
      catalog: models.length === 0 ? 'empty' : 'populated',
      models,
      ...(warning === undefined
        ? {}
        : {
            warning: sanitizedCatalogDiagnostic({
              cause: warning,
              apiKey,
              configOverrides: options.configOverrides,
            }),
          }),
    };
  } catch (cause) {
    throwIfAborted(options.signal);
    return failedCatalogOutcome({
      provider: options.provider,
      isLocal,
      credential,
      cause,
      apiKey,
      configOverrides: options.configOverrides,
    });
  }
}

export interface DetectAvailableProvidersOptions {
  readonly signal?: AbortSignal | undefined;
}

export async function detectProviderCatalogs(
  options: DetectAvailableProvidersOptions = {},
): Promise<ProviderCatalogOutcome[]> {
  throwIfAborted(options.signal);
  const outcomes = await Promise.all(
    Object.values(API_PROVIDER_CATALOG).map((descriptor) =>
      detectProviderCatalog({ provider: descriptor.id, signal: options.signal }),
    ),
  );
  throwIfAborted(options.signal);
  return outcomes;
}

export async function detectAvailableProviders(
  options: DetectAvailableProvidersOptions = {},
): Promise<ProviderDetection[]> {
  const outcomes = await detectProviderCatalogs(options);
  return outcomes.map(providerDetectionFromOutcome);
}
