import { createOpenAICompatProvider } from './openai-compat.js';
import type { ProviderDef, ProviderOverrides } from './types.js';

export function createDeepSeekProvider(overrides?: ProviderOverrides): ProviderDef {
  return createOpenAICompatProvider('deepseek', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', false, overrides);
}
