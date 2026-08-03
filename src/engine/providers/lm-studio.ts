import { z } from 'zod';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { endpointPolicyFetch } from '../../core/providers/endpoint-policy.js';
import { throwIfAborted } from '../../utils/abort.js';
import { assertNever } from '../../utils/type-guards.js';
import { DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';
import { stripV1Suffix } from './constants.js';
import { createMetadataProvider } from './client/metadata.js';
import { sanitizeProviderDiagnostic } from './client/request.js';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from './types.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';

const NATIVE_UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

const LmStudioReasoningOptionSchema = z.enum(['off', 'on', 'low', 'medium', 'high']);

const LmStudioCapabilitiesSchema = z.looseObject({
  vision: z.boolean().optional(),
  trained_for_tool_use: z.boolean().optional(),
  reasoning: z
    .looseObject({
      allowed_options: z.array(LmStudioReasoningOptionSchema).optional(),
      default: LmStudioReasoningOptionSchema.optional(),
    })
    .optional(),
});

const LmStudioLoadedInstanceSchema = z.looseObject({
  context_length: z.number().int().positive().optional(),
  contextLength: z.number().int().positive().optional(),
  config: z
    .looseObject({
      context_length: z.number().int().positive().optional(),
      contextLength: z.number().int().positive().optional(),
    })
    .optional(),
});

const LmStudioNativeModelSchema = z.looseObject({
  key: z.string().min(1),
  type: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_length: z.number().int().positive().optional(),
  capabilities: LmStudioCapabilitiesSchema.optional(),
  loaded_instances: z.array(LmStudioLoadedInstanceSchema).optional(),
});

const LmStudioNativeModelsSchema = z.object({
  models: z.array(LmStudioNativeModelSchema),
});

const LmStudioCompatibilitySchema = z.object({
  data: z.array(z.looseObject({ id: z.string().min(1) })),
});

type LmStudioNativeModel = z.infer<typeof LmStudioNativeModelSchema>;

type LmStudioListResult<T> =
  | Readonly<{ kind: 'success'; models: readonly T[] }>
  | Readonly<{ kind: 'http'; status: number }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'failed'; diagnostic: string }>;

function nativeModelsFromPayload(data: unknown): readonly LmStudioNativeModel[] | null {
  const fromModels = LmStudioNativeModelsSchema.safeParse(data);
  return fromModels.success ? fromModels.data.models : null;
}

function compatibilityModelsFromPayload(data: unknown): readonly DetectedModel[] | null {
  const result = LmStudioCompatibilitySchema.safeParse(data);
  if (!result.success) return null;
  return result.data.data.map((model) => ({ id: model.id, providerId: 'lm-studio' }));
}

function effectiveContext(instance: z.infer<typeof LmStudioLoadedInstanceSchema>): number | null {
  return (
    instance.context_length ??
    instance.contextLength ??
    instance.config?.context_length ??
    instance.config?.contextLength ??
    null
  );
}

function nativeCapabilityFacts(model: LmStudioNativeModel): string[] {
  const facts = [`type:${model.type}`];
  const capabilities = model.capabilities;
  if (capabilities?.vision === true) facts.push('vision', 'vision:true');
  if (capabilities?.vision === false) facts.push('vision:false');
  if (capabilities?.trained_for_tool_use === true) {
    facts.push('trained_for_tool_use', 'trained_for_tool_use:true');
  }
  if (capabilities?.trained_for_tool_use === false) facts.push('trained_for_tool_use:false');
  if (capabilities?.reasoning?.default !== undefined) {
    facts.push(`reasoning:default:${capabilities.reasoning.default}`);
  }
  const loadedInstances = model.loaded_instances ?? [];
  facts.push(loadedInstances.length > 0 ? 'loaded' : 'not-loaded');
  return facts;
}

function nativeModelToDetected(model: LmStudioNativeModel): DetectedModel {
  const loadedContexts = (model.loaded_instances ?? [])
    .map(effectiveContext)
    .filter((context): context is number => context !== null);
  const effectiveContextTokens =
    loadedContexts.length > 0 ? Math.min(...loadedContexts) : undefined;
  const maximumContextTokens = model.max_context_length;
  const contextLength = effectiveContextTokens ?? maximumContextTokens;
  const capabilities = model.capabilities ?? {};
  const reasoningOptions = capabilities.reasoning?.allowed_options;

  return {
    id: model.key,
    providerId: 'lm-studio',
    ...(model.display_name === undefined ? {} : { displayName: model.display_name }),
    ...(maximumContextTokens === undefined ? {} : { maximumContextTokens }),
    ...(effectiveContextTokens === undefined ? {} : { effectiveContextTokens }),
    ...(contextLength === undefined ? {} : { contextLength }),
    capabilities: nativeCapabilityFacts(model),
    ...(capabilities.trained_for_tool_use === undefined
      ? {}
      : { supportsToolCalls: capabilities.trained_for_tool_use }),
    ...(capabilities.vision === undefined ? {} : { supportsImages: capabilities.vision }),
    ...(reasoningOptions === undefined
      ? {}
      : {
          supportsReasoning: reasoningOptions.length > 0,
          nativeReasoningEfforts: reasoningOptions,
        }),
  };
}

function nativeInventoryUrl(baseURL: string): string {
  return `${stripV1Suffix(baseURL)}/api/v1/models`;
}

function compatibilityInventoryUrl(baseURL: string): string {
  return `${baseURL}/models`;
}

function requestHeaders(apiKey: string): Record<string, string> | undefined {
  return apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function resultDiagnostic<T>(result: LmStudioListResult<T>): string | undefined {
  switch (result.kind) {
    case 'success':
      return undefined;
    case 'http':
      return `HTTP ${result.status}`;
    case 'invalid':
      return 'Invalid response payload';
    case 'failed':
      return result.diagnostic;
    default:
      return assertNever(result);
  }
}

async function fetchInventory<T>(
  input: Readonly<{
    endpoint: string;
    policyFetch: EndpointPolicyFetch;
    apiKey: string;
    signal: AbortSignal | undefined;
    extract: (data: unknown) => readonly T[] | null;
  }>,
): Promise<LmStudioListResult<T>> {
  throwIfAborted(input.signal);
  const timeout = AbortSignal.timeout(DISCOVERY_HTTP_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const headers = requestHeaders(input.apiKey);

  try {
    const response = await input.policyFetch(input.endpoint, {
      signal,
      ...(headers ? { headers } : {}),
    });
    throwIfAborted(input.signal);
    if (!response.ok) return { kind: 'http', status: response.status };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'invalid' };
    }
    throwIfAborted(input.signal);
    if (typeof body !== 'object' || body === null) return { kind: 'invalid' };
    const models = input.extract(body);
    return models === null ? { kind: 'invalid' } : { kind: 'success', models };
  } catch (cause) {
    throwIfAborted(input.signal);
    return {
      kind: 'failed',
      diagnostic: sanitizeProviderDiagnostic(cause, {
        credentialValues: input.apiKey.length > 0 ? [input.apiKey] : undefined,
        headers,
      }),
    };
  }
}

function isExplicitlyUnsupported<T>(result: LmStudioListResult<T>): boolean {
  return result.kind === 'http' && NATIVE_UNSUPPORTED_STATUSES.has(result.status);
}

export function createLmStudioProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const connection = createMetadataProvider(
    {
      name: 'lm-studio',
      defaultBaseURL: getKnownProviderBaseURL('lm-studio'),
      envKeyName: '',
      isLocal: true,
      schema: z.object({ id: z.string() }),
      fallback: (id) => ({ id }),
      authentication: 'optional',
      rejectRedirects: true,
    },
    overrides,
  );
  let lastError: string | undefined;

  async function listInventory(
    options?: ProviderModelListOptions,
  ): Promise<readonly DetectedModel[]> {
    const apiKey = connection.apiKey();
    const native = await fetchInventory({
      endpoint: nativeInventoryUrl(connection.baseURL),
      policyFetch: connection[endpointPolicyFetch],
      apiKey,
      signal: options?.signal,
      extract: nativeModelsFromPayload,
    });
    if (native.kind === 'success') {
      lastError = undefined;
      return native.models
        .filter((model) => model.type.toLowerCase() === 'llm')
        .map(nativeModelToDetected);
    }
    if (!isExplicitlyUnsupported(native)) {
      lastError = resultDiagnostic(native);
      return [];
    }

    const compatibility = await fetchInventory({
      endpoint: compatibilityInventoryUrl(connection.baseURL),
      policyFetch: connection[endpointPolicyFetch],
      apiKey,
      signal: options?.signal,
      extract: compatibilityModelsFromPayload,
    });
    lastError = resultDiagnostic(compatibility);
    return compatibility.kind === 'success' ? compatibility.models : [];
  }

  return {
    ...connection,
    getLastError: () => lastError,
    async listModels(options?: ProviderModelListOptions): Promise<string[]> {
      const models = await listInventory(options);
      return models.map((model) => model.id);
    },
    async listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]> {
      return [...(await listInventory(options))];
    },
    async detectContextLength(model: string): Promise<number | null> {
      const entry = (await listInventory()).find((candidate) => candidate.id === model);
      return entry?.effectiveContextTokens ?? entry?.maximumContextTokens ?? null;
    },
  };
}
