import type { ProviderDef, ProviderOverrides } from './types.js';
import { apiKeyEnvReference } from './client/api-key.js';
import { validateProviderBaseURL } from './client/connection.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
  type EndpointPolicy,
} from '../../core/providers/endpoint-policy.js';
import { providerError } from './errors.js';
import { error } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';

type ProviderFactory = (overrides?: ProviderOverrides) => ProviderDef;

export const KNOWN_PROVIDERS: Readonly<Record<ApiProviderId, ProviderFactory>> = Object.freeze({
  ollama: createOllamaProvider,
  'lm-studio': createLmStudioProvider,
});

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
    const endpoint = overrides?.apiBase ?? defaultEndpointForPolicy(descriptor.endpointPolicy);
    if (!endpoint) throw endpointPolicyError.unsupported();
    const apiBase = normalizeProviderEndpoint(descriptor.endpointPolicy, endpoint);
    return KNOWN_PROVIDERS[descriptor.id]({ ...overrides, apiBase });
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
