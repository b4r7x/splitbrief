import { z } from 'zod';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { extractOpenAIModelList, fetchModelList } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.groq;

const GroqModelSchema = z.object({
  id: z.string(),
  context_window: z.number().optional(),
});

type GroqModel = z.infer<typeof GroqModelSchema>;

function extractGroqModels(data: unknown): GroqModel[] {
  return extractOpenAIModelList(data, (m) => {
    const parsed = GroqModelSchema.safeParse(m);
    if (!parsed.success) return { id: m.id };
    return parsed.data;
  });
}

export interface GroqProviderDef extends ProviderDef {
  listModelsWithMetadata(): Promise<DetectedModel[]>;
  detectContextLength(model: string): Promise<number | null>;
}

export function createGroqProvider(overrides?: ProviderOverrides): GroqProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || process.env.GROQ_API_KEY || '';

  async function fetchModels(): Promise<GroqModel[]> {
    const key = apiKey();
    if (!key) return [];
    return fetchModelList(
      `${baseURL}/models`,
      extractGroqModels,
      { Authorization: `Bearer ${key}` },
    );
  }

  function toDetectedModel(m: GroqModel): DetectedModel {
    const result: DetectedModel = { id: m.id };
    if (m.context_window !== undefined) {
      result.contextLength = m.context_window;
    }
    return result;
  }

  return {
    name: 'groq',
    baseURL,
    apiKey,
    isLocal: false,

    async listModels(): Promise<string[]> {
      const models = await fetchModels();
      return models.map((m) => m.id);
    },

    async listModelsWithMetadata(): Promise<DetectedModel[]> {
      const models = await fetchModels();
      return models.map(toDetectedModel);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry?.context_window ?? null;
      } catch {
        return null;
      }
    },
  };
}
