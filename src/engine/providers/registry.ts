import type { ProviderDef, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import { apiKeyEnvReference } from './client/api-key.js';
import { validateProviderBaseURL } from './client/connection.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createAnthropicProvider } from './anthropic/adapter.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
  type EndpointPolicy,
} from '../../core/providers/endpoint-policy.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { providerError } from './errors.js';
import { error } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';
import { sanitizeProviderDiagnostic } from './client/request.js';
type ProviderFactory = (overrides?: ProviderOverrides) => ProviderDef;

const BESPOKE_PROVIDERS: Partial<Record<ApiProviderId, ProviderFactory>> = {
  anthropic: createAnthropicProvider,
  ollama: createOllamaProvider,
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

export const KNOWN_PROVIDERS: Partial<Record<ApiProviderId, ProviderFactory>> = {
  ...BESPOKE_PROVIDERS,
  ...buildOpenAICompatFactories(),
};

function getApiDescriptor(name: string) {
  return Object.values(API_PROVIDER_CATALOG).find((descriptor) => descriptor.id === name);
}

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
  const descriptor = getApiDescriptor(name);
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

async function detectOne(
  name: ApiProviderId,
  factory: ProviderFactory,
): Promise<ProviderDetection> {
  const provider = factory();
  const apiKey = provider.apiKey();
  if (!provider.isLocal && apiKey.length === 0) {
    return { provider: name, available: false, isLocal: false, hasKey: false };
  }
  try {
    let models: DetectedModel[];
    if (provider.listModelsWithMetadata) {
      models = await withTimeout(provider.listModelsWithMetadata(), DETECTION_TIMEOUT_MS);
    } else {
      const ids = await withTimeout(provider.listModels(), DETECTION_TIMEOUT_MS);
      models = ids.map((id) => ({ id }));
    }
    const lastError = provider.getLastError?.();
    return {
      provider: name,
      available: models.length > 0,
      isLocal: provider.isLocal,
      ...(models.length > 0 ? { models } : {}),
      ...(!provider.isLocal ? { hasKey: apiKey.length > 0 } : {}),
      ...(lastError
        ? {
            error: sanitizeProviderDiagnostic(lastError, {
              credentialValues: apiKey ? [apiKey] : undefined,
            }),
          }
        : {}),
    };
  } catch (error) {
    return {
      provider: name,
      available: false,
      isLocal: provider.isLocal,
      ...(!provider.isLocal ? { hasKey: apiKey.length > 0 } : {}),
      error: sanitizeProviderDiagnostic(error, {
        credentialValues: apiKey ? [apiKey] : undefined,
      }),
    };
  }
}

export async function detectAvailableProviders(): Promise<ProviderDetection[]> {
  const results: Promise<ProviderDetection>[] = [];
  for (const descriptor of Object.values(API_PROVIDER_CATALOG)) {
    const factory = KNOWN_PROVIDERS[descriptor.id];
    if (!factory) continue;
    results.push(detectOne(descriptor.id, factory));
  }
  return Promise.all(results);
}
