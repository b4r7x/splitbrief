import { z } from 'zod';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import type { DetectedModel, DetectedModelInstance } from '../../core/discovery/detection.js';
import {
  endpointPolicyFetch,
  normalizeProviderEndpoint,
} from '../../core/providers/endpoint-policy.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { isOllamaLocalCredentialReference } from '../../core/providers/ollama-credential.js';
import { warnError } from '../../lib/warn.js';
import { composeAbortSignal, throwIfAborted } from '../../utils/abort.js';
import { DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';
import { stripV1Suffix } from './constants.js';
import { resolveApiKeyOverride } from './client/api-key.js';
import { createMetadataProvider } from './client/metadata.js';
import { isEndpointUnreachable, sanitizeProviderDiagnostic } from './client/request.js';
import { providerError } from './errors.js';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from './types.js';
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
  model_info: z.record(z.string(), z.unknown()).optional(),
});

const OllamaPsEntrySchema = z
  .looseObject({
    name: z.string().regex(/\S/).optional(),
    model: z.string().regex(/\S/).optional(),
    context_length: z.number().int().positive().optional(),
  })
  .refine((entry) => entry.name !== undefined || entry.model !== undefined);

const OllamaPsSchema = z.object({
  models: z.array(OllamaPsEntrySchema),
});

type OllamaModel = z.infer<typeof OllamaModelSchema>;
type OllamaPsEntry = z.infer<typeof OllamaPsEntrySchema>;

/** `/api/ps` is optional: an unavailable or malformed answer leaves loading unknown. */
type OllamaLoadObservation =
  | Readonly<{ kind: 'observed'; entries: readonly OllamaPsEntry[] }>
  | Readonly<{ kind: 'unknown' }>;

function ollamaTagsUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/api/tags`;
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : {};
}

function extractOllamaModels(data: unknown): OllamaModel[] | null {
  const result = OllamaTagsSchema.safeParse(data);
  return result.success ? result.data.models.map((model) => ({ ...model, id: model.name })) : null;
}

export function isRemoteBackedOllamaModel(name: string): boolean {
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

function ollamaModelToDetected(model: OllamaModel): DetectedModel {
  const remoteBacked = isRemoteBackedOllamaModel(model.name);
  const capabilities = [...ollamaDetailFacts(model), ...(remoteBacked ? ['remote-backed'] : [])];
  return {
    id: model.name,
    providerId: 'ollama',
    ...(capabilities.length === 0 ? {} : { capabilities }),
  };
}

/**
 * Reads `/api/ps` once per listing. The request is read-only: it observes what
 * the daemon already loaded and never asks it to load, unload or generate.
 */
async function observeLoadedOllamaModels(
  input: Readonly<{
    baseURL: string;
    apiKey: string;
    policyFetch: EndpointPolicyFetch;
    signal: AbortSignal | undefined;
  }>,
): Promise<OllamaLoadObservation> {
  throwIfAborted(input.signal);
  const signal = composeAbortSignal(input.signal, DISCOVERY_HTTP_TIMEOUT_MS);
  try {
    const response = await input.policyFetch(`${stripV1Suffix(input.baseURL)}/api/ps`, {
      headers: bearerHeaders(input.apiKey),
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(input.signal);
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'unknown' };
    }
    const result = OllamaPsSchema.safeParse(await response.json());
    return result.success ? { kind: 'observed', entries: result.data.models } : { kind: 'unknown' };
  } catch (error) {
    throwIfAborted(input.signal);
    if (!isEndpointUnreachable(error)) {
      warnError(
        'Could not read the loaded models from Ollama',
        sanitizeProviderDiagnostic(error, { credentialValues: [input.apiKey] }),
      );
    }
    return { kind: 'unknown' };
  }
}

function psInstancesFor(
  observation: Extract<OllamaLoadObservation, { kind: 'observed' }>,
  id: string,
): DetectedModelInstance[] {
  return observation.entries
    .filter((entry) => entry.model === id || entry.name === id)
    .map((entry) => ({
      id: entry.model ?? entry.name ?? id,
      ...(entry.context_length === undefined
        ? {}
        : { effectiveContextTokens: entry.context_length }),
    }));
}

/**
 * The tag inventory stays authoritative; `/api/ps` only adds load state and the
 * context the loaded instance actually runs with.
 */
function withLoadState(
  model: DetectedModel,
  observation: OllamaLoadObservation,
  observedAt: number,
): DetectedModel {
  if (observation.kind === 'unknown') {
    return { ...model, runtime: { loadState: 'unknown', observedAt } };
  }
  const instances = psInstancesFor(observation, model.id);
  if (instances.length === 0) {
    return { ...model, runtime: { loadState: 'not-loaded', observedAt } };
  }
  const contexts = instances
    .map((instance) => instance.effectiveContextTokens)
    .filter((tokens): tokens is number => tokens !== undefined);
  return {
    ...model,
    ...(contexts.length === 0 ? {} : { effectiveContextTokens: Math.min(...contexts) }),
    runtime: { loadState: 'loaded', observedAt, instances },
  };
}

/** The architectural ceiling the model was built with — never an active capacity. */
function showMaximumContextTokens(modelInfo: Record<string, unknown> | undefined): number | null {
  if (modelInfo === undefined) return null;
  const architecture = modelInfo['general.architecture'];
  if (typeof architecture !== 'string' || architecture.length === 0) return null;
  const context = modelInfo[`${architecture}.context_length`];
  return typeof context === 'number' && Number.isInteger(context) && context > 0 ? context : null;
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
      headers: { 'Content-Type': 'application/json', ...bearerHeaders(input.apiKey) },
      body: JSON.stringify({ name: input.model }),
      signal: AbortSignal.timeout(DISCOVERY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    const result = OllamaShowSchema.safeParse(json);
    if (!result.success) return null;
    const maximum = showMaximumContextTokens(result.data.model_info);
    if (maximum !== null) return maximum;
    const params = result.data.parameters ?? '';
    const match = params.match(/num_ctx\s+(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  } catch (error) {
    if (isEndpointUnreachable(error)) return null;
    warnError(
      `Could not read the context length of ${input.model} from Ollama`,
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
      toDetected: ollamaModelToDetected,
      authentication: 'optional',
      credentialSource: 'override-only',
      rejectRedirects: true,
    },
    { ...overrides, apiBase },
  );

  return {
    ...provider,
    async listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]> {
      const models = await provider.listModelsWithMetadata(options);
      if (models.length === 0) return models;
      const observation = await observeLoadedOllamaModels({
        baseURL: provider.baseURL,
        apiKey: localCredential,
        policyFetch: provider[endpointPolicyFetch],
        signal: options?.signal,
      });
      const observedAt = Date.now();
      return models.map((model) => withLoadState(model, observation, observedAt));
    },
    detectContextLength: (model: string) =>
      detectContextLengthFromShow({
        baseURL: provider.baseURL,
        model,
        apiKey: localCredential,
        policyFetch: provider[endpointPolicyFetch],
      }),
  };
}
