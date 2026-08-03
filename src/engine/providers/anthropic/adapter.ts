import { z } from 'zod';
import { resolveDefaultApiBase } from '../../../core/providers/catalog.js';
import { endpointPolicyFetch } from '../../../core/providers/endpoint-policy.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { isRecord } from '../../../utils/type-guards.js';
import { createMetadataProvider } from '../client/metadata.js';
import { sanitizeProviderDiagnostic } from '../client/request.js';
import { ANTHROPIC_API_VERSION, v1ModelsUrl } from '../constants.js';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from '../types.js';

const DEFAULT_ANTHROPIC_BASE_URL =
  resolveDefaultApiBase('anthropic') ?? 'https://api.anthropic.com/v1';
const MODEL_LIST_TIMEOUT_MS = 5_000;
const MODEL_LIST_LIMIT = 1_000;
const MAX_MODEL_LIST_PAGES = 100;

const AnthropicModelSchema = z.looseObject({
  id: z.string(),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  context_window: z.number().int().positive().optional(),
  max_context_tokens: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  capabilities: z.unknown().optional(),
});

const AnthropicModelListSchema = z.looseObject({
  data: z.array(AnthropicModelSchema),
  has_more: z.boolean().optional(),
  last_id: z.string().optional(),
});

type AnthropicModel = z.infer<typeof AnthropicModelSchema>;
type AnthropicModelList = z.infer<typeof AnthropicModelListSchema>;

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value;
}

function capabilityValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (!isRecord(value)) return undefined;

  for (const key of ['enabled', 'supported', 'available']) {
    if (typeof value[key] === 'boolean') return value[key];
  }
  return undefined;
}

function capabilityBoolean(model: AnthropicModel, names: readonly string[]): boolean | undefined {
  const capabilityRecord = isRecord(model.capabilities) ? model.capabilities : undefined;
  for (const name of names) {
    const fromCapabilities = capabilityValue(capabilityRecord?.[name]);
    if (fromCapabilities !== undefined) return fromCapabilities;

    const fromModel = capabilityValue(model[name]);
    if (fromModel !== undefined) return fromModel;
  }
  return undefined;
}

function capabilityModalities(
  model: AnthropicModel,
  key: 'input_modalities' | 'output_modalities',
): string[] | undefined {
  const direct = strings(model[key]);
  if (direct !== undefined) return direct;
  const capabilities = isRecord(model.capabilities) ? model.capabilities : undefined;
  return strings(capabilities?.[key]);
}

function capabilityNames(model: AnthropicModel): string[] | undefined {
  const capabilities = model.capabilities;
  const values = strings(capabilities);
  if (values !== undefined) return values;
  if (!isRecord(capabilities)) return undefined;

  const enabled = Object.entries(capabilities)
    .filter(([, value]) => capabilityValue(value) === true)
    .map(([name]) => name);
  return enabled.length > 0 ? enabled : undefined;
}

function appendCapability(values: string[], label: string, enabled: boolean | undefined): void {
  if (enabled === true && !values.includes(label)) values.push(label);
}

function toDetected(model: AnthropicModel): DetectedModel {
  const maximumOutputTokens = model.max_output_tokens ?? model.max_tokens;
  const maximumContextTokens = model.max_context_tokens ?? model.context_window;
  const inputModalities = capabilityModalities(model, 'input_modalities');
  const outputModalities = capabilityModalities(model, 'output_modalities');
  const supportsImages =
    capabilityBoolean(model, ['vision', 'images', 'image_input', 'supports_images']) ??
    inputModalities?.includes('image');
  const supportsReasoning = capabilityBoolean(model, [
    'reasoning',
    'thinking',
    'extended_thinking',
    'supports_thinking',
  ]);
  const supportsToolCalls = capabilityBoolean(model, [
    'tools',
    'tool_use',
    'supports_tools',
    'supports_tool_use',
  ]);
  const supportsStructuredOutput = capabilityBoolean(model, [
    'structured_output',
    'structured_outputs',
    'supports_structured_output',
  ]);
  const supportsTemperature = capabilityBoolean(model, ['temperature', 'supports_temperature']);
  const capabilities = [...(capabilityNames(model) ?? [])];
  appendCapability(capabilities, 'vision', supportsImages);
  appendCapability(capabilities, 'reasoning', supportsReasoning);
  appendCapability(capabilities, 'tools', supportsToolCalls);
  appendCapability(capabilities, 'structured-output', supportsStructuredOutput);
  appendCapability(capabilities, 'temperature', supportsTemperature);

  return {
    id: model.id,
    ...(model.display_name !== undefined && { displayName: model.display_name }),
    ...(model.created_at !== undefined && { releaseDate: model.created_at }),
    ...(maximumContextTokens !== undefined && {
      contextLength: maximumContextTokens,
      maximumContextTokens,
    }),
    ...(model.max_input_tokens !== undefined && { maximumInputTokens: model.max_input_tokens }),
    ...(maximumOutputTokens !== undefined && {
      maxOutputTokens: maximumOutputTokens,
      maximumOutputTokens,
    }),
    ...(inputModalities !== undefined && { inputModalities }),
    ...(outputModalities !== undefined && { outputModalities }),
    ...(supportsImages !== undefined && { supportsImages }),
    ...(supportsReasoning !== undefined && { supportsReasoning }),
    ...(supportsToolCalls !== undefined && { supportsToolCalls }),
    ...(supportsStructuredOutput !== undefined && { supportsStructuredOutput }),
    ...(supportsTemperature !== undefined && { supportsTemperature }),
    ...(capabilities.length > 0 && { capabilities }),
  };
}

function listUrl(baseURL: string, afterId: string | undefined): string {
  const url = new URL(v1ModelsUrl(baseURL));
  url.searchParams.set('limit', String(MODEL_LIST_LIMIT));
  if (afterId !== undefined) url.searchParams.set('after_id', afterId);
  return url.toString();
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function modelListHeaders(apiKey: string): Record<string, string> {
  return {
    'anthropic-version': ANTHROPIC_API_VERSION,
    'x-api-key': apiKey,
  };
}

export function createAnthropicProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const baseProvider = createMetadataProvider<AnthropicModel>(
    {
      name: 'anthropic',
      defaultBaseURL: DEFAULT_ANTHROPIC_BASE_URL,
      envKeyName: 'ANTHROPIC_API_KEY',
      isLocal: false,
      schema: AnthropicModelSchema,
      fallback: (id) => ({ id }),
      toDetected,
      modelsUrl: v1ModelsUrl,
      headers: modelListHeaders,
    },
    overrides,
  );
  let lastError: string | undefined;

  async function fetchPage(
    apiKey: string,
    afterId: string | undefined,
    options: ProviderModelListOptions | undefined,
  ): Promise<AnthropicModelList | null> {
    const headers = modelListHeaders(apiKey);
    try {
      const response = await baseProvider[endpointPolicyFetch](
        listUrl(baseProvider.baseURL, afterId),
        {
          headers,
          signal: requestSignal(options?.signal),
        },
      );
      throwIfAborted(options?.signal);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        return null;
      }

      const payload: unknown = await response.json();
      throwIfAborted(options?.signal);
      const parsed = AnthropicModelListSchema.safeParse(payload);
      if (!parsed.success) {
        lastError = 'Invalid response payload';
        return null;
      }
      return parsed.data;
    } catch (cause) {
      throwIfAborted(options?.signal);
      lastError = sanitizeProviderDiagnostic(cause, {
        credentialValues: [apiKey],
        headers,
      });
      return null;
    }
  }

  async function fetchModels(
    options: ProviderModelListOptions | undefined,
  ): Promise<AnthropicModel[]> {
    throwIfAborted(options?.signal);
    const apiKey = baseProvider.apiKey();
    if (apiKey.length === 0) {
      lastError = undefined;
      return [];
    }

    const models = new Map<string, AnthropicModel>();
    const cursors = new Set<string>();
    let afterId: string | undefined;

    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const result = await fetchPage(apiKey, afterId, options);
      if (result === null) return [];

      for (const model of result.data) {
        if (!models.has(model.id)) models.set(model.id, model);
      }

      if (result.has_more !== true) {
        lastError = undefined;
        return [...models.values()];
      }

      const nextCursor = result.last_id ?? result.data.at(-1)?.id;
      if (nextCursor === undefined || cursors.has(nextCursor)) {
        lastError = 'Invalid pagination cursor';
        return [];
      }
      cursors.add(nextCursor);
      afterId = nextCursor;
    }

    lastError = 'Model catalog pagination limit exceeded';
    return [];
  }

  return {
    ...baseProvider,
    getLastError: () => lastError,
    async listModels(options?: ProviderModelListOptions): Promise<string[]> {
      return (await fetchModels(options)).map((model) => model.id);
    },
    async listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]> {
      return (await fetchModels(options)).map(toDetected);
    },
    async detectContextLength(model: string): Promise<number | null> {
      const detected = (await fetchModels(undefined)).find((entry) => entry.id === model);
      return detected?.max_context_tokens ?? detected?.context_window ?? null;
    },
  };
}
