import OpenAI from 'openai';
import type { Config } from '../types.js';

const DEFAULT_BASES: Record<string, { baseURL: string; apiKey: string | (() => string) }> = {
  ollama: { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' },
  'lm-studio': { baseURL: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', apiKey: () => process.env.DEEPSEEK_API_KEY ?? '' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKey: () => process.env.OPENROUTER_API_KEY ?? '' },
};

export function createClient(config: Config): OpenAI {
  const defaults = DEFAULT_BASES[config.implementer.provider];

  if (defaults) {
    const baseURL = config.implementer.apiBase || defaults.baseURL;
    const apiKey = config.implementer.apiKey || (typeof defaults.apiKey === 'function' ? defaults.apiKey() : defaults.apiKey);
    return new OpenAI({ baseURL, apiKey });
  }

  const providerUpper = config.implementer.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envKey = process.env[`${providerUpper}_API_KEY`];
  const apiKey = config.implementer.apiKey || envKey || 'no-key';
  return new OpenAI({ baseURL: config.implementer.apiBase, apiKey });
}

export async function detectLocalModels(): Promise<Array<{ provider: string; models: string[] }>> {
  const results: Array<{ provider: string; models: string[] }> = [];

  const checks = [
    {
      provider: 'ollama',
      url: 'http://localhost:11434/api/tags',
      parse: (data: any) => (data.models ?? []).map((m: any) => m.name as string),
    },
    {
      provider: 'lm-studio',
      url: 'http://localhost:1234/v1/models',
      parse: (data: any) => (data.data ?? []).map((m: any) => m.id as string),
    },
  ];

  await Promise.all(
    checks.map(async ({ provider, url, parse }) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const models = parse(data);
        if (models.length > 0) results.push({ provider, models });
      } catch {
        // provider not running
      }
    }),
  );

  return results;
}

export function validateProviderCredentials(config: Config): string[] {
  const warnings: string[] = [];
  const { provider } = config.implementer;

  if (provider === 'deepseek' && !config.implementer.apiKey && !process.env.DEEPSEEK_API_KEY) {
    warnings.push('DEEPSEEK_API_KEY environment variable is not set. DeepSeek API calls will fail.');
  }
  if (provider === 'openrouter' && !config.implementer.apiKey && !process.env.OPENROUTER_API_KEY) {
    warnings.push('OPENROUTER_API_KEY environment variable is not set. OpenRouter API calls will fail.');
  }

  return warnings;
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const { provider, model } = config.implementer;
  const envCtx = process.env.OLLAMA_CONTEXT_LENGTH;
  const fallback = { contextLength: envCtx ? parseInt(envCtx, 10) : config.implementer.contextLength };

  try {
    if (provider === 'ollama') {
      const base = config.implementer.apiBase || 'http://localhost:11434';
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) return fallback;
      const data: any = await res.json();
      const params = data.parameters ?? '';
      const match = params.match(/num_ctx\s+(\d+)/);
      if (match) return { contextLength: parseInt(match[1], 10) };
    }

    if (provider === 'lm-studio') {
      const base = config.implementer.apiBase || 'http://localhost:1234/v1';
      const res = await fetch(`${base}/models`);
      if (!res.ok) return fallback;
      const data: any = await res.json();
      const entry = (data.data ?? []).find((m: any) => m.id === model);
      if (entry?.max_context_length) return { contextLength: entry.max_context_length };
    }
  } catch {
    // detection failed
  }

  return fallback;
}
