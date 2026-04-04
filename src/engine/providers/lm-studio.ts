import type { ProviderDef, ProviderOverrides } from './types.js';

const DEFAULT_BASE = 'http://localhost:1234/v1';

interface LmStudioModel {
  id: string;
  max_context_length?: number;
}

interface LmStudioModelsResponse {
  data?: LmStudioModel[];
}

export function createLmStudioProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || 'lm-studio';

  async function fetchModels(): Promise<LmStudioModel[]> {
    const res = await fetch(`${baseURL}/models`);
    if (!res.ok) return [];
    const data = (await res.json()) as LmStudioModelsResponse;
    return data.data ?? [];
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

    async isAvailable(): Promise<boolean> {
      try {
        const models = await this.listModels();
        return models.length > 0;
      } catch {
        return false;
      }
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry?.max_context_length ?? null;
      } catch {
        return null;
      }
    },
  };
}
