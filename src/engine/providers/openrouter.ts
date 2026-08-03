import { z } from 'zod';
import { endpointPolicyFetch } from '../../core/providers/endpoint-policy.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { throwIfAborted } from '../../utils/abort.js';
import { isRecord } from '../../utils/type-guards.js';
import { createMetadataProvider } from './client/metadata.js';
import { sanitizeProviderDiagnostic } from './client/request.js';
import { stripV1Suffix } from './constants.js';
import { perTokenToPerMillion, pricingFieldsFromResolved } from './metadata.js';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from './types.js';

const DEFAULT_BASE = getKnownProviderBaseURL('openrouter');
const MODEL_LIST_TIMEOUT_MS = 5_000;

const PriceSchema = z.union([z.string(), z.number()]);
const StringArrayOrStringSchema = z.union([z.array(z.string()), z.string()]);

const OpenRouterModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  created: z.union([z.string(), z.number().finite()]).optional(),
  context_length: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  pricing: z
    .looseObject({
      prompt: PriceSchema.optional(),
      completion: PriceSchema.optional(),
      input_cache_read: PriceSchema.optional(),
      input_cache_write: PriceSchema.optional(),
    })
    .optional(),
  architecture: z
    .looseObject({
      modality: z
        .looseObject({
          input: StringArrayOrStringSchema.optional(),
          output: StringArrayOrStringSchema.optional(),
        })
        .optional(),
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  top_provider: z
    .looseObject({
      context_length: z.number().int().positive().optional(),
      max_completion_tokens: z.number().int().positive().optional(),
    })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});

const OpenRouterModelListSchema = z.looseObject({
  data: z.array(OpenRouterModelSchema),
});

type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

function toStringArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function supportedParameter(
  parameters: readonly string[] | undefined,
  names: readonly string[],
): boolean | undefined {
  if (parameters === undefined) return undefined;
  return parameters.some((parameter) => {
    const normalized = parameter.toLowerCase();
    return names.some((name) => normalized === name || normalized.includes(name));
  });
}

function releaseDate(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number') return undefined;
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function parsePrice(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (text === '') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? perTokenToPerMillion(parsed) : undefined;
}

export function toDetectedModel(model: OpenRouterModel): DetectedModel {
  const inputPrice = parsePrice(model.pricing?.prompt);
  const outputPrice = parsePrice(model.pricing?.completion);
  const hasCompletePricing = inputPrice !== undefined && outputPrice !== undefined;
  const isFree =
    model.id.endsWith(':free') ||
    (hasCompletePricing ? inputPrice === 0 && outputPrice === 0 : undefined);
  const inputModalities =
    model.architecture?.input_modalities ?? toStringArray(model.architecture?.modality?.input);
  const outputModalities =
    model.architecture?.output_modalities ?? toStringArray(model.architecture?.modality?.output);
  const supportsImages = inputModalities?.includes('image');
  const supportsToolCalls = supportedParameter(model.supported_parameters, ['tools', 'tool_use']);
  const supportsStructuredOutput = supportedParameter(model.supported_parameters, [
    'response_format',
    'structured_output',
    'json_schema',
  ]);
  const supportsReasoning = supportedParameter(model.supported_parameters, ['reasoning']);
  const maximumContextTokens = model.context_length ?? model.top_provider?.context_length;
  const maximumOutputTokens =
    model.max_completion_tokens ?? model.top_provider?.max_completion_tokens;
  const capabilities: string[] = [];
  if (supportsImages === true) capabilities.push('vision');
  if (supportsToolCalls === true) capabilities.push('tools');
  if (supportsStructuredOutput === true) capabilities.push('structured-output');
  if (supportsReasoning === true) capabilities.push('reasoning');

  const result: DetectedModel = {
    id: model.id,
    ...pricingFieldsFromResolved(inputPrice, outputPrice, isFree),
  };

  const cacheReadPrice = parsePrice(model.pricing?.input_cache_read);
  if (cacheReadPrice !== undefined) result.pricingCacheRead = cacheReadPrice;
  const cacheWritePrice = parsePrice(model.pricing?.input_cache_write);
  if (cacheWritePrice !== undefined) result.pricingCacheWrite = cacheWritePrice;
  if (model.name !== undefined) result.displayName = model.name;
  if (maximumContextTokens !== undefined) {
    result.contextLength = maximumContextTokens;
    result.maximumContextTokens = maximumContextTokens;
  }
  if (maximumOutputTokens !== undefined) {
    result.maxOutputTokens = maximumOutputTokens;
    result.maximumOutputTokens = maximumOutputTokens;
  }
  if (inputModalities !== undefined) result.inputModalities = inputModalities;
  if (outputModalities !== undefined) result.outputModalities = outputModalities;
  if (supportsImages !== undefined) result.supportsImages = supportsImages;
  if (supportsToolCalls !== undefined) result.supportsToolCalls = supportsToolCalls;
  if (supportsStructuredOutput !== undefined)
    result.supportsStructuredOutput = supportsStructuredOutput;
  if (supportsReasoning !== undefined) result.supportsReasoning = supportsReasoning;
  if (capabilities.length > 0) result.capabilities = capabilities;
  const created = releaseDate(model.created);
  if (created !== undefined) result.releaseDate = created;

  return result;
}

function openRouterBaseUrl(baseURL: string): string {
  return stripV1Suffix(baseURL).replace(/\/api\/?$/, '');
}

function openRouterModelsUrl(baseURL: string): string {
  return `${openRouterBaseUrl(baseURL)}/api/v1/models`;
}

function openRouterUserModelsUrl(baseURL: string): string {
  return `${openRouterModelsUrl(baseURL)}/user`;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function errorTokens(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(errorTokens);
  if (!isRecord(value)) return [];

  const tokens: string[] = [];
  for (const key of ['code', 'type', 'message', 'reason', 'reasons', 'error']) {
    tokens.push(...errorTokens(value[key]));
  }
  return tokens;
}

function accountErrorDiagnostic(status: number, payload: unknown): string {
  const tokens = errorTokens(payload).join(' ').toLowerCase();
  if (tokens.includes('guardrail')) return 'catalog-guardrail-filtered';
  if (/(privacy|data[-_ ]?collection|data[-_ ]?policy|zero[-_ ]?retention)/.test(tokens)) {
    return 'catalog-privacy-filtered';
  }
  if (
    status === 403 ||
    /(policy|organization|organisation|project|region|routing|blocked)/.test(tokens)
  ) {
    return 'catalog-policy-denied';
  }
  if (status === 401) return 'catalog-authentication-rejected';
  return `HTTP ${status}`;
}

type ModelListResult =
  | Readonly<{ kind: 'success'; models: readonly OpenRouterModel[] }>
  | Readonly<{ kind: 'failure'; diagnostic: string }>;

export function createOpenRouterProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const baseProvider = createMetadataProvider<OpenRouterModel>(
    {
      name: 'openrouter',
      defaultBaseURL: DEFAULT_BASE,
      envKeyName: 'OPENROUTER_API_KEY',
      isLocal: false,
      schema: OpenRouterModelSchema,
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (model) => model.context_length ?? model.top_provider?.context_length ?? null,
      modelsUrl: openRouterUserModelsUrl,
    },
    overrides,
  );
  let lastError: string | undefined;

  async function requestList(
    url: string,
    options: Readonly<{
      apiKey?: string | undefined;
      signal?: AbortSignal | undefined;
      accountMembership: boolean;
    }>,
  ): Promise<ModelListResult> {
    const headers =
      options.apiKey === undefined ? undefined : { Authorization: `Bearer ${options.apiKey}` };
    try {
      const response = await baseProvider[endpointPolicyFetch](url, {
        ...(headers === undefined ? {} : { headers }),
        signal: requestSignal(options.signal),
      });
      throwIfAborted(options.signal);
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        throwIfAborted(options.signal);
        return {
          kind: 'failure',
          diagnostic: options.accountMembership
            ? accountErrorDiagnostic(response.status, payload)
            : `HTTP ${response.status}`,
        };
      }

      const payload: unknown = await response.json();
      throwIfAborted(options.signal);
      const parsed = OpenRouterModelListSchema.safeParse(payload);
      if (!parsed.success) return { kind: 'failure', diagnostic: 'Invalid response payload' };
      return { kind: 'success', models: parsed.data.data };
    } catch (cause) {
      throwIfAborted(options.signal);
      return {
        kind: 'failure',
        diagnostic: sanitizeProviderDiagnostic(cause, {
          credentialValues: options.apiKey === undefined ? undefined : [options.apiKey],
          headers,
        }),
      };
    }
  }

  async function accountModels(
    options: ProviderModelListOptions | undefined,
  ): Promise<readonly OpenRouterModel[] | null> {
    throwIfAborted(options?.signal);
    const apiKey = baseProvider.apiKey();
    if (apiKey.length === 0) {
      lastError = undefined;
      return [];
    }

    const result = await requestList(openRouterUserModelsUrl(baseProvider.baseURL), {
      apiKey,
      signal: options?.signal,
      accountMembership: true,
    });
    if (result.kind === 'failure') {
      lastError = result.diagnostic;
      return null;
    }
    lastError = undefined;
    return result.models;
  }

  async function modelsWithMetadata(
    options: ProviderModelListOptions | undefined,
  ): Promise<DetectedModel[]> {
    const account = await accountModels(options);
    if (account === null || account.length === 0) return [];

    const global = await requestList(openRouterModelsUrl(baseProvider.baseURL), {
      signal: options?.signal,
      accountMembership: false,
    });
    if (global.kind === 'failure') {
      lastError = `global-catalog-unavailable: ${global.diagnostic}`;
      return account.map(toDetectedModel);
    }

    const globalById = new Map(global.models.map((model) => [model.id, toDetectedModel(model)]));
    lastError = undefined;
    return account.map((model) => ({
      ...(globalById.get(model.id) ?? {}),
      ...toDetectedModel(model),
    }));
  }

  return {
    ...baseProvider,
    getLastError: () => lastError,
    async listModels(options?: ProviderModelListOptions): Promise<string[]> {
      const models = await accountModels(options);
      return models?.map((model) => model.id) ?? [];
    },
    listModelsWithMetadata: modelsWithMetadata,
    async detectContextLength(model: string): Promise<number | null> {
      const models = await accountModels(undefined);
      const entry = models?.find((candidate) => candidate.id === model);
      return entry?.context_length ?? entry?.top_provider?.context_length ?? null;
    },
  };
}
