import type { ProviderDef, ProviderOverrides } from './types.js';

interface ModelsResponse {
  data?: { id: string }[];
}

export function createOpenAICompatProvider(
  name: string,
  defaultBaseURL: string,
  envKeyName: string,
  isLocal: boolean,
  overrides?: ProviderOverrides,
): ProviderDef {
  const baseURL = overrides?.apiBase || defaultBaseURL;
  const apiKey = () => overrides?.apiKey || process.env[envKeyName] || '';

  return {
    name,
    baseURL,
    apiKey,
    isLocal,

    async listModels(): Promise<string[]> {
      try {
        const headers: Record<string, string> = {};
        const key = apiKey();
        if (key) headers['Authorization'] = `Bearer ${key}`;
        const res = await fetch(`${baseURL.replace(/\/v1\/?$/, '/v1')}/models`, { headers });
        if (!res.ok) return [];
        const data = (await res.json()) as ModelsResponse;
        return (data.data ?? []).map((m) => m.id);
      } catch {
        return [];
      }
    },

    async isAvailable(): Promise<boolean> {
      try {
        const models = await this.listModels();
        return models.length > 0;
      } catch {
        return false;
      }
    },
  };
}
