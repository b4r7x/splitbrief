import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { warnError } from '../../lib/warn.js';
import { createMetadataProvider } from './client/metadata.js';
import { stripV1Suffix } from './constants.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyFetch,
  normalizeProviderEndpoint,
} from '../../core/providers/endpoint-policy.js';
import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.ollama;

const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

const OllamaShowSchema = z.object({
  parameters: z.string().optional(),
});

type OllamaModel = { id: string };

function ollamaTagsUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/api/tags`;
}

function extractOllamaModels(data: unknown): OllamaModel[] | null {
  const result = OllamaTagsSchema.safeParse(data);
  if (!result.success) return null;
  return result.data.models.map((m) => ({ id: m.name }));
}

async function detectContextLengthFromShow(
  baseURL: string,
  model: string,
  policyFetch: EndpointPolicyFetch,
): Promise<number | null> {
  try {
    const res = await policyFetch(`${stripV1Suffix(baseURL)}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const result = OllamaShowSchema.safeParse(json);
    if (!result.success) return null;
    const params = result.data.parameters ?? '';
    const match = params.match(/num_ctx\s+(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  } catch (error) {
    warnError('detectContextLength(ollama)', error);
    return null;
  }
}

export function createOllamaProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const apiBase = normalizeProviderEndpoint(
    API_PROVIDER_CATALOG.ollama.endpointPolicy,
    overrides?.apiBase ?? DEFAULT_BASE,
  );
  const provider = createMetadataProvider<OllamaModel>(
    {
      name: 'ollama',
      defaultBaseURL: DEFAULT_BASE,
      envKeyName: 'OLLAMA_API_KEY',
      apiKeyDefault: 'ollama',
      isLocal: true,
      schema: z.object({ id: z.string() }),
      fallback: (id) => ({ id }),
      modelsUrl: ollamaTagsUrl,
      extractModels: extractOllamaModels,
    },
    { ...overrides, apiBase },
  );

  return {
    ...provider,
    detectContextLength: (model: string) =>
      detectContextLengthFromShow(provider.baseURL, model, provider[endpointPolicyFetch]),
  };
}
