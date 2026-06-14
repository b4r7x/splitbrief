import OpenAI from 'openai';
import { z } from 'zod';
import type { ProviderDef, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { redactSecrets } from '../../utils/redact.js';
import { validateApiBaseUrl } from '../../core/providers/validate-api-base.js';
import { providerError } from './errors.js';

interface ProviderShell {
  base: { name: string; baseURL: string; isLocal: boolean };
  trackError(message: string | undefined): void;
  getLastError(): string | undefined;
}

export function createProviderShell(base: {
  name: string;
  baseURL: string;
  isLocal: boolean;
}): ProviderShell {
  let lastError: string | undefined;
  return {
    base,
    trackError(message: string | undefined) {
      lastError = message;
    },
    getLastError() {
      return lastError;
    },
  };
}

export function describeProviderUnavailability(state: {
  isLocal: boolean;
  hasKey: boolean;
  lastError: string | undefined;
}): string {
  if (!state.isLocal && !state.hasKey) return 'no API key is configured';
  if (state.lastError) return state.lastError;
  return state.isLocal ? 'the endpoint is unreachable' : 'no models were returned';
}

const OpenAIModelItemSchema = z.looseObject({
  id: z.string(),
});

const OpenAIModelListSchema = z.object({
  data: z.array(OpenAIModelItemSchema),
});

function extractOpenAIModelList<T>(
  data: unknown,
  mapper: (model: z.infer<typeof OpenAIModelListSchema>['data'][number]) => T,
): T[] {
  const result = OpenAIModelListSchema.safeParse(data);
  if (!result.success) return [];
  return result.data.data.map(mapper);
}

function isOpenAIModelList(data: unknown): boolean {
  return OpenAIModelListSchema.safeParse(data).success;
}

export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw providerError.httpFailure(res.status, redactSecrets(url));
  return await res.json();
}

export function validateProviderBaseURL(baseURL: string): string {
  try {
    return validateApiBaseUrl(baseURL);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.replace(/^Invalid apiBase [^:]+: /, '') : String(err);
    throw providerError.invalidApiBase(baseURL, reason);
  }
}

export function createClientFromProvider(provider: ProviderDef): OpenAI {
  return new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey() });
}

const API_KEY_ENV_PREFIX = 'env:';

export function apiKeyEnvReference(apiKey: string | undefined): string | undefined {
  if (!apiKey?.startsWith(API_KEY_ENV_PREFIX)) return undefined;
  const envVar = apiKey.slice(API_KEY_ENV_PREFIX.length).trim();
  if (!envVar) throw providerError.invalidApiKeyEnvReference();
  return envVar;
}

export function resolveApiKeyOverride(apiKey: string | undefined): string | undefined {
  const envVar = apiKeyEnvReference(apiKey);
  if (!envVar) return apiKey;
  const value = process.env[envVar];
  if (!value) throw providerError.apiKeyEnvMissing(envVar);
  return value;
}

const MODEL_LIST_TIMEOUT_MS = 5_000;

export async function fetchModelList<T>(options: {
  endpoint: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  onError?: ((err: string | undefined) => void) | undefined;
  extractModels: (data: unknown) => T[] | null;
}): Promise<T[]> {
  const { endpoint, apiKey, onError, extractModels } = options;
  try {
    const headers = options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const res = await fetch(endpoint, headers ? { headers, signal } : { signal });
    if (!res.ok) {
      onError?.(`HTTP ${res.status}`);
      return [];
    }
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null) {
      onError?.('Invalid response payload');
      return [];
    }
    const result = extractModels(json);
    if (result === null) {
      onError?.('Invalid response payload');
      return [];
    }
    onError?.(undefined);
    return result;
  } catch (err) {
    onError?.(toErrorMessage(err));
    const isNetworkError = err instanceof TypeError || (err instanceof Error && 'code' in err);
    if (!isNetworkError) {
      warnError(`fetchModelList(${endpoint})`, err);
    }
    return [];
  }
}

export interface MetadataProviderOpts<TRaw extends { id: string }> {
  name: string;
  defaultBaseURL: string;
  envKeyName: string;
  apiKeyDefault?: string;
  isLocal: boolean;
  schema: z.ZodType<TRaw>;
  fallback: (id: string) => TRaw;
  toDetected?: (raw: TRaw) => DetectedModel;
  contextLength?: (raw: TRaw) => number | null;
  modelsUrl?: (baseURL: string) => string;
  headers?: (apiKey: string) => Record<string, string>;
  extractModels?: (data: unknown) => TRaw[] | null;
}

export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw>,
  overrides?: ProviderOverrides,
): ProviderDefWithMetadata {
  const baseURL = validateProviderBaseURL(overrides?.apiBase ?? opts.defaultBaseURL);
  const resolvedApiKey = resolveApiKeyOverride(overrides?.apiKey);
  const shell = createProviderShell({ name: opts.name, baseURL, isLocal: opts.isLocal });
  const apiKey = (): string =>
    resolvedApiKey ?? process.env[opts.envKeyName] ?? opts.apiKeyDefault ?? '';

  function getUrl(): string {
    return opts.modelsUrl ? opts.modelsUrl(baseURL) : `${baseURL}/models`;
  }

  function defaultExtractModels(data: unknown): TRaw[] | null {
    if (!isOpenAIModelList(data)) return null;
    return extractOpenAIModelList(data, (m) => {
      const parsed = opts.schema.safeParse(m);
      return parsed.success ? parsed.data : opts.fallback(m.id);
    });
  }

  const extractModels = opts.extractModels ?? defaultExtractModels;

  async function fetchModels(): Promise<TRaw[]> {
    const key = apiKey();
    if (!opts.isLocal && !key) return [];
    const headers = opts.headers ? opts.headers(key) : undefined;
    return fetchModelList({
      endpoint: getUrl(),
      ...(headers ? { headers } : { apiKey: !opts.isLocal && key ? key : undefined }),
      onError: shell.trackError,
      extractModels,
    });
  }

  const toDetected = opts.toDetected ?? ((m: TRaw) => ({ id: m.id }));
  const getContextLength = opts.contextLength ?? (() => null);

  return {
    name: opts.name,
    baseURL,
    apiKey,
    isLocal: opts.isLocal,
    getLastError: shell.getLastError,

    async listModels(): Promise<string[]> {
      const models = await fetchModels();
      return models.map((m) => m.id);
    },

    async listModelsWithMetadata(): Promise<DetectedModel[]> {
      const models = await fetchModels();
      return models.map(toDetected);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry ? getContextLength(entry) : null;
      } catch (error) {
        warnError(`detectContextLength(${opts.name})`, error);
        return null;
      }
    },
  };
}
