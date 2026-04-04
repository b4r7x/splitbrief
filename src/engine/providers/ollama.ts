import type { ProviderDef, ProviderOverrides } from './types.js';

const DEFAULT_BASE = 'http://localhost:11434/v1';

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface OllamaShowResponse {
  parameters?: string;
}

function nativeBase(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, '');
}

export function createOllamaProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || 'ollama';

  return {
    name: 'ollama',
    baseURL,
    apiKey,
    isLocal: true,

    async listModels(): Promise<string[]> {
      const res = await fetch(`${nativeBase(baseURL)}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as OllamaTagsResponse;
      return (data.models ?? []).map((m) => m.name);
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
        const res = await fetch(`${nativeBase(baseURL)}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as OllamaShowResponse;
        const params = data.parameters ?? '';
        const match = params.match(/num_ctx\s+(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      } catch {
        return null;
      }
    },
  };
}
