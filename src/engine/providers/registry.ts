import type {
  ProviderCatalogCredentialState,
  ProviderCatalogFailureKind,
  ProviderCatalogOutcome,
  ProviderDef,
  ProviderOverrides,
} from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import { apiKeyEnvReference } from './client/api-key.js';
import { validateProviderBaseURL } from './client/connection.js';
import { createOllamaCloudProvider, createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createAnthropicProvider } from './anthropic/adapter.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import {
  API_PROVIDER_CATALOG,
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  PASS_API_PROVIDER_IDS,
  getApiProviderDescriptor,
} from '../../core/providers/api-provider-catalog.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
  type EndpointPolicy,
} from '../../core/providers/endpoint-policy.js';
import { assertCandidateFilesAbsent } from '../../core/runners/candidate-admission.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { providerError } from './errors.js';
import { error, matches } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';
import { throwIfAborted } from '../../utils/abort.js';
import { sanitizeProviderDiagnostic } from './client/request.js';

type ProviderFactory = (overrides?: ProviderOverrides) => ProviderDef;

function assertVerdictCandidateAdmission(): void {
  assertCandidateFilesAbsent(
    API_PROVIDER_VERDICT_CANDIDATE_PATHS.flatMap((entry) => [entry.source, entry.test]),
    providerError.admissionOmitRequiresAbsentSource,
  );
}

const BESPOKE_PROVIDERS: Partial<Record<ApiProviderId, ProviderFactory>> = {
  anthropic: createAnthropicProvider,
  ollama: createOllamaProvider,
  'ollama-cloud': createOllamaCloudProvider,
  'lm-studio': createLmStudioProvider,
  openrouter: createOpenRouterProvider,
  groq: createGroqProvider,
  together: createTogetherProvider,
};

function buildOpenAICompatFactories(): Partial<Record<ApiProviderId, ProviderFactory>> {
  const out: Partial<Record<ApiProviderId, ProviderFactory>> = {};
  for (const info of Object.values(API_PROVIDER_CATALOG)) {
    if (BESPOKE_PROVIDERS[info.id]) continue;
    if (info.endpointPolicy.kind !== 'fixed-origin' || !info.credentialEnv) continue;
    const { id, credentialEnv } = info;
    const baseURL = info.endpointPolicy.baseURL;
    out[id] = (overrides?: ProviderOverrides) =>
      createOpenAICompatProvider({
        name: id,
        defaultBaseURL: baseURL,
        envKeyName: credentialEnv,
        overrides,
      });
  }
  return out;
}

assertVerdictCandidateAdmission();

export const REGISTRY_PASS_CANDIDATE_IDS = PASS_API_PROVIDER_IDS;

export const REGISTRY_OMIT_CANDIDATE_IDS = Object.freeze(
  API_PROVIDER_VERDICT_CANDIDATE_PATHS.map((entry) => entry.id),
);

export const REGISTRY_PASS_CANDIDATE_WIRING_COUNT = PASS_API_PROVIDER_IDS.length;

function buildKnownProviders(): Readonly<Record<string, ProviderFactory>> {
  const genericFactories = buildOpenAICompatFactories();
  const entries: [string, ProviderFactory][] = [];
  for (const descriptor of Object.values(API_PROVIDER_CATALOG)) {
    const factory = BESPOKE_PROVIDERS[descriptor.id] ?? genericFactories[descriptor.id];
    if (factory === undefined) throw endpointPolicyError.unsupported();
    entries.push([descriptor.id, factory]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export const KNOWN_PROVIDERS = buildKnownProviders();

function defaultEndpointForPolicy(policy: EndpointPolicy): string | undefined {
  switch (policy.kind) {
    case 'fixed-origin':
      return policy.baseURL;
    case 'loopback':
      return policy.defaultBaseURL;
    case 'allowed-https':
      return undefined;
  }
}

export function getProvider(name: string, overrides?: ProviderOverrides): ProviderDef {
  const descriptor = getApiProviderDescriptor(name);
  if (descriptor) {
    const factory = KNOWN_PROVIDERS[descriptor.id];
    if (!factory) throw endpointPolicyError.unsupported();
    const endpoint = overrides?.apiBase ?? defaultEndpointForPolicy(descriptor.endpointPolicy);
    if (!endpoint) throw endpointPolicyError.unsupported();
    const apiBase = normalizeProviderEndpoint(descriptor.endpointPolicy, endpoint);
    return factory({ ...overrides, apiBase });
  }
  if (!overrides?.apiBase) throw providerError.unknownNeedsApiBase(name);
  validateProviderBaseURL(overrides.apiBase);
  if (!overrides.apiKey) throw providerError.unknownNeedsApiKey(name);
  rejectUnknownProviderEnvApiKeyReference(name, overrides);
  return createOpenAICompatProvider({
    name,
    defaultBaseURL: overrides.apiBase,
    envKeyName: '',
    overrides,
  });
}

function rejectUnknownProviderEnvApiKeyReference(name: string, overrides: ProviderOverrides): void {
  const envVar = apiKeyEnvReference(overrides.apiKey);
  if (!envVar) return;

  const apiBase = redactSecrets(overrides.apiBase ?? '');
  throw error(
    'provider-custom-env-api-key-exfiltration',
    `Custom/unknown provider '${name}' cannot use env apiKey reference env:${envVar} with apiBase '${apiBase}'. ` +
      `This is an API key exfiltration risk; use an inline apiKey for this custom provider.`,
    { provider: name, apiBase, envVar },
  );
}

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
