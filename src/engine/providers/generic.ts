import { createOpenAICompatProvider } from './openai-compat.js';
import type { ProviderDef } from './types.js';

export function createGenericProvider(name: string, baseURL: string, apiKey?: string): ProviderDef {
  const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  return createOpenAICompatProvider(name, baseURL, envKey, false, apiKey ? { apiKey } : undefined);
}
