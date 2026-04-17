import OpenAI from 'openai';
import { z } from 'zod';
import type { DetectedModel, ProviderDef, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';

interface ProviderShell {
  base: { name: string; baseURL: string; isLocal: boolean };
  trackError(message: string | undefined): void;
  getLastError(): string | undefined;
}

export function createProviderShell(base: { name: string; baseURL: string; isLocal: boolean }): ProviderShell {
  let lastError: string | undefined;
  return {
    base,
    trackError(message: string | undefined) { lastError = message; },
    getLastError() { return lastError; },
  };
}

const OpenAIModelItemSchema = z.object({
  id: z.string(),
}).passthrough();

const OpenAIModelListSchema = z.object({
  data: z.array(OpenAIModelItemSchema),
});

export function extractOpenAIModelList<T>(
  data: unknown,
  mapper: (model: z.infer<typeof OpenAIModelListSchema>['data'][number]) => T,
): T[] {
  const result = OpenAIModelListSchema.safeParse(data);
  if (!result.success) return [];
  return result.data.data.map(mapper);
}

export function isOpenAIModelList(data: unknown): boolean {
  return OpenAIModelListSchema.safeParse(data).success;
}

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createClientFromProvider(provider: ProviderDef): OpenAI {
  return new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey() });
}

export async function fetchModelList<T>(options: {
  endpoint: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  onError?: ((err: string | undefined) => void) | undefined;
  extractModels: (data: unknown) => T[] | null;
}): Promise<T[]> {
  const { endpoint, apiKey, onError, extractModels } = options;
  try {
    const headers: Record<string, string> | undefined =
      options.headers ?? (apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined);
    const opts = headers ? { headers } : undefined;
    const res = opts ? await fetch(endpoint, opts) : await fetch(endpoint);
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
  /**
   * Per-request header factory. When provided, the returned headers replace the
   * default bearer auth. Use for providers with non-bearer auth (e.g. Anthropic x-api-key).
   */
  headers?: (apiKey: string) => Record<string, string>;
  /** Custom extractor for providers whose list shape is not OpenAI's `data: [...]`. */
  extractModels?: (data: unknown) => TRaw[] | null;
}

export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw>,
  overrides?: ProviderOverrides,
): ProviderDefWithMetadata {
  const baseURL = overrides?.apiBase ?? opts.defaultBaseURL;
  const shell = createProviderShell({ name: opts.name, baseURL, isLocal: opts.isLocal });
  const apiKey = (): string =>
    overrides?.apiKey ?? process.env[opts.envKeyName] ?? opts.apiKeyDefault ?? '';

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
