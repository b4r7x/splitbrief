import { createOpenAICompatProvider } from './openai-compat.js';
import type { ProviderDef, ProviderOverrides } from './types.js';

export function createOpenRouterProvider(overrides?: ProviderOverrides): ProviderDef {
  return createOpenAICompatProvider('openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', false, overrides);
}
