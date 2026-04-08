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
        const json: unknown = await res.json();
        if (typeof json !== 'object' || json === null) return [];
        const data = json as ModelsResponse;
        if (data.data !== undefined && !Array.isArray(data.data)) return [];
        return (data.data ?? []).map((m) => m.id);
      } catch {
        return [];
      }
    },
  };
}
