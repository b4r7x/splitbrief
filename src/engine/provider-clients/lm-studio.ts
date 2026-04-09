import { z } from 'zod';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { extractOpenAIModelList, fetchModelList } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS['lm-studio'];

const LmStudioModelSchema = z.object({
  id: z.string(),
  max_context_length: z.number().optional(),
});

type LmStudioModel = z.infer<typeof LmStudioModelSchema>;

function extractLmStudioModels(data: unknown): LmStudioModel[] {
  return extractOpenAIModelList(data, (m) => {
    const parsed = LmStudioModelSchema.safeParse(m);
    if (!parsed.success) return { id: m.id };
    return parsed.data;
  });
}

export function createLmStudioProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || 'lm-studio';

  async function fetchModels(): Promise<LmStudioModel[]> {
    return fetchModelList(`${baseURL}/models`, extractLmStudioModels);
  }

  return {
    name: 'lm-studio',
    baseURL,
    apiKey,
    isLocal: true,

    async listModels(): Promise<string[]> {
      const models = await fetchModels();
      return models.map((m) => m.id);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry?.max_context_length ?? null;
      } catch { /* LM Studio API unreachable — fall back to config */
        return null;
      }
    },
  };
}
