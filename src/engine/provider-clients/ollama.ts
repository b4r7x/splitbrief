import { z } from 'zod';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { fetchModelList, stripV1Suffix } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.ollama;

const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() }).passthrough()),
});

const OllamaShowSchema = z.object({
  parameters: z.string().optional(),
}).passthrough();

function extractOllamaModels(data: unknown): string[] {
  const result = OllamaTagsSchema.safeParse(data);
  if (!result.success) return [];
  return result.data.models.map((m) => m.name);
}

export function createOllamaProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || 'ollama';

  return {
    name: 'ollama',
    baseURL,
    apiKey,
    isLocal: true,

    listModels: () => fetchModelList(`${stripV1Suffix(baseURL)}/api/tags`, extractOllamaModels),

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const res = await fetch(`${stripV1Suffix(baseURL)}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
        });
        if (!res.ok) return null;
        const json: unknown = await res.json();
        const result = OllamaShowSchema.safeParse(json);
        if (!result.success) return null;
        const params = result.data.parameters ?? '';
        const match = params.match(/num_ctx\s+(\d+)/);
        return match?.[1] ? parseInt(match[1], 10) : null;
      } catch { /* Ollama API unreachable — fall back to config */
        return null;
      }
    },
  };
}
