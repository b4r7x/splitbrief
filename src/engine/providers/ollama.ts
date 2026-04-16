import { z } from 'zod';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers.js';
import { warnError } from '../../utils/warn.js';
import { createProviderShell, fetchModelList, stripV1Suffix } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.ollama;

const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

const OllamaShowSchema = z.object({
  parameters: z.string().optional(),
});

function extractOllamaModels(data: unknown): string[] | null {
  const result = OllamaTagsSchema.safeParse(data);
  if (!result.success) return null;
  return result.data.models.map((m) => m.name);
}

export function createOllamaProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase ?? DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey ?? 'ollama';
  const shell = createProviderShell({ name: 'ollama', baseURL, isLocal: true });

  return {
    name: 'ollama',
    baseURL,
    apiKey,
    isLocal: true,
    getLastError: shell.getLastError,

    listModels: () =>
      fetchModelList({
        endpoint: `${stripV1Suffix(baseURL)}/api/tags`,
        onError: shell.trackError,
        extractModels: extractOllamaModels,
      }),

    async detectContextLength(model: string): Promise<number | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${stripV1Suffix(baseURL)}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
          signal: controller.signal,
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
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
