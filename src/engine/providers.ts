import OpenAI from 'openai';
import type { Config } from '../types.js';

export const DEFAULT_BASES: Record<string, { baseURL: string; apiKey: () => string }> = {
  ollama: { baseURL: 'http://localhost:11434/v1', apiKey: () => 'ollama' },
  'lm-studio': { baseURL: 'http://localhost:1234/v1', apiKey: () => 'lm-studio' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', apiKey: () => process.env.DEEPSEEK_API_KEY ?? '' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKey: () => process.env.OPENROUTER_API_KEY ?? '' },
};

export function createClient(config: Config): OpenAI {
  const defaults = DEFAULT_BASES[config.implementer.provider];

  if (defaults) {
    const baseURL = config.implementer.apiBase || defaults.baseURL;
    const apiKey = config.implementer.apiKey || defaults.apiKey();
    return new OpenAI({ baseURL, apiKey });
  }

  const providerUpper = config.implementer.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envKey = process.env[`${providerUpper}_API_KEY`];
  const apiKey = config.implementer.apiKey || envKey || '';
  return new OpenAI({ baseURL: config.implementer.apiBase, apiKey });
}

interface OllamaShowResponse {
  parameters?: string;
}

interface LmStudioModel {
  id: string;
  max_context_length?: number;
}

interface LmStudioModelsResponse {
  data?: LmStudioModel[];
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const { provider, model } = config.implementer;
  const envCtx = process.env.OLLAMA_CONTEXT_LENGTH;
  const fallback = { contextLength: envCtx ? parseInt(envCtx, 10) : config.implementer.contextLength };

  try {
    if (provider === 'ollama') {
      const base = (config.implementer.apiBase || DEFAULT_BASES.ollama.baseURL).replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) return fallback;
      const data = await res.json() as OllamaShowResponse;
      const params = data.parameters ?? '';
      const match = params.match(/num_ctx\s+(\d+)/);
      if (match) return { contextLength: parseInt(match[1], 10) };
    }

    if (provider === 'lm-studio') {
      const base = config.implementer.apiBase || DEFAULT_BASES['lm-studio'].baseURL;
      const res = await fetch(`${base}/models`);
      if (!res.ok) return fallback;
      const data = await res.json() as LmStudioModelsResponse;
      const entry = (data.data ?? []).find((m) => m.id === model);
      if (entry?.max_context_length) return { contextLength: entry.max_context_length };
    }
  } catch {}

  return fallback;
}
