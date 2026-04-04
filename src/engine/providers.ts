import OpenAI from 'openai';
import type { Config } from '../types.js';
import { getProvider } from './providers/registry.js';

export function createClient(config: Config): OpenAI {
  const provider = getProvider(config.implementer.provider, {
    apiBase: config.implementer.apiBase,
    apiKey: config.implementer.apiKey,
  });
  return new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey() });
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const envCtx = process.env.OLLAMA_CONTEXT_LENGTH;
  const fallback = { contextLength: envCtx ? parseInt(envCtx, 10) : config.implementer.contextLength };

  const provider = getProvider(config.implementer.provider, {
    apiBase: config.implementer.apiBase,
    apiKey: config.implementer.apiKey,
  });

  if (provider.detectContextLength) {
    try {
      const ctx = await provider.detectContextLength(config.implementer.model);
      if (ctx) return { contextLength: ctx };
    } catch {}
  }

  return fallback;
}
