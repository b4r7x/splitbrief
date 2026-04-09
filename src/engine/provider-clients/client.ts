import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from '../../types.js';
import type { ProviderDef } from './types.js';
import { getProvider } from './registry.js';
import { warnError } from '../../utils/format.js';

const OpenAIModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

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

function getImplementerProvider(config: Config): ProviderDef {
  return getProvider(config.implementer.tool, {
    apiBase: config.implementer.apiBase,
    apiKey: config.implementer.apiKey,
  });
}

export function createClient(config: Config): OpenAI {
  return createClientFromProvider(getImplementerProvider(config));
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const envCtx = process.env.TINY_SPEC_CONTEXT_LENGTH;
  const parsed = envCtx ? parseInt(envCtx, 10) : NaN;
  const fallback = { contextLength: Number.isNaN(parsed) ? config.implementer.contextLength : parsed };

  const provider = getImplementerProvider(config);

  if (provider.detectContextLength) {
    try {
      const ctx = await provider.detectContextLength(config.implementer.model);
      if (ctx) return { contextLength: ctx };
    } catch { /* context length detection failed — use config fallback */ }
  }

  return fallback;
}
