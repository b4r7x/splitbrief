import type { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from '../types.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import { warnError } from '../../../lib/warn.js';
import { createProviderShell } from './shell.js';
import { resolveApiKeyOverride } from './api-key.js';
import { validateProviderBaseURL } from './connection.js';
import { extractOpenAIModelList, fetchModelList, isOpenAIModelList } from './request.js';

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
