import OpenAI from 'openai';
import { z } from 'zod';
import type { DetectedModel, ProviderDef, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { warnError } from '../../utils/warn.js';

const OpenAIModelListSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string() })),
});

export function extractOpenAIModelList<T>(
  data: unknown,
  mapper: (model: z.infer<typeof OpenAIModelListSchema>['data'][number]) => T,
): T[] {
  const result = OpenAIModelListSchema.safeParse(data);
  if (!result.success) return [];
  return result.data.data.map(mapper);
}

export function createClientFromProvider(provider: ProviderDef): OpenAI {
  return new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey() });
}

export function stripV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

export async function fetchModelList<T = string>(
  url: string,
  extractModels: (data: unknown) => T[],
  headers?: Record<string, string>,
): Promise<T[]> {
  try {
    const opts = headers ? { headers } : undefined;
    const res = opts ? await fetch(url, opts) : await fetch(url);
    if (!res.ok) return [];
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null) return [];
    return extractModels(json);
  } catch (err) {
    const isNetworkError = err instanceof TypeError || (err instanceof Error && 'code' in err);
    if (!isNetworkError) {
      warnError(`fetchModelList(${url})`, err);
    }
    return [];
  }
}

export const DEFAULT_MODEL_FALLBACK = (id: string): { id: string } => ({ id });

export interface MetadataProviderOpts<TRaw extends { id: string }> {
  name: string;
  defaultBaseURL: string;
  envKeyName: string;
  apiKeyDefault?: string;
  isLocal: boolean;
  schema: z.ZodType<TRaw>;
  fallback: (id: string) => TRaw;
  toDetected?: (raw: TRaw) => DetectedModel;
  contextLength: (raw: TRaw) => number | null;
  modelsUrl?: (baseURL: string) => string;
}

export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw> & { toDetected: (raw: TRaw) => DetectedModel },
  overrides?: ProviderOverrides,
): ProviderDefWithMetadata;
export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw>,
  overrides?: ProviderOverrides,
): ProviderDef;
export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw>,
  overrides?: ProviderOverrides,
): ProviderDef {
  const baseURL = overrides?.apiBase ?? opts.defaultBaseURL;
  const apiKey = (): string =>
    overrides?.apiKey ?? process.env[opts.envKeyName] ?? opts.apiKeyDefault ?? '';

  function getUrl(): string {
    return opts.modelsUrl ? opts.modelsUrl(baseURL) : `${baseURL}/models`;
  }

  function extractModels(data: unknown): TRaw[] {
    return extractOpenAIModelList(data, (m) => {
      const parsed = opts.schema.safeParse(m);
      return parsed.success ? parsed.data : opts.fallback(m.id);
    });
  }

  async function fetchModels(): Promise<TRaw[]> {
    const key = apiKey();
    if (!opts.isLocal && !key) return [];
    const headers: Record<string, string> | undefined =
      !opts.isLocal && key ? { Authorization: `Bearer ${key}` } : undefined;
    return fetchModelList(getUrl(), extractModels, headers);
  }

  const provider: ProviderDef = {
    name: opts.name,
    baseURL,
    apiKey,
    isLocal: opts.isLocal,

    async listModels(): Promise<string[]> {
      const models = await fetchModels();
      return models.map((m) => m.id);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry ? opts.contextLength(entry) : null;
      } catch {
        return null;
      }
    },
  };

  if (opts.toDetected) {
    const toDetected = opts.toDetected;
    provider.listModelsWithMetadata = async (): Promise<DetectedModel[]> => {
      const models = await fetchModels();
      return models.map(toDetected);
    };
  }

  return provider;
}
