import type { ProviderDef, ProviderOverrides } from './types.js';
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
  getApiProviderDescriptor,
} from '../../core/providers/api-provider-catalog.js';
import { API_PROVIDER_VERDICT_CANDIDATE_PATHS } from '../../core/providers/api-provider-verdicts.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  normalizeProviderEndpoint,
  type EndpointPolicy,
} from '../../core/providers/endpoint-policy.js';
import { assertCandidateFilesAbsent } from '../../core/runners/candidate-admission.js';
import { providerError } from './errors.js';
import { error } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';

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

export const REGISTRY_OMIT_CANDIDATE_IDS = Object.freeze(
  API_PROVIDER_VERDICT_CANDIDATE_PATHS.map((entry) => entry.id),
);

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
