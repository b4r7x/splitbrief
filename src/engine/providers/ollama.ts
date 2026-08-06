import { z } from 'zod';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import {
  endpointPolicyError,
  endpointPolicyFetch,
  normalizeProviderEndpoint,
} from '../../core/providers/endpoint-policy.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { isOllamaLocalCredentialReference } from '../../core/providers/ollama-credential.js';
import { warnError } from '../../lib/warn.js';
import { DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';
import { stripV1Suffix } from './constants.js';
import { resolveApiKeyOverride } from './client/api-key.js';
import { createMetadataProvider } from './client/metadata.js';
import { isEndpointUnreachable, sanitizeProviderDiagnostic } from './client/request.js';
import { providerError } from './errors.js';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';

const DEFAULT_BASE = getKnownProviderBaseURL('ollama');

const OllamaTagSchema = z.looseObject({
  name: z.string().min(1),
  details: z
    .looseObject({
      family: z.string().min(1).optional(),
      families: z.array(z.string().min(1)).optional(),
      parameter_size: z.string().min(1).optional(),
      quantization_level: z.string().min(1).optional(),
    })
    .optional(),
});

const OllamaTagsSchema = z.object({
  models: z.array(OllamaTagSchema),
});

const OllamaModelSchema = OllamaTagSchema.extend({ id: z.string().min(1) });

const OllamaShowSchema = z.object({
  parameters: z.string().optional(),
});

type OllamaModel = z.infer<typeof OllamaModelSchema>;

function ollamaCloudEndpointPolicy() {
  const policy = API_PROVIDER_CATALOG['ollama-cloud'].endpointPolicy;
  if (policy.kind !== 'fixed-origin') throw endpointPolicyError.unsupported();
  return policy;
}

function ollamaTagsUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/api/tags`;
}

function extractOllamaModels(data: unknown): OllamaModel[] | null {
  const result = OllamaTagsSchema.safeParse(data);
  return result.success ? result.data.models.map((model) => ({ ...model, id: model.name })) : null;
}

function isRemoteBackedOllamaModel(name: string): boolean {
  return name.endsWith(':cloud') || name.endsWith('-cloud');
}

function ollamaDetailFacts(model: OllamaModel): string[] {
  const details = model.details;
  if (details === undefined) return [];
  const facts: string[] = [];
  if (details.family !== undefined) facts.push(`family:${details.family}`);
  for (const family of details.families ?? []) facts.push(`family:${family}`);
  if (details.parameter_size !== undefined) facts.push(`parameters:${details.parameter_size}`);
  if (details.quantization_level !== undefined) {
    facts.push(`quantization:${details.quantization_level}`);
  }
  return facts;
}

function ollamaModelToDetected(
  owner: 'ollama' | 'ollama-cloud',
  model: OllamaModel,
): DetectedModel {
  const remoteBacked = owner === 'ollama' && isRemoteBackedOllamaModel(model.name);
  const capabilities = [...ollamaDetailFacts(model), ...(remoteBacked ? ['remote-backed'] : [])];
  return {
    id: model.name,
    providerId: owner,
    ...(capabilities.length === 0 ? {} : { capabilities }),
  };
}

async function detectContextLengthFromShow(
  input: Readonly<{
    baseURL: string;
    model: string;
    apiKey: string;
    policyFetch: EndpointPolicyFetch;
  }>,
): Promise<number | null> {
  try {
    const response = await input.policyFetch(`${stripV1Suffix(input.baseURL)}/api/show`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey.length > 0 ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({ name: input.model }),
      signal: AbortSignal.timeout(DISCOVERY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    const result = OllamaShowSchema.safeParse(json);
    if (!result.success) return null;
    const params = result.data.parameters ?? '';
    const match = params.match(/num_ctx\s+(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  } catch (error) {
    if (isEndpointUnreachable(error)) return null;
    warnError(
      'detectContextLength(ollama)',
      sanitizeProviderDiagnostic(error, { credentialValues: [input.apiKey] }),
    );
    return null;
  }
}

export function createOllamaProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const apiBase = normalizeProviderEndpoint(
    API_PROVIDER_CATALOG.ollama.endpointPolicy,
    overrides?.apiBase ?? DEFAULT_BASE,
  );
  const localCredentialReference = overrides?.apiKey;
  if (!isOllamaLocalCredentialReference(localCredentialReference)) {
    throw providerError.ollamaLocalCredentialReference();
  }
  const localCredential = resolveApiKeyOverride(localCredentialReference) ?? '';
  const provider = createMetadataProvider<OllamaModel>(
    {
      name: 'ollama',
      defaultBaseURL: DEFAULT_BASE,
      envKeyName: 'OLLAMA_LOCAL_API_KEY',
      apiKeyDefault: 'ollama',
      isLocal: true,
      schema: OllamaModelSchema,
      fallback: (id) => ({ id, name: id }),
      modelsUrl: ollamaTagsUrl,
      extractModels: extractOllamaModels,
      toDetected: (model) => ollamaModelToDetected('ollama', model),
      authentication: 'optional',
      credentialSource: 'override-only',
      rejectRedirects: true,
    },
    { ...overrides, apiBase },
  );

  return {
    ...provider,
    detectContextLength: (model: string) =>
      detectContextLengthFromShow({
        baseURL: provider.baseURL,
        model,
        apiKey: localCredential,
        policyFetch: provider[endpointPolicyFetch],
      }),
  };
}

export function createOllamaCloudProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const endpointPolicy = ollamaCloudEndpointPolicy();
  return createMetadataProvider<OllamaModel>(
    {
      name: 'ollama-cloud',
      defaultBaseURL: endpointPolicy.baseURL,
      envKeyName: 'OLLAMA_API_KEY',
      isLocal: false,
      schema: OllamaModelSchema,
      fallback: (id) => ({ id, name: id }),
      modelsUrl: ollamaTagsUrl,
      extractModels: extractOllamaModels,
      toDetected: (model) => ollamaModelToDetected('ollama-cloud', model),
      authentication: 'required',
      endpointPolicy,
    },
    overrides,
  );
}
